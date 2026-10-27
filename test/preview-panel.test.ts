// Audition panel tests (the preview suite referenced from
// market-install.test.ts). Four faces, all offline: the whole-pack preview
// download on a fake repository network, the pure row layout and webview
// HTML contract (nonce CSP, JSON injected rows, no autoplay anywhere), the
// vscode side of the panel under a fake editor API (preview folder instead
// of packs, install message phases, dispose cleanup, reveal instead of a
// second download, download failure notice), and the language bundle keys
// for every panel and slot string across en, zh-cn and zh-hans.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Module } from 'node:module';
import { downloadPackForPreview } from '../src/engine/market-install';
import type { PackLocation } from '../src/engine/market-install';
import type { RawIo, RawResponse } from '../src/engine/net-fetch';
import type { PackInfo } from '../src/engine/pack-reader';
import { readPack } from '../src/engine/pack-reader';
import { SLOTS } from '../src/engine/slot-table';
import { previewPanelHtml, previewRows } from '../src/ui/preview-format';
import type { PreviewPanelModel } from '../src/ui/preview-format';
import type { RegistryEntry } from '../src/engine/registry-client';
import type { VirUiContext } from '../src/ui/extension-context';
import { lookup } from '../src/ui/localize';
import { buildFakeWav, makeTempRoot } from './helpers';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const REPO = 'someone/demo-pack';
const LOC: PackLocation = { repo: REPO, commit: SHA, packPath: 'pack' };

function packUrl(rel: string): string {
  return 'https://raw.githubusercontent.com/' + REPO + '/' + SHA + '/pack/' + rel;
}

// ---------------------------------------------------------------------------
// Fake repository network: one buffer or one failure status per exact URL,
// everything unlisted is a 404 (so the jsDelivr hop only ever answers 404
// and the direct raw URL decides the outcome). Every request is recorded.
function routeIo(routes: Record<string, Buffer | number>): { io: RawIo; calls: string[] } {
  const calls: string[] = [];
  const io: RawIo = async (url: string) => {
    calls.push(url);
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
  return { io, calls };
}

interface Staged {
  routes: Record<string, Buffer | number>;
}

// Stage a remote pack tree and turn it into URL routes. Slot rel paths that
// would escape the remote root or collide with installer reserved names are
// staged as routes only in the manifest, never as files.
function stageRemote(root: string, entryId: string, overrides: Record<string, unknown> = {}, corrupt: string[] = []): Staged {
  const remote = path.join(root, 'remote', 'pack');
  fs.mkdirSync(remote, { recursive: true });
  const slots = (overrides.slots as Record<string, string> | undefined) ?? {
    error: 'sounds/e.wav',
    save: 'sounds/s.wav',
  };
  const reserved = ['manifest.json', 'SOURCE.txt', '.vir-origin.json'];
  const rels = [...new Set(Object.values(slots))];
  const routes: Record<string, Buffer | number> = {};
  for (const rel of rels) {
    if (rel.includes('..') || reserved.includes(rel)) {
      continue;
    }
    const p = path.join(remote, ...rel.split('/'));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    if (corrupt.includes(rel)) {
      fs.writeFileSync(p, Buffer.from('junk-not-audio'));
    } else {
      buildFakeWav(p, 0.2);
    }
    routes[packUrl(rel)] = fs.readFileSync(p);
  }
  fs.writeFileSync(path.join(remote, 'SOURCE.txt'), 'source note');
  routes[packUrl('SOURCE.txt')] = Buffer.from('source note');
  routes[packUrl('manifest.json')] = Buffer.from(
    JSON.stringify({
      schema: 1,
      id: entryId,
      name: 'Demo Pack',
      version: '1.0.0',
      author: 'Someone',
      license: 'CC0-1.0',
      sourceLicense: 'original',
      slots,
      ...overrides,
    })
  );
  return { routes };
}

async function until(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 500 && !cond(); i += 1) {
    await new Promise<void>((r) => setImmediate(r));
  }
  assert.ok(cond(), what);
}

// ---------------------------------------------------------------------------
// Face 1: downloadPackForPreview — the whole-pack audition download.

