// Market UI pure computation tests: slot name normalization for the
// coverage line, the demo pack shape (2 slots, 5 events), and bundle
// parity for every market key across both languages.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { slotNamesOfKeys } from '../src/ui/market-format';
import { affectedEventsForSlots, SLOTS } from '../src/engine/slot-table';
import { loadBundle } from '../src/ui/localize';

function bundle(name: string): Record<string, string> {
  return loadBundle(path.join(__dirname, '..', '..', 'l10n'), name);
}

test('numbered responseReceived sub keys fold into the one shared slot', () => {
  assert.deepEqual(slotNamesOfKeys(['error', 'responseReceived1', 'responseReceived2']), ['error', 'responseReceived']);
  assert.deepEqual(slotNamesOfKeys(['save']), ['save']);
});

test('the demo pack shape counts 2 of 28 slots and 5 affected events', () => {
  const slots = slotNamesOfKeys(['error', 'save']);
  assert.equal(slots.length, 2);
  assert.equal(affectedEventsForSlots(slots).length, 5);
  assert.equal(SLOTS.length, 28);
});

test('both language bundles carry the exact same key set', () => {
  const en = bundle('bundle.l10n.json');
  const zh = bundle('bundle.l10n.zh-cn.json');
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort());
});

test('market keys exist with placeholders in both bundles', () => {
  const en = bundle('bundle.l10n.json');
  const zh = bundle('bundle.l10n.zh-cn.json');
  const keys = [
    'ui.market.coverage',
    'ui.market.coverUnknown',
    'ui.market.installDone',
    'ui.market.uptoDate',
    'net.oversize',
    'registry.schema',
    'install.mismatch',
    'install.rollback',
    'direct.inputShape',
  ];
  for (const k of keys) {
    assert.ok(en[k] !== undefined, 'missing en key ' + k);
    assert.ok(zh[k] !== undefined, 'missing zh key ' + k);
  }
  assert.ok(en['ui.market.coverage'].includes('{0}'));
  assert.ok(zh['ui.market.coverage'].includes('{0}'));
});

test('the registry setting defaults exist in the manifest', async () => {
  const manifest = (await import('node:fs')).readFileSync(
    path.join(__dirname, '..', '..', 'package.json'),
    'utf8'
  );
  const parsed = JSON.parse(manifest) as {
    contributes: { configuration: { properties: Record<string, { default?: string }> } };
  };
  const props = parsed.contributes.configuration.properties;
  assert.equal(props['vir.packRegistryRepo'].default, 'VIR-signals/VIR-registry');
  assert.equal(props['vir.packMirrorTemplate'].default, '');
});

// ---------------------------------------------------------------------------
// End to end market panel flows under a fake editor API and a fake network.
// The vscode module is intercepted at require time so the panel module loads
// under plain node, and the production https io is swapped on the net-fetch
// module object because the panel reads that binding at call time. Every
// URL the flows can build is routed to a literal buffer, so the picker, the
// installer and the direct apply all run against real disk and real parsing
// with deterministic inputs.

import * as fs from 'node:fs';
import { Module } from 'node:module';
import { RawIo } from '../src/engine/net-fetch';
import { PackInfo, readPack } from '../src/engine/pack-reader';
import { VirUiContext } from '../src/ui/extension-context';
import { lookup } from '../src/ui/localize';
import { buildFakeWav, makeTempRoot } from './helpers';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const RAW = 'https://raw.githubusercontent.com';
const REGISTRY_URL = RAW + '/vir-test/registry/main/registry.json';
const PACK_BASE = RAW + '/someone/demo-pack/' + SHA + '/pack/';
const BRANCH_API = 'https://api.github.com/repos/someone/demo-pack/commits/main';

function registryBody(version: string): Buffer {
  return Buffer.from(
    JSON.stringify({
      schema: 1,
      packs: [
        {
          id: 'demo-pack',
          names: { en: 'Demo Pack' },
          categories: ['ui'],
          language: 'none',
          author: 'Someone',
          version,
          repo: 'someone/demo-pack',
          branch: 'main',
          commit: SHA,
          packPath: 'pack',
          license: 'CC0-1.0',
          sourceLicense: 'original',
        },
      ],
    })
  );
}

