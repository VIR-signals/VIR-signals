// Regression suite for the notification sequence of the voice pack apply
// flow (applyFlow in src/ui/commands.ts). The contract under test:
// the replacement notice body is the applied stats sentence plus the
// signal switch question and never carries the restart hint sentence;
// whatever happens with the switch question (a button picked or the
// notice dismissed without a pick), the flow closes with its own warning
// notification whose text is exactly the ui.apply.restartHint value, and
// that closing warning is the last notification of the whole flow; when
// the replacement itself fails, only the error notice appears and the
// restart hint warning never does. Information, warning and error
// notices are captured per channel so the closing warning can be told
// apart from the information notices around it. Everything runs
// offline: the vscode module is intercepted at require time, the switch
// question is answered by a scripted pick, and the editor install tree
// plus the voice pack live on a temp directory, the same skeleton
// market.test.ts and market-check.test.ts use.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Module } from 'node:module';
import { SLOTS, fileOwnerSlot, settingKeysForSlots } from '../src/engine/slot-table';
import { freshState, saveState } from '../src/engine/ledger';
import { readPack } from '../src/engine/pack-reader';
import { acquireLock } from '../src/engine/lock';
import { buildInstallTree, buildPack, makeTempRoot, writePackManifest } from './helpers';

const PACK_ID = 'demo-pack';
const PACK_NAME = 'Demo Pack';

// The English bundle read straight from the repository l10n folder: the
// flow under test renders with env.language 'en', so the expected notice
// texts are looked up in the very same file.
const repoL10nDir = path.join(__dirname, '..', '..', 'l10n');
const enBundle = JSON.parse(
  fs.readFileSync(path.join(repoL10nDir, 'bundle.l10n.json'), 'utf8')
) as Record<string, string>;

const localizeModule: typeof import('../src/ui/localize') = require('../src/ui/localize');

function en(key: string, args: ReadonlyArray<string | number> = []): string {
  return localizeModule.lookup(enBundle, key, args);
}

const RESTART_HINT = en('ui.apply.restartHint');
const SWITCH_ALL = en('ui.apply.switchAll');
const SWITCH_PACK = en('ui.apply.switchPack');

interface Notice {
  channel: 'information' | 'warning' | 'error';
  message: string;
  buttons: string[];
}

const uiState = {
  config: {} as Record<string, unknown>,
  appRoot: '',
  notices: [] as Notice[],
  pickFrom: undefined as ((call: Notice) => string | undefined) | undefined,
  handlers: new Map<string, () => unknown>(),
};

function resetUi(): void {
  uiState.config = {};
  uiState.appRoot = '';
  uiState.notices = [];
  uiState.pickFrom = undefined;
}

// One capture funnel for all three notification channels: every call is
// recorded with its channel so the closing warning is distinguishable
// from the information notices around it. The scripted pick answers the
// switch question; with no script the pick is undefined, the same value
// a dismissed notice produces.
function recordNotice(
  channel: Notice['channel'],
  message: string,
  rest: unknown[]
): string | undefined {
  const call: Notice = {
    channel,
    message,
    buttons: rest.filter((a): a is string => typeof a === 'string'),
  };
  uiState.notices.push(call);
  return uiState.pickFrom === undefined ? undefined : uiState.pickFrom(call);
}

const vscodeFake = {
  env: {
    get language(): string {
      return 'en';
    },
    get appRoot(): string {
      return uiState.appRoot;
    },
  },
  workspace: {
    getConfiguration: () => ({
      get: (key: string): unknown => uiState.config[key],
      inspect: (key: string): { globalValue: unknown } => ({
        globalValue: uiState.config[key],
      }),
      update: async (key: string, value: unknown, _target: unknown): Promise<void> => {
        uiState.config[key] = value;
      },
    }),
  },
  ConfigurationTarget: { Global: 1 },
  StatusBarAlignment: { Left: 1, Right: 2 },
  ProgressLocation: { Notification: 15 },
  Uri: { file: (p: string) => ({ fsPath: p }) },
  window: {
    createStatusBarItem: (_alignment: number, _priority: number) => ({
      text: '',
      tooltip: '',
      command: '',
      show(): void {},
      hide(): void {},
      dispose(): void {},
    }),
    showQuickPick: async (): Promise<undefined> => undefined,
    showInputBox: async (): Promise<undefined> => undefined,
    showInformationMessage: async (
      message: string,
      ...rest: unknown[]
    ): Promise<string | undefined> => recordNotice('information', message, rest),
    showWarningMessage: async (
      message: string,
      ...rest: unknown[]
    ): Promise<string | undefined> => recordNotice('warning', message, rest),
    showErrorMessage: async (
      message: string,
      ...rest: unknown[]
    ): Promise<string | undefined> => recordNotice('error', message, rest),
    withProgress: <T,>(_opts: unknown, fn: () => Promise<T>): Promise<T> => fn(),
  },
  commands: {
    registerCommand: (id: string, cb: () => unknown): { dispose(): void } => {
      uiState.handlers.set(id, cb);
      return { dispose(): void {} };
    },
    executeCommand: async (): Promise<undefined> => undefined,
  },
};

