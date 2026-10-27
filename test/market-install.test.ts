// Market installer tests with a fake repository network: consistency gates,
// download path safety, disabled slot rejection, three step update with
// rollback, version triple branches, direct install parsing, branch head
// resolution, conflict warnings, and the preview fetch.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as path from 'node:path';
import {
  fetchPreviewAudio,
  installPack,
  parseDirectInput,
  resolveBranchHead,
} from '../src/engine/market-install';
import { RawIo, RawResponse } from '../src/engine/net-fetch';
import { readPack } from '../src/engine/pack-reader';
import { buildFakeWav, makeTempRoot } from './helpers';

const SHA = '0123456789abcdef0123456789abcdef01234567';

function repoIo(root: string, statusMap: Record<string, number> = {}): { io: RawIo; calls: string[] } {
  const calls: string[] = [];
  const io: RawIo = async (url: string) => {
    calls.push(url);
    if (url.startsWith('https://api.github.com/')) {
      const body = JSON.stringify({ sha: SHA });
      const res: RawResponse = {
        status: 200,
        headers: { 'content-length': String(body.length) },
        stream: (async function* () {
          yield Buffer.from(body);
        })(),
      };
      return res;
    }
    const rel = new URL(url).pathname.split('/').slice(4).join('/');
    const custom = statusMap[rel];
    if (custom !== undefined) {
      return { status: custom, headers: {}, stream: (async function* () {})() };
    }
    const p = path.join(root, ...rel.split('/'));
    if (!fs.existsSync(p)) {
      return { status: 404, headers: {}, stream: (async function* () {})() };
    }
    const buf = fs.readFileSync(p);
    return {
      status: 200,
      headers: { 'content-length': String(buf.length) },
      stream: (async function* () {
        yield buf;
      })(),
    };
  };
  return { io, calls };
}

function stageRemote(root: string, overrides: Record<string, unknown> = {}): string {
  const dir = path.join(root, 'remote', 'pack');
  fs.mkdirSync(path.join(dir, 'sounds'), { recursive: true });
  const manifest = {
    schema: 1,
    id: 'demo-pack',
    name: 'Demo Pack',
    version: '1.0.0',
    author: 'Someone',
    license: 'CC0-1.0',
    sourceLicense: 'original',
    slots: { error: 'sounds/e.wav', save: 'sounds/s.wav' },
    ...overrides,
  };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  buildFakeWav(path.join(dir, 'sounds', 'e.wav'), 0.2);
  buildFakeWav(path.join(dir, 'sounds', 's.wav'), 0.2);
  fs.writeFileSync(path.join(dir, 'SOURCE.txt'), 'source note');
  return path.join(root, 'remote');
}

function optsFor(root: string, io: RawIo): { storageDir: string; rawIo: RawIo; mirrorPrefix: string; owner: string } {
  return { storageDir: path.join(root, 'storage'), rawIo: io, mirrorPrefix: '', owner: 'win-1234' };
}

const LOC = { repo: 'someone/demo-pack', commit: SHA, packPath: 'pack' };
const EXPECT = {
  id: 'demo-pack',
  version: '1.0.0',
  license: 'CC0-1.0',
  author: 'Someone',
  sourceLicense: 'original',
};

test('fresh install lands a readable pack with an origin record', async () => {
  const root = makeTempRoot();
  stageRemote(root);
  const { io } = repoIo(path.join(root, 'remote'));
  const r = await installPack(io, LOC, optsFor(root, io), EXPECT);
  assert.equal(r.status, 'installed');
  const target = path.join(root, 'storage', 'packs', 'demo-pack');
  const read = readPack(target);
  assert.equal(read.ok, true);
  const origin = JSON.parse(fs.readFileSync(path.join(target, '.vir-origin.json'), 'utf8'));
  assert.equal(origin.commit, SHA);
  assert.equal(origin.repo, 'someone/demo-pack');
  const installing = path.join(root, 'storage', 'installing');
  assert.equal(fs.readdirSync(installing).length, 0);
  assert.ok(fs.existsSync(path.join(target, 'SOURCE.txt')));
});