function remoteManifestBody(version: string): Buffer {
  return Buffer.from(
    JSON.stringify({
      schema: 1,
      id: 'demo-pack',
      name: 'Demo Pack',
      version,
      author: 'Someone',
      license: 'CC0-1.0',
      sourceLicense: 'original',
      slots: { error: 'sounds/e.wav', save: 'sounds/s.wav' },
    })
  );
}

function wavBuffer(): Buffer {
  const tmp = makeTempRoot();
  const file = path.join(tmp, 'tone.wav');
  buildFakeWav(file, 0.2);
  const buf = fs.readFileSync(file);
  fs.rmSync(tmp, { recursive: true, force: true });
  return buf;
}

// One buffer or one failure status per exact URL; anything unlisted is a 404.
function marketRoutes(manifestVersion: string): Record<string, Buffer | number> {
  const wav = wavBuffer();
  return {
    [REGISTRY_URL]: registryBody(manifestVersion),
    [PACK_BASE + 'manifest.json']: remoteManifestBody(manifestVersion),
    [PACK_BASE + 'sounds/e.wav']: wav,
    [PACK_BASE + 'sounds/s.wav']: wav,
    [PACK_BASE + 'SOURCE.txt']: Buffer.from('source note'),
    [BRANCH_API]: Buffer.from(JSON.stringify({ sha: SHA })),
  };
}

function routedIo(routes: Record<string, Buffer | number>): RawIo {
  return async (url) => {
    const hit = routes[url];
    if (hit === undefined) {
      return { status: 404, headers: {}, stream: (async function* () {})() };
    }
    if (typeof hit === 'number') {
      return { status: hit, headers: {}, stream: (async function* () {})() };
    }
    return {
      status: 200,
      headers: { 'content-length': String(hit.length) },
      stream: (async function* () {
        yield hit;
      })(),
    };
  };
}

interface FakePickItem {
  label?: string;
  direct?: boolean;
  entry?: unknown;
  [key: string]: unknown;
}

// The picker the panel drives: accept fires the registered accept handlers
// with the given item as the active one, mirroring a user pressing enter.
class FakeQuickPick {
  placeholder = '';
  busy = false;
  items: FakePickItem[] = [];
  activeItems: FakePickItem[] = [];
  private acceptCbs: Array<() => void> = [];
  private hideCbs: Array<() => void> = [];
  show(): void {}
  dispose(): void {}
  onDidAccept(cb: () => void): { dispose(): void } {
    this.acceptCbs.push(cb);
    return { dispose(): void {} };
  }
  onDidHide(cb: () => void): { dispose(): void } {
    this.hideCbs.push(cb);
    return { dispose(): void {} };
  }
  accept(item: FakePickItem): void {
    this.activeItems = [item];
    for (const cb of [...this.acceptCbs]) {
      cb();
    }
  }
}

interface InfoCall {
  message: string;
  buttons: string[];
}

type PanelChoice = { pack: PackInfo } | { none: true };

const uiState = {
  config: { 'vir.packRegistryRepo': 'vir-test/registry', 'vir.packMirrorTemplate': '' } as Record<string, string>,
  qp: new FakeQuickPick(),
  info: [] as InfoCall[],
  error: [] as string[],
  inputAnswer: '',
  actionPick: (items: Array<Record<string, unknown>>) => items.find((i) => i.action === 'install'),
  onInfo: undefined as ((call: InfoCall) => string | undefined) | undefined,
};

function resetUi(): void {
  uiState.qp = new FakeQuickPick();
  uiState.info = [];
  uiState.error = [];
  uiState.inputAnswer = '';
  uiState.onInfo = undefined;
  uiState.actionPick = (items) => items.find((i) => i.action === 'install');
}