type ModuleLoadFn = (request: string, parent: unknown, isMain: boolean) => unknown;
const moduleWithLoad = Module as unknown as { _load: ModuleLoadFn };
const realModuleLoad = moduleWithLoad._load;
moduleWithLoad._load = (request, parent, isMain) => {
  if (request === 'vscode') {
    return vscodeFake;
  }
  return realModuleLoad(request, parent, isMain);
};

// Loaded only after the hook is in place, so the command module and the
// modules it pulls in receive the fake editor API.
const commands: typeof import('../src/ui/commands') = require('../src/ui/commands');

// The test build puts the ui modules under out-test/src/ui, so the bundle
// directory math inside render.ts lands on out-test/l10n, a folder the
// compiler never creates; that one directory is redirected here to the
// real l10n folder so the flow renders the sentences exactly as shipped.
const realLoadBundle = localizeModule.loadBundle;
const buildOnlyDir = path.join(__dirname, '..', 'l10n');
localizeModule.loadBundle = (dir: string, fileName: string) =>
  realLoadBundle(dir === buildOnlyDir ? repoL10nDir : dir, fileName);

// The commands are registered once; the closed over context object is
// re-pointed at each test storage area before the flow runs. The plain
// mutable object is cast at the registration call only, because the
// context type declares its fields read only.
const sharedCtx = { storageDir: '', extensionDir: '', owner: 'win-test' };
let registered = false;

function ensureRegistered(): void {
  if (registered) {
    return;
  }
  const boot = makeTempRoot();
  sharedCtx.storageDir = path.join(boot, 'boot');
  sharedCtx.extensionDir = path.join(boot, 'boot', 'unused-ext');
  commands.registerCommands(sharedCtx as Parameters<typeof commands.registerCommands>[0]);
  fs.rmSync(boot, { recursive: true, force: true });
  registered = true;
}

// One world per test: a fake editor install tree whose media directory
// carries every official file, one local pack covering the error slot,
// and a ledger that selects that pack while the master switch is on.
function seedWorld(root: string): { storage: string; packDir: string; installAppRoot: string } {
  const install = buildInstallTree(root);
  const storage = path.join(root, 'storage');
  const packDir = buildPack(storage, PACK_ID, { error: 'sounds/e.wav' });
  writePackManifest(packDir, {
    schema: 1,
    id: PACK_ID,
    name: PACK_NAME,
    version: '1.0.0',
    author: 'Someone',
    license: 'CC0-1.0',
    sourceLicense: 'original',
    slots: { error: 'sounds/e.wav' },
  });
  const state = freshState();
  state.activePackId = PACK_ID;
  saveState(storage, state);
  return { storage, packDir, installAppRoot: install.appRoot };
}

// The replacement notice body the flow must show: the applied stats
// sentence for this pack against this install, one newline, then the
// signal switch question. The file counts mirror the engine plan for an
// install tree where every official file exists: slots the pack declares
// carry pack audio, every other slot stays official.
function expectedBody(packName: string, declaredSlots: ReadonlySet<string>): string {
  const slotFiles = SLOTS.flatMap((e) => [...e.files]);
  const replaced = slotFiles.filter(
    (f) => declaredSlots.has(fileOwnerSlot(f)?.slot ?? '')
  ).length;
  const baseline = slotFiles.length - replaced;
  return (
    en('ui.apply.done', [packName, replaced, baseline]) +
    '\n' +
    en('ui.apply.switchQuestion')
  );
}

function declaredSlotsOf(packDir: string): Set<string> {
  const rp = readPack(packDir);
  assert.ok(rp.ok, 'the seeded pack did not read back');
  return new Set(Object.values(rp.pack.slots).map((a) => a.slot));
}

async function runApplyFlow(storage: string, installAppRoot: string): Promise<Notice[]> {
  ensureRegistered();
  sharedCtx.storageDir = storage;
  sharedCtx.extensionDir = path.join(storage, 'unused-ext');
  uiState.appRoot = installAppRoot;
  const run = uiState.handlers.get('vir.apply');
  assert.ok(run !== undefined, 'the vir.apply command was not registered');
  await run();
  return [...uiState.notices];
}

