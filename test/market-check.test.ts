// Regression suite for the market picker check-mark contract and the
// status bar label. The picker list has three sections (index entries,
// local packs, keep-official) and the check mark is allowed on exactly
// one row: the active pack id checks the local pack row while an index
// entry sharing that same id must stay bare (the double-check accident
// this suite guards against), a newer remote build turns the index row
// into an up-arrow row, an empty selection checks the keep-official row,
// and a failed index fetch removes the whole entry section while the
// local check survives. The status bar echoes the applied pack name,
// then the active id when nothing is applied, and cuts the label at 14
// characters. Everything runs offline: the vscode module is intercepted
// at require time and every https hop is routed to literal buffers, the
// same skeleton market.test.ts and preview-panel.test.ts use.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Module } from 'node:module';
import { freshState, saveState } from '../src/engine/ledger';
import type { AppliedState } from '../src/engine/ledger';
import type { RawIo } from '../src/engine/net-fetch';
import { lookup } from '../src/ui/localize';
import type { VirUiContext } from '../src/ui/extension-context';
import { buildFakeWav, makeTempRoot } from './helpers';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const RAW = 'https://raw.githubusercontent.com';
const REGISTRY_URL = RAW + '/vir-test/registry/main/registry.json';
const PACK_BASE = RAW + '/someone/demo-pack/' + SHA + '/pack/';
const PACK_ID = 'demo-pack';
const PACK_NAME = 'Demo Pack';
const CHECK = '✓ ';
const ARROW = '↑ ';
const AUDIO_ICON = '$(audio-file)';
const BELL = '$(bell)';