test('manifest id mismatch with the entry aborts the install', async () => {
  const root = makeTempRoot();
  stageRemote(root);
  const { io } = repoIo(path.join(root, 'remote'));
  const r = await installPack(io, LOC, optsFor(root, io), { ...EXPECT, id: 'other-id' });
  assert.equal(r.status, 'failed');
  if (r.status === 'failed') {
    assert.equal(r.error.key, 'install.mismatch');
  }
  assert.equal(fs.existsSync(path.join(root, 'storage', 'packs', 'demo-pack')), false);
});

test('manifest version mismatch with the entry aborts the install', async () => {
  const root = makeTempRoot();
  stageRemote(root);
  const { io } = repoIo(path.join(root, 'remote'));
  const r = await installPack(io, LOC, optsFor(root, io), { ...EXPECT, version: '2.0.0' });
  assert.equal(r.status, 'failed');
  if (r.status === 'failed') {
    assert.equal(r.error.key, 'install.mismatch');
  }
});

test('a slot path escaping the pack root aborts before any download', async () => {
  const root = makeTempRoot();
  stageRemote(root, { slots: { error: '../evil.wav' } });
  const { io, calls } = repoIo(path.join(root, 'remote'));
  const r = await installPack(io, LOC, optsFor(root, io), EXPECT);
  assert.equal(r.status, 'failed');
  if (r.status === 'failed') {
    assert.equal(r.error.key, 'install.slotUnsafe');
  }
  assert.equal(calls.filter((u) => u.endsWith('.wav')).length, 0);
});

test('a slot pointing at an installer reserved name aborts', async () => {
  const root = makeTempRoot();
  stageRemote(root, { slots: { error: 'manifest.json' } });
  const { io } = repoIo(path.join(root, 'remote'));
  const r = await installPack(io, LOC, optsFor(root, io), EXPECT);
  assert.equal(r.status, 'failed');
  if (r.status === 'failed') {
    assert.equal(r.error.key, 'install.slotReserved');
  }
  assert.equal(fs.existsSync(path.join(root, 'storage', 'packs', 'demo-pack')), false);
});

test('a pack whose audio is garbage is rejected whole', async () => {
  const root = makeTempRoot();
  stageRemote(root);
  fs.writeFileSync(path.join(root, 'remote', 'pack', 'sounds', 'e.wav'), Buffer.from('junk'));
  const { io } = repoIo(path.join(root, 'remote'));
  const r = await installPack(io, LOC, optsFor(root, io), EXPECT);
  assert.equal(r.status, 'failed');
  if (r.status === 'failed') {
    assert.equal(r.error.key, 'install.disabledSlots');
  }
  assert.equal(fs.existsSync(path.join(root, 'storage', 'packs', 'demo-pack')), false);
});

test('conflicting fields warn but the pack manifest wins', async () => {
  const root = makeTempRoot();
  stageRemote(root);
  const { io } = repoIo(path.join(root, 'remote'));
  const r = await installPack(io, LOC, optsFor(root, io), { ...EXPECT, license: 'MIT' });
  assert.equal(r.status, 'installed');
  if (r.status === 'installed') {
    assert.equal(r.warnings.length, 1);
    assert.equal(r.warnings[0].key, 'install.conflict.license');
    const read = readPack(path.join(root, 'storage', 'packs', 'demo-pack'));
    assert.ok(read.ok && read.pack.license === 'CC0-1.0');
  }
});