const vscodeFake = {
  env: { language: 'en' },
  workspace: {
    getConfiguration: () => ({ get: (key: string) => uiState.config[key] }),
  },
  ProgressLocation: { Notification: 15 },
  Uri: { file: (p: string) => ({ fsPath: p }) },
  window: {
    createQuickPick: () => uiState.qp,
    showQuickPick: async (items: Array<Record<string, unknown>>) => uiState.actionPick(items),
    showInputBox: async () => uiState.inputAnswer,
    showInformationMessage: async (message: string, ...buttons: string[]) => {
      const call = { message, buttons };
      uiState.info.push(call);
      if (uiState.onInfo !== undefined) {
        return uiState.onInfo(call);
      }
      return buttons.length > 0 ? buttons[0] : undefined;
    },
    showErrorMessage: async (message: string) => {
      uiState.error.push(message);
    },
    withProgress: <T>(_opts: unknown, fn: () => Promise<T>) => fn(),
    createWebviewPanel: () => {
      throw new Error('no webview panel in these flows');
    },
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

// Loaded only after the hook is in place, so the panel and the renderer
// receive the fake editor API.
const market: typeof import('../src/ui/market') = require('../src/ui/market');
const netFetch: typeof import('../src/engine/net-fetch') = require('../src/engine/net-fetch');

// The test build puts the ui modules under out-test/src/ui, so the bundle
// directory math inside render.ts lands on out-test/l10n, a folder the
// compiler never creates; that one directory is redirected here to the real
// l10n folder so panel messages come out localized exactly as shipped.
const localizeModule: typeof import('../src/ui/localize') = require('../src/ui/localize');
const realLoadBundle = localizeModule.loadBundle;
const buildOnlyDir = path.join(__dirname, '..', 'l10n');
const repoL10nDir = path.join(__dirname, '..', '..', 'l10n');
localizeModule.loadBundle = (dir, fileName) =>
  realLoadBundle(dir === buildOnlyDir ? repoL10nDir : dir, fileName);

function swapIo(routes: Record<string, Buffer | number>): () => void {
  const previous = netFetch.httpsRawIo;
  netFetch.httpsRawIo = routedIo(routes);
  return () => {
    netFetch.httpsRawIo = previous;
  };
}

function makePanelCtx(storageDir: string): VirUiContext {
  return { storageDir, extensionDir: path.join(storageDir, 'unused-ext'), owner: 'win-test' };
}

function seedLocalPack(storageDir: string, version: string): void {
  const dir = path.join(storageDir, 'packs', 'demo-pack');
  fs.mkdirSync(path.join(dir, 'sounds'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'manifest.json'),
    JSON.stringify({
      schema: 1,
      id: 'demo-pack',
      name: 'Demo Pack',
      version,
      author: 'Someone',
      license: 'CC0-1.0',
      sourceLicense: 'original',
      slots: { error: 'sounds/e.wav' },
    })
  );
  buildFakeWav(path.join(dir, 'sounds', 'e.wav'), 0.2);
}

async function untilItemsSet(): Promise<void> {
  for (let i = 0; i < 200 && uiState.qp.items.length === 0; i += 1) {
    await new Promise<void>((r) => setImmediate(r));
  }
  assert.ok(uiState.qp.items.length > 0, 'picker items never arrived');
}

async function runDirectInstall(storageDir: string): Promise<PanelChoice[]> {
  const choices: PanelChoice[] = [];
  const done = market.marketSelectFlow(makePanelCtx(storageDir), async (c) => {
    choices.push(c);
  });
  await untilItemsSet();
  const direct = uiState.qp.items.find((i) => i.direct === true);
  assert.ok(direct !== undefined, 'direct install item missing');
  uiState.qp.accept(direct);
  await done;
  return choices;
}

async function runEntryInstall(storageDir: string): Promise<PanelChoice[]> {
  const choices: PanelChoice[] = [];
  const done = market.marketSelectFlow(makePanelCtx(storageDir), async (c) => {
    choices.push(c);
  });
  await untilItemsSet();
  const entry = uiState.qp.items.find((i) => i.entry !== undefined);
  assert.ok(entry !== undefined, 'registry entry item missing');
  uiState.qp.accept(entry);
  await done;
  return choices;
}

// The one notification that carries buttons is the apply offer; earlier
// notices such as the resolved commit note carry none.
function applyOffer(): InfoCall {
  // The install notice is the last info of the flow and now carries no
  // buttons: picking the pack already said "use it" (the direct install
  // flow shows a resolved commit notice first).
  assert.ok(uiState.info.length > 0, 'no notification was shown');
  return uiState.info[uiState.info.length - 1];
}

function en(key: string, args: ReadonlyArray<string | number>): string {
  return lookup(bundle('bundle.l10n.json'), key, args);
}

test('an up to date install applies the pack right away without a middle confirm', async () => {
  const root = makeTempRoot();
  try {
    resetUi();
    uiState.inputAnswer = 'someone/demo-pack';
    const storage = path.join(root, 'storage');
    seedLocalPack(storage, '1.0.0');
    const restoreIo = swapIo(marketRoutes('1.0.0'));
    let choices: PanelChoice[] = [];
    try {
      choices = await runDirectInstall(storage);
    } finally {
      restoreIo();
    }
    const offer = applyOffer();
    assert.equal(offer.message, en('ui.market.uptoDate', ['1.0.0']));
    assert.deepEqual(offer.buttons, []);
    assert.equal(choices.length, 1);
    assert.ok('pack' in choices[0]);
    if ('pack' in choices[0]) {
      assert.equal(choices[0].pack.id, 'demo-pack');
      assert.equal(choices[0].pack.version, '1.0.0');
      assert.equal(choices[0].pack.dir, path.join(storage, 'packs', 'demo-pack'));
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a fresh entry install applies the pack right away and passes the pack', async () => {
  const root = makeTempRoot();
  try {
    resetUi();
    const storage = path.join(root, 'storage');
    fs.mkdirSync(storage, { recursive: true });
    const restoreIo = swapIo(marketRoutes('1.0.0'));
    let choices: PanelChoice[] = [];
    try {
      choices = await runEntryInstall(storage);
    } finally {
      restoreIo();
    }
    const offer = applyOffer();
    assert.equal(offer.message, en('ui.market.installDone', ['Demo Pack']));
    assert.deepEqual(offer.buttons, []);
    assert.equal(choices.length, 1);
    assert.ok('pack' in choices[0]);
    if ('pack' in choices[0]) {
      assert.equal(choices[0].pack.id, 'demo-pack');
      assert.equal(choices[0].pack.version, '1.0.0');
    }
    assert.equal(fs.existsSync(path.join(storage, 'packs', 'demo-pack')), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a direct update applies the new version right away', async () => {
  const root = makeTempRoot();
  try {
    resetUi();
    uiState.inputAnswer = 'someone/demo-pack';
    const storage = path.join(root, 'storage');
    seedLocalPack(storage, '1.0.0');
    const restoreIo = swapIo(marketRoutes('2.0.0'));
    let choices: PanelChoice[] = [];
    try {
      choices = await runDirectInstall(storage);
    } finally {
      restoreIo();
    }
    const offer = applyOffer();
    assert.equal(offer.message, en('ui.market.updateDone', ['2.0.0']));
    assert.deepEqual(offer.buttons, []);
    assert.equal(choices.length, 1);
    assert.ok('pack' in choices[0]);
    if ('pack' in choices[0]) {
      assert.equal(choices[0].pack.id, 'demo-pack');
      assert.equal(choices[0].pack.version, '2.0.0');
    }
    const onDisk = readPack(path.join(storage, 'packs', 'demo-pack'));
    assert.ok(onDisk.ok && onDisk.pack.version === '2.0.0');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a pack folder that vanishes between install and apply reports apply missing and applies nothing', async () => {
  const root = makeTempRoot();
  try {
    resetUi();
    uiState.inputAnswer = 'someone/demo-pack';
    const storage = path.join(root, 'storage');
    seedLocalPack(storage, '1.0.0');
    uiState.onInfo = (call) => {
      // The install notice now carries no buttons; it fires right before the
      // apply lookup, which is the moment the folder can still vanish.
      fs.rmSync(path.join(storage, 'packs', 'demo-pack'), { recursive: true, force: true });
      return undefined;
      return call.buttons[0];
    };
    const restoreIo = swapIo(marketRoutes('1.0.0'));
    let choices: PanelChoice[] = [];
    try {
      choices = await runDirectInstall(storage);
    } finally {
      restoreIo();
    }
    assert.deepEqual(choices, []);
    assert.equal(uiState.error.length, 1);
    assert.equal(uiState.error[0], en('ui.market.applyMissing', ['demo-pack']));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('no bundle carries the dead apply button while the missing pack notice stays', () => {
  const en_ = bundle('bundle.l10n.json');
  const zh = bundle('bundle.l10n.zh-cn.json');
  for (const b of [en_, zh]) {
    assert.equal(b['ui.market.enableAndApply'], undefined);
    assert.ok(b['ui.market.applyMissing'].includes('{0}'));
  }
});