test('preview download lands manifest plus every slot audio and skips SOURCE.txt', async () => {
  const root = makeTempRoot();
  try {
    const staged = stageRemote(root, 'demo-pack');
    const { io, calls } = routeIo(staged.routes);
    const dir = path.join(root, 'preview', 'demo-pack');
    const r = await downloadPackForPreview(io, LOC, '', dir);
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.pack.id, 'demo-pack');
      assert.equal(r.pack.name, 'Demo Pack');
      assert.equal(r.pack.version, '1.0.0');
      assert.equal(r.pack.dir, dir);
      assert.equal(Object.keys(r.pack.slots).length, 2);
      assert.equal(Object.keys(r.pack.disabled).length, 0);
    }
    assert.equal(fs.existsSync(path.join(dir, 'manifest.json')), true);
    assert.equal(fs.existsSync(path.join(dir, 'sounds', 'e.wav')), true);
    assert.equal(fs.existsSync(path.join(dir, 'sounds', 's.wav')), true);
    // SOURCE.txt is provenance for installed packs only: the route exists,
    // so a request for it would show up in calls and on disk.
    assert.equal(fs.existsSync(path.join(dir, 'SOURCE.txt')), false);
    assert.equal(calls.filter((u) => u.includes('SOURCE.txt')).length, 0);
    assert.equal(calls.filter((u) => u.endsWith('.wav')).length, 2);
    assert.equal(calls.filter((u) => u.endsWith('manifest.json')).length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('slots sharing one audio rel path download that file exactly once', async () => {
  const root = makeTempRoot();
  try {
    const staged = stageRemote(root, 'demo-pack', {
      slots: { error: 'sounds/shared.wav', save: 'sounds/shared.wav' },
    });
    const { io, calls } = routeIo(staged.routes);
    const dir = path.join(root, 'preview', 'demo-pack');
    const r = await downloadPackForPreview(io, LOC, '', dir);
    assert.equal(r.ok, true);
    assert.equal(calls.filter((u) => u.endsWith('.wav')).length, 1);
    assert.equal(fs.existsSync(path.join(dir, 'sounds', 'shared.wav')), true);
    if (r.ok) {
      assert.deepEqual(Object.keys(r.pack.slots).sort(), ['error', 'save']);
    }
    const read = readPack(dir);
    assert.equal(read.ok, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an unsafe slot path is gated before any audio transfer', async () => {
  const root = makeTempRoot();
  try {
    const staged = stageRemote(root, 'demo-pack', { slots: { error: '../evil.wav', save: 'sounds/s.wav' } });
    const { io, calls } = routeIo(staged.routes);
    const dir = path.join(root, 'preview', 'demo-pack');
    const r = await downloadPackForPreview(io, LOC, '', dir);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.error.key, 'install.slotUnsafe');
      assert.deepEqual(r.error.args, ['error']);
      assert.deepEqual(r.attempts, []);
    }
    assert.equal(calls.filter((u) => u.endsWith('.wav')).length, 0);
    assert.equal(calls.filter((u) => u.endsWith('manifest.json')).length, 1);
    assert.equal(fs.existsSync(dir), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a slot pointing at a reserved installer name is gated', async () => {
  const root = makeTempRoot();
  try {
    const staged = stageRemote(root, 'demo-pack', { slots: { save: 'manifest.json' } });
    const { io, calls } = routeIo(staged.routes);
    const dir = path.join(root, 'preview', 'demo-pack');
    const r = await downloadPackForPreview(io, LOC, '', dir);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.error.key, 'install.slotReserved');
      assert.deepEqual(r.error.args, ['save', 'manifest.json']);
    }
    assert.equal(calls.filter((u) => u.endsWith('.wav')).length, 0);
    assert.equal(fs.existsSync(dir), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a failed manifest fetch reports attempts and leaves no preview dir', async () => {
  const root = makeTempRoot();
  try {
    const staged = stageRemote(root, 'demo-pack');
    delete staged.routes[packUrl('manifest.json')];
    const { io, calls } = routeIo(staged.routes);
    const dir = path.join(root, 'preview', 'demo-pack');
    const r = await downloadPackForPreview(io, LOC, '', dir);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.error.key, 'install.manifestNet');
      // Two hop urls, retried once per the transport contract.
      assert.equal(r.attempts.length, 4);
      assert.ok(r.attempts.every((a) => a.failure === 'net.httpStatus'));
    }
    assert.equal(calls.filter((u) => u.endsWith('.wav')).length, 0);
    assert.equal(fs.existsSync(dir), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a failing audio file wipes the preview dir and reports the file', async () => {
  const root = makeTempRoot();
  try {
    const staged = stageRemote(root, 'demo-pack');
    staged.routes[packUrl('sounds/e.wav')] = 500;
    const { io } = routeIo(staged.routes);
    const dir = path.join(root, 'preview', 'demo-pack');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'stale.bin'), 'leftover from a crashed run');
    const r = await downloadPackForPreview(io, LOC, '', dir);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.error.key, 'install.fileFailed');
      assert.deepEqual(r.error.args, ['sounds/e.wav']);
      assert.equal(r.attempts.length, 4);
    }
    assert.equal(fs.existsSync(dir), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a manifest that passes the fetch gate but fails pack validation wipes the dir', async () => {
  const root = makeTempRoot();
  try {
    // fetchRemoteManifest accepts any sourceLicense string; readPack does not.
    const staged = stageRemote(root, 'demo-pack', { sourceLicense: 'bogus-license' });
    const { io } = routeIo(staged.routes);
    const dir = path.join(root, 'preview', 'demo-pack');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'stale.bin'), 'leftover');
    const r = await downloadPackForPreview(io, LOC, '', dir);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.error.key, 'pack.sourceLicenseBad');
      assert.deepEqual(r.attempts, []);
    }
    assert.equal(fs.existsSync(dir), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a disabled slot rejects the whole audition download', async () => {
  const root = makeTempRoot();
  try {
    const staged = stageRemote(root, 'demo-pack', {}, ['sounds/e.wav']);
    const { io } = routeIo(staged.routes);
    const dir = path.join(root, 'preview', 'demo-pack');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'stale.bin'), 'leftover');
    const r = await downloadPackForPreview(io, LOC, '', dir);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.error.key, 'install.disabledSlots');
      assert.deepEqual(r.error.args, ['error']);
    }
    assert.equal(fs.existsSync(dir), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Face 2: pure panel layout and HTML.

function buildRowsPack(root: string): PackInfo {
  const dir = path.join(root, 'rowpack');
  const slots: Record<string, string> = {
    error: 'sounds/e.wav',
    save: 'audio/save-tone.wav',
    responseReceived2: 'sounds/rr2.wav',
    responseReceived4: 'sounds/rr4.wav',
  };
  for (const rel of Object.values(slots)) {
    const p = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    buildFakeWav(p, 0.2);
  }
  fs.writeFileSync(
    path.join(dir, 'manifest.json'),
    JSON.stringify({
      schema: 1,
      id: 'rows-pack',
      name: 'Rows Pack',
      version: '1.0.0',
      author: 'Someone',
      license: 'CC0-1.0',
      sourceLicense: 'original',
      slots,
    })
  );
  const read = readPack(dir);
  if (!read.ok) {
    throw new Error('fixture pack unreadable');
  }
  return read.pack;
}

test('previewRows lays out all 28 slots in table order with folded response sub keys', () => {
  const root = makeTempRoot();
  try {
    const pack = buildRowsPack(root);
    const rows = previewRows(pack);
    assert.equal(rows.length, 28);
    assert.deepEqual(rows.map((r) => r.slot), SLOTS.map((s) => s.slot));
    const bySlot = new Map(rows.map((r) => [r.slot, r] as const));
    const err = bySlot.get('error');
    assert.ok(err !== undefined);
    assert.equal(err.covered, true);
    assert.deepEqual(err.files, ['e.wav']);
    assert.deepEqual(err.absPaths, [path.join(pack.dir, 'sounds', 'e.wav')]);
    assert.equal(err.evtKey, 'ui.preview.slot.error');
    const save = bySlot.get('save');
    assert.ok(save !== undefined);
    assert.equal(save.covered, true);
    assert.deepEqual(save.files, ['save-tone.wav']);
    assert.equal(save.evtKey, 'ui.preview.slot.save');
    // Numbered responseReceived sub keys fold into the one shared slot row.
    const resp = bySlot.get('responseReceived');
    assert.ok(resp !== undefined);
    assert.equal(resp.covered, true);
    assert.deepEqual(resp.files, ['rr2.wav', 'rr4.wav']);
    assert.deepEqual(resp.absPaths, [
      path.join(pack.dir, 'sounds', 'rr2.wav'),
      path.join(pack.dir, 'sounds', 'rr4.wav'),
    ]);
    assert.equal(resp.evtKey, 'ui.preview.slot.responseReceived');
    // Uncovered rows stay in place, empty, with their own event key.
    const warn = bySlot.get('warning');
    assert.ok(warn !== undefined);
    assert.equal(warn.covered, false);
    assert.deepEqual(warn.files, []);
    assert.deepEqual(warn.absPaths, []);
    assert.equal(warn.evtKey, 'ui.preview.slot.warning');
    assert.equal(rows.filter((r) => r.covered).length, 3);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('previewPanelHtml ships the CSP nonce, JSON rows and no autoplay path', () => {
  const root = makeTempRoot();
  try {
    const pack = buildRowsPack(root);
    const rows = previewRows(pack);
    const model: PreviewPanelModel = {
      title: 'ZZTITLE',
      badge: 'v9.9.9',
      metaLine: 'ZZMETA',
      headNote: 'ZZHEAD',
      colSlot: 'cslot',
      colEvent: 'cevt',
      colFile: 'cfile',
      notCovered: 'zz-not-covered',
      install: 'ZZINSTALL',
      footNote: 'ZZFOOT',
      installing: 'ZZINSTALLING',
      playFailed: 'ZZPLAYFAILED',
      secondsFmt: '{0}s',
      rows: rows.map((r) => ({
        slot: r.slot,
        evt: 'evt-' + r.slot,
        file: r.covered ? r.files.join(', ') : 'zz-not-covered',
        covered: r.covered,
        uris: r.absPaths.map((p) => 'https://webview.test/' + path.basename(p)),
      })),
    };
    // A raw < inside row data must never survive into the HTML literally.
    model.rows[1].file = 'a<b.wav';
    const html = previewPanelHtml(model, { nonce: 'testnonce123', cspSource: 'https://vscode-csp.test' });
    assert.ok(html.startsWith('<!DOCTYPE html>'));
    // CSP meta: default none, style and media through the webview origin,
    // scripts only with the exact nonce.
    assert.ok(html.includes('<meta http-equiv="Content-Security-Policy"'));
    assert.ok(html.includes("default-src 'none'"));
    assert.ok(html.includes("style-src https://vscode-csp.test 'unsafe-inline'"));
    assert.ok(html.includes('media-src https://vscode-csp.test'));
    assert.ok(html.includes("script-src 'nonce-testnonce123'"));
    assert.ok(html.includes('<script nonce="testnonce123">'));
    // Hard criterion: no autoplay anywhere, in any casing.
    assert.equal(/autoplay/i.test(html), false);
    // Playback rides a user click through Audio.play(), never a load path.
    assert.ok(html.includes('new Audio('));
    assert.ok(html.includes('audio.play()'));
    assert.ok(html.includes("addEventListener('click'"));
    // The install button posts exactly one message type.
    assert.ok(html.includes("vscode.postMessage({ type: 'install' })"));
    assert.ok(html.includes('installState'));
    // The three anchors the script drives.
    assert.ok(html.includes('id="installBtn"'));
    assert.ok(html.includes('id="note"'));
    assert.ok(html.includes('id="rows"'));
    // Every label text lands in the markup.
    for (const text of ['ZZTITLE', 'v9.9.9', 'ZZMETA', 'ZZHEAD', 'cslot', 'cevt', 'cfile', 'zz-not-covered', 'ZZINSTALL', 'ZZFOOT']) {
      assert.ok(html.includes(text), 'markup missing ' + text);
    }
    // 28 rows ride in as JSON, with labels, and < is escaped inside it.
    const dataMatch = /\n  var DATA = (.+);\n/.exec(html);
    assert.ok(dataMatch !== null, 'DATA payload not found');
    const data = JSON.parse(dataMatch[1]) as { labels: Record<string, string>; rows: unknown[] };
    assert.deepEqual(data.labels, {
      playFailed: 'ZZPLAYFAILED',
      secondsFmt: '{0}s',
      installing: 'ZZINSTALLING',
      footNote: 'ZZFOOT',
    });
    assert.equal(data.rows.length, 28);
    assert.deepEqual(data.rows, model.rows as unknown[]);
    assert.ok(html.includes('a\\u003cb.wav'));
    assert.equal(html.includes('a<b.wav'), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Face 3: the vscode side under a fake editor API. The vscode module is
// intercepted at require time (same technique as market.test.ts) and the
// production https io is swapped on the net-fetch module object, so the
// panel runs against real disk with a deterministic fake network.

class FakeWebviewPanel {
  readonly viewType: string;
  title: string;
  readonly options: unknown;
  revealCount = 0;
  webviewUriCalls: string[] = [];
  hostToPage: Array<Record<string, unknown>> = [];
  private msgCbs: Array<(m: unknown) => void> = [];
  private disposeCbs: Array<() => unknown> = [];
  readonly webview = {
    cspSource: 'https://vscode-webview.test',
    html: '',
    asWebviewUri: (uri: { fsPath: string }): { toString(): string } => {
      const s = 'https://webview.test/' + String(uri.fsPath).replace(/\\/g, '/');
      this.webviewUriCalls.push(s);
      return { toString: (): string => s };
    },
    postMessage: async (m: unknown): Promise<boolean> => {
      this.hostToPage.push(m as Record<string, unknown>);
      return true;
    },
    onDidReceiveMessage: (cb: (m: unknown) => void): { dispose(): void } => {
      this.msgCbs.push(cb);
      return { dispose(): void {} };
    },
  };

  constructor(viewType: string, title: string, options: unknown) {
    this.viewType = viewType;
    this.title = title;
    this.options = options;
  }

  reveal(): void {
    this.revealCount += 1;
  }

  onDidDispose(cb: () => unknown): { dispose(): void } {
    this.disposeCbs.push(cb);
    return { dispose(): void {} };
  }

  postFromPage(m: unknown): void {
    for (const cb of [...this.msgCbs]) {
      cb(m);
    }
  }

  fireDispose(): void {
    for (const cb of [...this.disposeCbs]) {
      cb();
    }
  }
}

const uiState = {
  errors: [] as string[],
  panels: [] as FakeWebviewPanel[],
};

function resetUi(): void {
  uiState.errors = [];
  uiState.panels = [];
}

const vscodeFake = {
  env: { language: 'en' },
  ProgressLocation: { Notification: 15 },
  ViewColumn: { Beside: 2 },
  Uri: { file: (p: string) => ({ fsPath: p }) },
  window: {
    withProgress: <T,>(_opts: unknown, fn: () => Promise<T>): Promise<T> => fn(),
    showErrorMessage: async (message: string): Promise<void> => {
      uiState.errors.push(message);
    },
    createWebviewPanel: (viewType: string, title: string, _show: unknown, options: unknown): FakeWebviewPanel => {
      const panel = new FakeWebviewPanel(viewType, title, options);
      uiState.panels.push(panel);
      return panel;
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

// Loaded only after the hook is in place, so the panel module receives the
// fake editor API.
const previewPanelMod: typeof import('../src/ui/preview-panel') = require('../src/ui/preview-panel');
const netFetchMod: typeof import('../src/engine/net-fetch') = require('../src/engine/net-fetch');

// The test build puts the ui modules under out-test/src/ui, so the bundle
// directory math inside render.ts lands on out-test/l10n, a folder the
// compiler never creates; that one directory is redirected here to the real
// l10n folder so panel messages come out localized exactly as shipped.
const localizeMod: typeof import('../src/ui/localize') = require('../src/ui/localize');
const realLoadBundle = localizeMod.loadBundle;
const repoL10nDir = path.join(__dirname, '..', '..', 'l10n');
localizeMod.loadBundle = (dir: string, fileName: string) =>
  realLoadBundle(dir === path.join(__dirname, '..', 'l10n') ? repoL10nDir : dir, fileName);

const enBundle = JSON.parse(
  fs.readFileSync(path.join(repoL10nDir, 'bundle.l10n.json'), 'utf8')
) as Record<string, string>;

function enText(key: string, args: ReadonlyArray<string | number>): string {
  return lookup(enBundle, key, args.map(String));
}

function swapIo(io: RawIo): () => void {
  const previous = netFetchMod.httpsRawIo;
  netFetchMod.httpsRawIo = io;
  return () => {
    netFetchMod.httpsRawIo = previous;
  };
}

function makeCtx(storageDir: string): VirUiContext {
  return { storageDir, extensionDir: path.join(storageDir, 'unused-ext'), owner: 'win-test' };
}

function entryFor(id: string): RegistryEntry {
  return {
    id,
    names: { en: 'Demo Pack' },
    categories: ['ui'],
    language: 'none',
    author: 'Someone',
    version: '1.0.0',
    repo: REPO,
    branch: 'main',
    commit: SHA,
    packPath: 'pack',
    license: 'CC0-1.0',
    sourceLicense: 'original',
  };
}

const noopInstall = async (): Promise<void> => {};

async function openPreview(
  storage: string,
  entry: RegistryEntry,
  routes: Record<string, Buffer | number>,
  onInstall: () => Promise<void>
): Promise<{ panel: FakeWebviewPanel; calls: string[] }> {
  const { io, calls } = routeIo(routes);
  const restore = swapIo(io);
  try {
    await previewPanelMod.openPreviewPanel(makeCtx(storage), entry, '', onInstall);
  } finally {
    restore();
  }
  assert.ok(uiState.panels.length > 0, 'no panel was created');
  return { panel: uiState.panels[uiState.panels.length - 1], calls };
}

test('openPreviewPanel downloads into storage/preview, never packs, and wires the panel', async () => {
  const root = makeTempRoot();
  resetUi();
  try {
    const entry = entryFor('alpha-pack');
    const staged = stageRemote(root, entry.id);
    const storage = path.join(root, 'storage');
    const dir = path.join(storage, 'preview', entry.id);
    const { panel, calls } = await openPreview(storage, entry, staged.routes, noopInstall);
    assert.equal(uiState.panels.length, 1);
    assert.equal(panel.viewType, 'vir.preview');
    assert.equal(panel.title, 'Demo Pack');
    const opts = panel.options as {
      enableScripts?: boolean;
      retainContextWhenHidden?: boolean;
      localResourceRoots?: Array<{ fsPath: string }>;
    };
    assert.equal(opts.enableScripts, true);
    assert.equal(opts.retainContextWhenHidden, false);
    assert.equal(opts.localResourceRoots?.length, 1);
    assert.equal(opts.localResourceRoots?.[0].fsPath, dir);
    // Whole pack on disk under preview/<id>, packs folder untouched.
    assert.equal(fs.existsSync(path.join(dir, 'manifest.json')), true);
    assert.equal(fs.existsSync(path.join(dir, 'sounds', 'e.wav')), true);
    assert.equal(fs.existsSync(path.join(dir, 'sounds', 's.wav')), true);
    assert.equal(fs.existsSync(path.join(dir, 'SOURCE.txt')), false);
    assert.equal(fs.existsSync(path.join(storage, 'packs')), false);
    assert.equal(calls.filter((u) => u.includes('SOURCE.txt')).length, 0);
    // HTML: nonce CSP against the webview origin, no autoplay, rows wired.
    const html = panel.webview.html;
    assert.ok(html.startsWith('<!DOCTYPE html>'));
    assert.equal(/autoplay/i.test(html), false);
    const nonce = /<script nonce="([0-9a-f]{32})">/.exec(html)?.[1];
    assert.ok(nonce !== undefined, 'script nonce missing');
    assert.ok(html.includes("script-src 'nonce-" + nonce + "'"));
    assert.ok(html.includes('media-src https://vscode-webview.test'));
    assert.ok(html.includes('id="installBtn"'));
    assert.ok(html.includes(enText('ui.preview.title', ['Demo Pack'])));
    assert.ok(html.includes(enText('ui.preview.metaLine', [REPO, 2, 28, 5])));
    assert.equal(html.split('"covered":true').length - 1, 2);
    assert.equal(html.split('"covered":false').length - 1, 26);
    assert.equal(panel.webviewUriCalls.length, 2);
    assert.ok(html.includes(panel.webviewUriCalls[0]));
    assert.equal(panel.revealCount, 0);
    // Closing the panel removes the preview folder.
    panel.fireDispose();
    assert.equal(fs.existsSync(dir), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the install message runs onInstall once with running then settled phases', async () => {
  const root = makeTempRoot();
  resetUi();
  try {
    const entry = entryFor('beta-pack');
    const staged = stageRemote(root, entry.id);
    const storage = path.join(root, 'storage');
    let installs = 0;
    const { panel } = await openPreview(storage, entry, staged.routes, async () => {
      installs += 1;
    });
    // Only the exact install message starts the flow.
    panel.postFromPage({ type: 'whatever' });
    panel.postFromPage({ type: 'installState', phase: 'running' });
    await new Promise<void>((r) => setImmediate(r));
    assert.equal(installs, 0);
    assert.equal(panel.hostToPage.length, 0);
    panel.postFromPage({ type: 'install' });
    await until(() => installs === 1 && panel.hostToPage.length >= 2, 'install flow never completed');
    assert.equal(installs, 1);
    assert.deepEqual(panel.hostToPage, [
      { type: 'installState', phase: 'running' },
      { type: 'installState', phase: 'settled' },
    ]);
    panel.fireDispose();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a throwing onInstall still posts the terminal phase and the rejection escapes', async () => {
  const root = makeTempRoot();
  resetUi();
  try {
    const entry = entryFor('gamma-pack');
    const staged = stageRemote(root, entry.id);
    const storage = path.join(root, 'storage');
    const boom = new Error('install boom');
    const { panel } = await openPreview(storage, entry, staged.routes, async () => {
      throw boom;
    });
    // The product runs the flow inside a fire and forget async IIFE, so a
    // throwing install flow surfaces as an unhandled rejection. The test
    // runner's own unhandledRejection hook would fail the run on it, so the
    // hook is swapped for ours just around the trigger, then restored.
    const captured: unknown[] = [];
    const mine = (reason: unknown): void => {
      captured.push(reason);
    };
    const saved = process.listeners('unhandledRejection');
    for (const l of saved) {
      process.off('unhandledRejection', l);
    }
    process.on('unhandledRejection', mine);
    try {
      panel.postFromPage({ type: 'install' });
      for (let i = 0; i < 500 && captured.length === 0; i += 1) {
        await new Promise<void>((r) => setImmediate(r));
      }
    } finally {
      process.off('unhandledRejection', mine);
      for (const l of saved) {
        process.on('unhandledRejection', l);
      }
    }
    assert.equal(captured.length, 1, 'the throwing install flow must surface, not vanish');
    assert.equal(captured[0], boom);
    // The terminal phase goes out even on the throw path.
    assert.deepEqual(panel.hostToPage, [
      { type: 'installState', phase: 'running' },
      { type: 'installState', phase: 'settled' },
    ]);
    panel.fireDispose();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('dispose removes the folder and a later open downloads and builds again', async () => {
  const root = makeTempRoot();
  resetUi();
  try {
    const entry = entryFor('delta-pack');
    const staged = stageRemote(root, entry.id);
    const storage = path.join(root, 'storage');
    const dir = path.join(storage, 'preview', entry.id);
    const first = await openPreview(storage, entry, staged.routes, noopInstall);
    assert.equal(first.calls.filter((u) => u.endsWith('manifest.json')).length, 1);
    first.panel.fireDispose();
    assert.equal(fs.existsSync(dir), false);
    const second = await openPreview(storage, entry, staged.routes, noopInstall);
    assert.equal(uiState.panels.length, 2);
    assert.equal(second.panel.revealCount, 0);
    assert.equal(second.calls.filter((u) => u.endsWith('manifest.json')).length, 1);
    assert.equal(fs.existsSync(path.join(dir, 'manifest.json')), true);
    second.panel.fireDispose();
    assert.equal(fs.existsSync(dir), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a second open for a live panel reveals without downloading or building again', async () => {
  const root = makeTempRoot();
  resetUi();
  try {
    const entry = entryFor('eps-pack');
    const staged = stageRemote(root, entry.id);
    const storage = path.join(root, 'storage');
    const dir = path.join(storage, 'preview', entry.id);
    const { io, calls } = routeIo(staged.routes);
    const restore = swapIo(io);
    try {
      await previewPanelMod.openPreviewPanel(makeCtx(storage), entry, '', noopInstall);
      const wavCalls = calls.filter((u) => u.endsWith('.wav')).length;
      const manifestCalls = calls.filter((u) => u.endsWith('manifest.json')).length;
      const before = fs.readdirSync(path.join(dir, 'sounds')).sort();
      await previewPanelMod.openPreviewPanel(makeCtx(storage), entry, '', noopInstall);
      assert.equal(uiState.panels.length, 1);
      assert.equal(uiState.panels[0].revealCount, 1);
      assert.equal(calls.filter((u) => u.endsWith('.wav')).length, wavCalls);
      assert.equal(calls.filter((u) => u.endsWith('manifest.json')).length, manifestCalls);
      assert.deepEqual(fs.readdirSync(path.join(dir, 'sounds')).sort(), before);
    } finally {
      restore();
    }
    uiState.panels[0].fireDispose();
    assert.equal(fs.existsSync(dir), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a failed download shows the error and creates no panel', async () => {
  const root = makeTempRoot();
  resetUi();
  try {
    const entry = entryFor('zeta-pack');
    const storage = path.join(root, 'storage');
    const dir = path.join(storage, 'preview', entry.id);
    const { io } = routeIo({}); // every hop 404
    const restore = swapIo(io);
    try {
      await previewPanelMod.openPreviewPanel(makeCtx(storage), entry, '', async () => {
        throw new Error('install must not run');
      });
    } finally {
      restore();
    }
    assert.equal(uiState.errors.length, 1);
    assert.ok(uiState.errors[0].includes(enText('install.manifestNet', [])), 'error notice missing manifestNet text');
    assert.ok(uiState.errors[0].includes('404'), 'error notice missing per-source attempt lines');
    assert.equal(uiState.panels.length, 0);
    assert.equal(fs.existsSync(dir), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Face 4: language bundles. 12 panel keys plus 28 slot keys per bundle.

const L10N_FILES = ['bundle.l10n.json', 'bundle.l10n.zh-cn.json', 'bundle.l10n.zh-hans.json'] as const;
const PANEL_KEYS = [
  'ui.preview.fetching',
  'ui.preview.title',
  'ui.preview.metaLine',
  'ui.preview.headNote',
  'ui.preview.colSlot',
  'ui.preview.colEvent',
  'ui.preview.colFile',
  'ui.preview.notCovered',
  'ui.preview.footNote',
  'ui.preview.installing',
  'ui.preview.playFailed',
  'ui.preview.secondsFmt',
];
const SLOT_KEYS = SLOTS.map((s) => 'ui.preview.slot.' + s.slot);

function readBundle(name: (typeof L10N_FILES)[number]): Record<string, string> {
  return JSON.parse(fs.readFileSync(path.join(repoL10nDir, name), 'utf8')) as Record<string, string>;
}

test('all 40 ui.preview keys exist in every one of the three bundles', () => {
  assert.equal(PANEL_KEYS.length, 12);
  assert.equal(SLOT_KEYS.length, 28);
  for (const file of L10N_FILES) {
    const b = readBundle(file);
    for (const key of [...PANEL_KEYS, ...SLOT_KEYS]) {
      assert.ok(typeof b[key] === 'string' && b[key] !== '', file + ' is missing ' + key);
    }
  }
});

test('the dead ui.market.previewFetching key is gone from every bundle', () => {
  for (const file of L10N_FILES) {
    assert.equal(readBundle(file)['ui.market.previewFetching'], undefined, file + ' still carries the dead key');
  }
});

test('preview key sets match across the three bundles and zh-hans mirrors zh-cn', () => {
  const en = readBundle('bundle.l10n.json');
  const cn = readBundle('bundle.l10n.zh-cn.json');
  const hans = readBundle('bundle.l10n.zh-hans.json');
  const enKeys = Object.keys(en).filter((k) => k.startsWith('ui.preview.')).sort();
  assert.equal(enKeys.length, 40);
  assert.deepEqual(Object.keys(cn).filter((k) => k.startsWith('ui.preview.')).sort(), enKeys);
  assert.deepEqual(Object.keys(hans).filter((k) => k.startsWith('ui.preview.')).sort(), enKeys);
  for (const key of enKeys) {
    assert.equal(hans[key], cn[key], 'zh-hans diverges from zh-cn on ' + key);
  }
  // Placeholders survive every translation.
  for (const b of [en, cn, hans]) {
    for (let i = 0; i < 4; i += 1) {
      assert.ok(b['ui.preview.metaLine'].includes('{' + i + '}'), 'metaLine missing {' + i + '}');
    }
    assert.ok(b['ui.preview.title'].includes('{0}'));
    assert.ok(b['ui.preview.secondsFmt'].includes('{0}'));
  }
});