function installLocal(root: string, version: string): void {
  const dir = path.join(root, 'storage', 'packs', 'demo-pack');
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

test('update swaps in the new version and drops the hold directory', async () => {
  const root = makeTempRoot();
  stageRemote(root, { version: '2.0.0' });
  installLocal(root, '1.0.0');
  const { io } = repoIo(path.join(root, 'remote'));
  const r = await installPack(io, { ...LOC, commit: SHA }, optsFor(root, io), { ...EXPECT, version: '2.0.0' });
  assert.equal(r.status, 'updated');
  const read = readPack(path.join(root, 'storage', 'packs', 'demo-pack'));
  assert.ok(read.ok && read.pack.version === '2.0.0');
  assert.equal(fs.readdirSync(path.join(root, 'storage', 'packs')).length, 1);
});

test('a failed swap rolls back to the old pack intact', async () => {
  const root = makeTempRoot();
  stageRemote(root, { version: '2.0.0' });
  installLocal(root, '1.0.0');
  const { io } = repoIo(path.join(root, 'remote'));
  const realRename = fs.renameSync;
  let call = 0;
  fs.renameSync = ((a: unknown, b: unknown) => {
    call += 1;
    if (call === 2) {
      throw new Error('boom');
    }
    return realRename(a as string, b as string);
  }) as typeof fs.renameSync;
  try {
    const r = await installPack(io, LOC, optsFor(root, io), { ...EXPECT, version: '2.0.0' });
    assert.equal(r.status, 'failed');
    if (r.status === 'failed') {
      assert.equal(r.error.key, 'install.rollback');
    }
  } finally {
    fs.renameSync = realRename;
  }
  const read = readPack(path.join(root, 'storage', 'packs', 'demo-pack'));
  assert.ok(read.ok && read.pack.version === '1.0.0');
  assert.equal(fs.readdirSync(path.join(root, 'storage', 'packs')).length, 1);
});

test('version triple branches: equal, older remote, and numeric ordering', async () => {
  const root = makeTempRoot();
  stageRemote(root, { version: '1.10.0' });
  installLocal(root, '1.9.0');
  const { io } = repoIo(path.join(root, 'remote'));
  const r = await installPack(io, LOC, optsFor(root, io), { ...EXPECT, version: '1.10.0' });
  assert.equal(r.status, 'updated');
  if (r.status === 'updated') {
    assert.equal(r.pack.version, '1.10.0');
  }
});

test('same or older remote version reports up to date without touching disk', async () => {
  const root = makeTempRoot();
  stageRemote(root, { version: '1.0.0' });
  installLocal(root, '1.0.0');
  const { io } = repoIo(path.join(root, 'remote'));
  const r = await installPack(io, LOC, optsFor(root, io), EXPECT);
  assert.equal(r.status, 'uptoDate');
  if (r.status === 'uptoDate') {
    assert.equal(r.localVersion, '1.0.0');
  }
  stageRemote(root, { version: '1.9.0' });
  installLocal(root, '1.10.0');
  const r2 = await installPack(io, { ...LOC }, optsFor(root, io), { ...EXPECT, version: '1.9.0' });
  assert.equal(r2.status, 'uptoDate');
});

test('an up to date outcome names the pack id and carries the local version', async () => {
  const root = makeTempRoot();
  stageRemote(root, { version: '1.0.0' });
  installLocal(root, '1.0.0');
  const { io } = repoIo(path.join(root, 'remote'));
  const r = await installPack(io, LOC, optsFor(root, io), EXPECT);
  assert.equal(r.status, 'uptoDate');
  if (r.status === 'uptoDate') {
    assert.equal(r.packId, 'demo-pack');
    assert.equal(r.localVersion, '1.0.0');
  }
  stageRemote(root, { version: '1.9.0' });
  installLocal(root, '1.10.0');
  const r2 = await installPack(io, LOC, optsFor(root, io), { ...EXPECT, version: '1.9.0' });
  assert.equal(r2.status, 'uptoDate');
  if (r2.status === 'uptoDate') {
    assert.equal(r2.packId, 'demo-pack');
    assert.equal(r2.localVersion, '1.10.0');
  }
});

test('a same id pack under a hand made folder name refuses to install', async () => {
  const root = makeTempRoot();
  stageRemote(root);
  const dir = path.join(root, 'storage', 'packs', 'my-demo');
  fs.mkdirSync(path.join(dir, 'sounds'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'manifest.json'),
    JSON.stringify({
      schema: 1,
      id: 'demo-pack',
      name: 'Demo Pack',
      version: '0.1.0',
      author: 'Someone',
      license: 'CC0-1.0',
      sourceLicense: 'original',
      slots: { error: 'sounds/e.wav' },
    })
  );
  buildFakeWav(path.join(dir, 'sounds', 'e.wav'), 0.2);
  const { io } = repoIo(path.join(root, 'remote'));
  const r = await installPack(io, LOC, optsFor(root, io), EXPECT);
  assert.equal(r.status, 'failed');
  if (r.status === 'failed') {
    assert.equal(r.error.key, 'install.manualDirConflict');
  }
});

test('missing SOURCE.txt is a normal install without the file', async () => {
  const root = makeTempRoot();
  stageRemote(root);
  fs.rmSync(path.join(root, 'remote', 'pack', 'SOURCE.txt'));
  const { io } = repoIo(path.join(root, 'remote'));
  const r = await installPack(io, LOC, optsFor(root, io), EXPECT);
  assert.equal(r.status, 'installed');
  assert.equal(fs.existsSync(path.join(root, 'storage', 'packs', 'demo-pack', 'SOURCE.txt')), false);
});

test('a failing non 404 SOURCE.txt aborts the install', async () => {
  const root = makeTempRoot();
  stageRemote(root);
  const { io } = repoIo(path.join(root, 'remote'), { 'pack/SOURCE.txt': 500 });
  const r = await installPack(io, LOC, optsFor(root, io), EXPECT);
  assert.equal(r.status, 'failed');
  if (r.status === 'failed') {
    assert.equal(r.error.key, 'install.fileFailed');
  }
});

test('direct input parses both shapes and rejects the rest', () => {
  const a = parseDirectInput('someone/demo-pack');
  assert.ok(a.ok && a.repo === 'someone/demo-pack' && a.packPath === 'pack');
  const b = parseDirectInput('someone/demo-pack/assets/pack2');
  assert.ok(b.ok && b.packPath === 'assets/pack2');
  const c = parseDirectInput('justoneword');
  assert.ok(!c.ok && c.error.key === 'direct.inputShape');
  const d = parseDirectInput('someone/demo-pack/..');
  assert.ok(!d.ok && d.error.key === 'direct.packPathBad');
});

test('branch head resolves to a full SHA through the API', async () => {
  const root = makeTempRoot();
  const { io, calls } = repoIo(root);
  const r = await resolveBranchHead(io, 'someone/demo-pack', 'main', '');
  assert.ok(r.ok && r.sha === SHA);
  assert.equal(calls[0], 'https://api.github.com/repos/someone/demo-pack/commits/main');
});

test('branch head falls back to the mirror hop for the API', async () => {
  const root = makeTempRoot();
  let calls = 0;
  const io: RawIo = async (url: string) => {
    calls += 1;
    const direct = url.startsWith('https://api.github.com/');
    const body = JSON.stringify({ sha: SHA });
    if (direct && calls <= 2) {
      return { status: 503, headers: {}, stream: (async function* () {})() };
    }
    return {
      status: 200,
      headers: { 'content-length': String(body.length) },
      stream: (async function* () {
        yield Buffer.from(body);
      })(),
    };
  };
  const r = await resolveBranchHead(io, 'someone/demo-pack', 'main', 'https://m.example/');
  assert.ok(r.ok && r.sha === SHA);
});

test('a bad repository shape refuses before any request', async () => {
  const root = makeTempRoot();
  const { io, calls } = repoIo(root);
  const r = await resolveBranchHead(io, 'not-a-repo', 'main', '');
  assert.ok(!r.ok && r.error.key === 'direct.repoBad');
  assert.equal(calls.length, 0);
});

test('installed audio requests always reference the SHA, never the branch', async () => {
  const root = makeTempRoot();
  stageRemote(root);
  const { io, calls } = repoIo(path.join(root, 'remote'));
  const head = await resolveBranchHead(io, 'someone/demo-pack', 'main', '');
  assert.ok(head.ok);
  const r = await installPack(io, { ...LOC, commit: head.sha }, optsFor(root, io), EXPECT);
  assert.equal(r.status, 'installed');
  const audioCalls = calls.filter((u) => u.endsWith('.wav'));
  assert.ok(audioCalls.length > 0);
  assert.ok(audioCalls.every((u) => u.includes('/' + SHA + '/')));
});

test('preview fetch lands outside the packs folder and prefers the error slot', async () => {
  const root = makeTempRoot();
  stageRemote(root);
  const { io } = repoIo(path.join(root, 'remote'));
  const target = path.join(root, 'storage', 'preview', 'demo-pack.wav');
  const r = await fetchPreviewAudio(io, LOC, '', target);
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.slot, 'error');
    assert.equal(r.rel, 'sounds/e.wav');
  }
  assert.ok(fs.existsSync(target));
  assert.equal(fs.existsSync(path.join(root, 'storage', 'packs')), false);
});

test('preview falls back to the first slot when error is absent', async () => {
  const root = makeTempRoot();
  stageRemote(root, { slots: { save: 'sounds/s.wav' } });
  const { io } = repoIo(path.join(root, 'remote'));
  const r = await fetchPreviewAudio(io, LOC, '', path.join(root, 'p.wav'));
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.slot, 'save');
  }
});