function registryBody(version: string): Buffer {
  return Buffer.from(
    JSON.stringify({
      schema: 1,
      packs: [
        {
          id: PACK_ID,
          names: { en: PACK_NAME },
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

// Only the entry manifest is touched while the list is built (the
// coverage line prefetches it); slot audio moves only on a later
// install, which these tests never trigger.
function remoteManifestBody(version: string): Buffer {
  return Buffer.from(
    JSON.stringify({
      schema: 1,
      id: PACK_ID,
      name: PACK_NAME,
      version,
      author: 'Someone',
      license: 'CC0-1.0',
      sourceLicense: 'original',
      slots: { error: 'sounds/e.wav', save: 'sounds/s.wav' },
    })
  );
}

function pickerRoutes(version: string): Record<string, Buffer | number> {
  return {
    [REGISTRY_URL]: registryBody(version),
    [PACK_BASE + 'manifest.json']: remoteManifestBody(version),
  };
}

// One buffer or one failure status per exact URL; anything unlisted is a
// 404, so an empty route map models a fully unreachable network.
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
  entry?: unknown;
  localPack?: unknown;
  direct?: boolean;
  none?: boolean;
  indexError?: boolean;
  [key: string]: unknown;
}

// The picker the market flow drives: items are captured for assertions
// and hide() releases the flow the same way closing the picker would.
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
  hide(): void {
    for (const cb of [...this.hideCbs]) {
      cb();
    }
  }
}

const uiState = {
  config: { 'vir.packRegistryRepo': 'vir-test/registry', 'vir.packMirrorTemplate': '' } as Record<string, string>,
  qp: new FakeQuickPick(),
};

function resetUi(): void {
  uiState.qp = new FakeQuickPick();
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
    showQuickPick: async () => undefined,
    showInputBox: async () => undefined,
    showInformationMessage: async () => undefined,
    showWarningMessage: async () => undefined,
    showErrorMessage: async () => undefined,
    withProgress: <T,>(_opts: unknown, fn: () => Promise<T>): Promise<T> => fn(),
    createWebviewPanel: (): never => {
      throw new Error('no-webview-here');
    },
  },
  commands: {
    registerCommand: () => ({ dispose(): void {} }),
    executeCommand: async () => undefined,
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

// Loaded only after the hook is in place, so the market module and the
// command module (which pulls the market module in) receive the fake
// editor API.
const market: typeof import('../src/ui/market') = require('../src/ui/market');
const commands: typeof import('../src/ui/commands') = require('../src/ui/commands');
const netFetch: typeof import('../src/engine/net-fetch') = require('../src/engine/net-fetch');

// The test build puts the ui modules under out-test/src/ui, so the bundle
// directory math inside render.ts lands on out-test/l10n, a folder the
// compiler never creates; that one directory is redirected here to the
// real l10n folder so picker labels come out localized exactly as
// shipped.
const localizeModule: typeof import('../src/ui/localize') = require('../src/ui/localize');
const realLoadBundle = localizeModule.loadBundle;
const repoL10nDir = path.join(__dirname, '..', '..', 'l10n');
localizeModule.loadBundle = (dir, fileName) =>
  realLoadBundle(dir === path.join(__dirname, '..', 'l10n') ? repoL10nDir : dir, fileName);

const enBundle = JSON.parse(
  fs.readFileSync(path.join(repoL10nDir, 'bundle.l10n.json'), 'utf8')
) as Record<string, string>;
const enNone = lookup(enBundle, 'ui.select.none', []);

function swapIo(routes: Record<string, Buffer | number>): () => void {
  const previous = netFetch.httpsRawIo;
  netFetch.httpsRawIo = routedIo(routes);
  return () => {
    netFetch.httpsRawIo = previous;
  };
}

function makeCtx(storageDir: string): VirUiContext {
  return { storageDir, extensionDir: path.join(storageDir, 'unused-ext'), owner: 'win-test' };
}

function seedLocalPack(storageDir: string, version: string): void {
  const dir = path.join(storageDir, 'packs', PACK_ID);
  fs.mkdirSync(path.join(dir, 'sounds'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'manifest.json'),
    JSON.stringify({
      schema: 1,
      id: PACK_ID,
      name: PACK_NAME,
      version,
      author: 'Someone',
      license: 'CC0-1.0',
      sourceLicense: 'original',
      slots: { error: 'sounds/e.wav' },
    })
  );
  buildFakeWav(path.join(dir, 'sounds', 'e.wav'), 0.2);
}

// The applied record only needs to carry the fields the status bar and
// the state reader look at; the fingerprint here is a stand-in shape.
function fakeApplied(packId: string, packName: string): AppliedState {
  return {
    packId,
    packName,
    fingerprint: { version: '1.143.1', commit: 'c'.repeat(40) },
    versionDir: 'vdir',
    mediaDir: path.join('vdir', 'media'),
    installRoot: 'install',
    files: {},
    appliedAt: '2026-01-01T00:00:00.000Z',
  };
}

function seedState(storageDir: string, activePackId: string, appliedPackName?: string): void {
  const state = freshState();
  state.activePackId = activePackId;
  if (appliedPackName !== undefined) {
    state.applied = fakeApplied(activePackId === '' ? PACK_ID : activePackId, appliedPackName);
  }
  saveState(storageDir, state);
}

// Drive the market picker until its items land, snapshot them, then close
// the picker so the flow settles before the fake network is restored.
async function captureItems(
  storage: string,
  routes: Record<string, Buffer | number>
): Promise<FakePickItem[]> {
  resetUi();
  const restore = swapIo(routes);
  try {
    const done = market.marketSelectFlow(makeCtx(storage), async () => {});
    for (let i = 0; i < 200 && uiState.qp.items.length === 0; i += 1) {
      await new Promise<void>((r) => setImmediate(r));
    }
    assert.ok(uiState.qp.items.length > 0, 'no items');
    const items = [...uiState.qp.items];
    uiState.qp.hide();
    await done;
    return items;
  } finally {
    restore();
  }
}

function checkedRows(items: ReadonlyArray<FakePickItem>): FakePickItem[] {
  return items.filter((i) => typeof i.label === 'string' && i.label.startsWith(CHECK));
}

// Case 1: the registry index and the local packs folder both carry the
// same id and that id is the active one. Exactly one row is checked, the
// check sits on the local pack row (with the audio icon label), and the
// index row for the same id exists yet carries no check.
test('check on local', async () => {
  const root = makeTempRoot();
  try {
    const storage = path.join(root, 'storage');
    seedLocalPack(storage, '1.0.0');
    seedState(storage, PACK_ID);
    const items = await captureItems(storage, pickerRoutes('1.0.0'));
    assert.ok(items.some((i) => 'entry' in i), 'no entry row');
    const rows = checkedRows(items);
    assert.equal(rows.length, 1, 'two checks');
    assert.ok(rows[0].localPack !== undefined, 'not local');
    assert.equal('entry' in rows[0], false);
    assert.equal((rows[0].localPack as { id: string }).id, PACK_ID);
    assert.equal(rows[0].label, CHECK + AUDIO_ICON + ' ' + PACK_NAME);
    const noneRow = items.find((i) => i.none === true);
    assert.ok(noneRow !== undefined, 'no none row');
    assert.equal(noneRow.label, enNone);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// Case 2: same shared-id scene with remote and local at the same
// version. The index row shows the plain display name: no check, no up
// arrow, no icon of any kind.
test('entry row bare', async () => {
  const root = makeTempRoot();
  try {
    const storage = path.join(root, 'storage');
    seedLocalPack(storage, '1.0.0');
    seedState(storage, PACK_ID);
    const items = await captureItems(storage, pickerRoutes('1.0.0'));
    const entryRow = items.find((i) => 'entry' in i);
    assert.ok(entryRow !== undefined, 'no entry row');
    assert.equal(entryRow.label, PACK_NAME);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// Case 3: the local 1.0.0 sits behind the registry 1.1.0 while the id is
// active. The index row gets the up arrow and still no check; the single
// check stays on the local row.
test('arrow on stale', async () => {
  const root = makeTempRoot();
  try {
    const storage = path.join(root, 'storage');
    seedLocalPack(storage, '1.0.0');
    seedState(storage, PACK_ID);
    const items = await captureItems(storage, pickerRoutes('1.1.0'));
    const entryRow = items.find((i) => 'entry' in i);
    assert.ok(entryRow !== undefined, 'no entry row');
    assert.equal(entryRow.label, ARROW + PACK_NAME);
    assert.equal(typeof entryRow.label === 'string' && entryRow.label.startsWith(CHECK), false);
    const rows = checkedRows(items);
    assert.equal(rows.length, 1);
    assert.ok(rows[0].localPack !== undefined, 'not local');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// Case 4: no active id. The one check moves to the keep-official row and
// the local row shows bare.
test('none row check', async () => {
  const root = makeTempRoot();
  try {
    const storage = path.join(root, 'storage');
    seedLocalPack(storage, '1.0.0');
    seedState(storage, '');
    const items = await captureItems(storage, pickerRoutes('1.0.0'));
    const rows = checkedRows(items);
    assert.equal(rows.length, 1);
    assert.ok(rows[0].none === true, 'not none row');
    assert.equal(rows[0].label, CHECK + enNone);
    const localRow = items.find((i) => i.localPack !== undefined);
    assert.ok(localRow !== undefined, 'no local row');
    assert.equal(localRow.label, AUDIO_ICON + ' ' + PACK_NAME);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// Case 5: every network hop answers 404. The entry section disappears
// whole (no row carries an entry), a warning row takes its place, and
// the active local pack keeps the single check while the keep-official
// row stays bare.
test('index gone', async () => {
  const root = makeTempRoot();
  try {
    const storage = path.join(root, 'storage');
    seedLocalPack(storage, '1.0.0');
    seedState(storage, PACK_ID);
    const items = await captureItems(storage, {});
    assert.equal(items.filter((i) => 'entry' in i).length, 0);
    const warnRow = items.find((i) => i.indexError === true);
    assert.ok(warnRow !== undefined, 'no warn row');
    assert.equal(typeof warnRow.label === 'string' && warnRow.label.startsWith('$(warning)'), true);
    const rows = checkedRows(items);
    assert.equal(rows.length, 1);
    assert.ok(rows[0].localPack !== undefined, 'not local');
    assert.equal(rows[0].label, CHECK + AUDIO_ICON + ' ' + PACK_NAME);
    const noneRow = items.find((i) => i.none === true);
    assert.equal(noneRow?.label, enNone);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// Case 6: the status bar text. An applied record shows the applied pack
// name (even when the active id differs), a missing applied record shows
// the active id, an empty selection shows the bare bell, and a long name
// is cut at 14 characters.
test('statusbar text', () => {
  const root = makeTempRoot();
  try {
    type Bar = Parameters<typeof commands.refreshStatusBar>[0];
    const makeBar = (): { bar: Bar; text(): string } => {
      const holder = { text: '' };
      return { bar: holder as unknown as Bar, text: () => holder.text };
    };
    const named = makeBar();
    seedState(path.join(root, 's-a'), PACK_ID, PACK_NAME);
    commands.refreshStatusBar(named.bar, makeCtx(path.join(root, 's-a')));
    assert.equal(named.text(), BELL + ' ' + PACK_NAME);
    const byId = makeBar();
    seedState(path.join(root, 's-b'), PACK_ID);
    commands.refreshStatusBar(byId.bar, makeCtx(path.join(root, 's-b')));
    assert.equal(byId.text(), BELL + ' ' + PACK_ID);
    const empty = makeBar();
    seedState(path.join(root, 's-c'), '');
    commands.refreshStatusBar(empty.bar, makeCtx(path.join(root, 's-c')));
    assert.equal(empty.text(), BELL);
    const LONG_NAME = 'abcdefghijklmnopqrst';
    const cut = makeBar();
    seedState(path.join(root, 's-d'), PACK_ID, LONG_NAME);
    commands.refreshStatusBar(cut.bar, makeCtx(path.join(root, 's-d')));
    assert.equal(cut.text(), BELL + ' ' + LONG_NAME.slice(0, 14));
    assert.equal(cut.text().length, BELL.length + 1 + 14);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// Case 7: the check-mark and status bar behaviors are served entirely by
// keys that already ship. The picker/status-bar key domain is frozen
// here per bundle: a key appearing in or vanishing from this list means
// the copy contract moved and this suite must be revisited. The zh-hans
// bundle must mirror zh-cn value for value in this domain.
const L10N_FILES = ['bundle.l10n.json', 'bundle.l10n.zh-cn.json', 'bundle.l10n.zh-hans.json'] as const;
const PICKER_KEYS = [
  'ui.market.applyMissing',
  'ui.market.coverUnknown',
  'ui.market.coverage',
  'ui.market.directDetail',
  'ui.market.directInstall',
  'ui.market.directPlaceholder',
  'ui.market.indexUnavailable',
  'ui.market.installDone',
  'ui.market.installOrUpdate',
  'ui.market.installing',
  'ui.market.localDetail',
  'ui.market.preview',
  'ui.market.resolved',
  'ui.market.resolving',
  'ui.market.updateDone',
  'ui.market.uptoDate',
  'ui.select.none',
  'ui.select.placeholder',
  'ui.statusbar.tooltip',
];

test('l10n unchanged', () => {
  const bundles = L10N_FILES.map(
    (f) => JSON.parse(fs.readFileSync(path.join(repoL10nDir, f), 'utf8')) as Record<string, string>
  );
  for (let i = 0; i < L10N_FILES.length; i += 1) {
    const got = Object.keys(bundles[i])
      .filter((k) => k.startsWith('ui.market.') || k.startsWith('ui.select.') || k.startsWith('ui.statusbar.'))
      .sort();
    assert.deepEqual(got, PICKER_KEYS, L10N_FILES[i]);
  }
  const cn = bundles[1];
  const hans = bundles[2];
  for (const k of PICKER_KEYS) {
    assert.equal(hans[k], cn[k], k);
  }
});