function lastNotice(notices: ReadonlyArray<Notice>): Notice {
  assert.ok(notices.length > 0, 'no notification was shown');
  return notices[notices.length - 1];
}

// Case 1: the clean success path with the switch question dismissed.
// The replacement notice is an information notice whose body is exactly
// the stats sentence plus the switch question, carries no restart hint
// sentence anywhere, and the flow still closes on its own warning
// notice whose text is exactly the restart hint value.
test('the clean apply shows a replacement notice without the restart hint and closes on the restart hint warning', async () => {
  const root = makeTempRoot();
  try {
    resetUi();
    const { storage, packDir, installAppRoot } = seedWorld(root);
    const notices = await runApplyFlow(storage, installAppRoot);
    assert.equal(notices.length, 2, 'unexpected notification count');
    const offer = notices[0];
    assert.equal(offer.channel, 'information');
    assert.equal(offer.message, expectedBody(PACK_NAME, declaredSlotsOf(packDir)));
    assert.equal(offer.message.includes(RESTART_HINT), false);
    assert.deepEqual(offer.buttons, [SWITCH_ALL, SWITCH_PACK]);
    const closing = lastNotice(notices);
    assert.equal(closing.channel, 'warning');
    assert.equal(closing.message, RESTART_HINT);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// Case 2: the user picks the enable all button. The switch result
// notice appears (an information notice reporting every signal setting
// enabled), and the restart hint warning still comes after it as the
// last notification of the flow.
test('picking the enable all button shows the switch result notice and still ends on the restart hint warning', async () => {
  const root = makeTempRoot();
  try {
    resetUi();
    const { storage, installAppRoot } = seedWorld(root);
    const allKeys = settingKeysForSlots(SLOTS.map((e) => e.slot));
    uiState.pickFrom = (call) =>
      call.buttons.includes(SWITCH_ALL) ? SWITCH_ALL : undefined;
    const notices = await runApplyFlow(storage, installAppRoot);
    assert.equal(notices.length, 3, 'unexpected notification count');
    assert.equal(notices[0].channel, 'information');
    assert.equal(Object.keys(uiState.config).length, allKeys.length);
    const switchResult = notices[1];
    assert.equal(switchResult.channel, 'information');
    assert.equal(switchResult.message, en('ui.switchMode.doneAll', [allKeys.length]));
    const closing = lastNotice(notices);
    assert.equal(closing.channel, 'warning');
    assert.equal(closing.message, RESTART_HINT);
    assert.ok(
      notices.indexOf(switchResult) < notices.indexOf(closing),
      'the restart hint warning must come after the switch result notice'
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// Case 3: the user dismisses the switch question without picking a
// button. No switch result notice appears at all (the only information
// notice is the replacement notice itself), and the restart hint
// warning still closes the flow as the last notification.
test('dismissing the switch question shows no switch result notice and still ends on the restart hint warning', async () => {
  const root = makeTempRoot();
  try {
    resetUi();
    const { storage, packDir, installAppRoot } = seedWorld(root);
    const notices = await runApplyFlow(storage, installAppRoot);
    const infos = notices.filter((n) => n.channel === 'information');
    assert.equal(infos.length, 1, 'only the replacement notice may appear');
    assert.equal(infos[0].message, expectedBody(PACK_NAME, declaredSlotsOf(packDir)));
    const closing = lastNotice(notices);
    assert.equal(closing.channel, 'warning');
    assert.equal(closing.message, RESTART_HINT);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// Case 4: the replacement itself fails. A foreign window holds the write
// lock, so the engine refuses before touching anything: the flow shows
// exactly one error notice naming the holder and never shows the
// restart hint warning on any channel.
test('a failed replacement shows only the error notice and never the restart hint warning', async () => {
  const root = makeTempRoot();
  try {
    resetUi();
    const { storage, installAppRoot } = seedWorld(root);
    const HOLDER = 'another-window';
    const held = acquireLock(storage, HOLDER);
    assert.ok(held.ok, 'the test could not take the blocking lock');
    const notices = await runApplyFlow(storage, installAppRoot);
    assert.equal(notices.length, 1, 'only the error notice must appear');
    assert.equal(notices[0].channel, 'error');
    assert.ok(
      notices[0].message.includes(HOLDER),
      'the error notice does not name the lock holder'
    );
    for (const n of notices) {
      assert.equal(n.message.includes(RESTART_HINT), false);
    }
    assert.equal(notices.some((n) => n.channel === 'warning'), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
