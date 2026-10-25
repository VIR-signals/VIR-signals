import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as path from 'node:path';
import { locate } from '../src/engine/locate';
import { applyPack, readPendingTx } from '../src/engine/replace';
import { readMarker } from '../src/engine/backup';
import { backupDirFor, verifyBackup } from '../src/engine/backup';
import { loadState } from '../src/engine/ledger';
import { acquireLock } from '../src/engine/lock';
import { TX_NAME } from '../src/engine/paths';
import { sha256Buffer, sha256File } from '../src/engine/fsutil';
import { readPack } from '../src/engine/pack-reader';
import {
  buildFakeWav,
  buildInstallTree,
  buildPack,
  fakeMp3,
  makeTempRoot,
  writePackManifest,
} from './helpers';

function officialHash(name: string): string {
  return sha256Buffer(fakeMp3(name));
}

function makePack(
  root: string,
  id: string,
  slots: Record<string, string>
): ReturnType<typeof readPack> {
  const dir = buildPack(root, id, slots);
  writePackManifest(dir, {
    schema: 1,
    id,
    name: id,
    version: '1.0.0',
    author: 'tester',
    license: 'CC0-1.0',
    sourceLicense: 'original',
    slots,
  });
  return readPack(dir);
}

// Fail the Nth audio file rename (source carries the temp suffix), or every
// audio file rename in mode all.
function patchRenameFail(n: number, mode: 'nth' | 'all'): { restore: () => void; count: () => number } {
  const orig = fs.renameSync;
  let hits = 0;
  const patched = function (a: unknown, b: unknown) {
    const s = String(a);
    if (s.endsWith('.mp3.vir-tmp')) {
      hits += 1;
      if (mode === 'all' || hits === n) {
        throw new Error('injected rename failure');
      }
    }
    return orig(a as never, b as never);
  } as typeof fs.renameSync;
  fs.renameSync = patched;
  return {
    restore: () => {
      fs.renameSync = orig;
    },
    count: () => hits,
  };
}

test('apply writes pack audio to declared slots and leaves others official', () => {
  const root = makeTempRoot();
  try {
    const tree = buildInstallTree(root);
    const located = locate(tree.appRoot, '');
    assert.ok(located.ok);
    const storage = path.join(root, 'store');
    const rp = makePack(root, 'pack-a', {
      error: 'sounds/error.wav',
      save: 'sounds/save.wav',
    });
    assert.ok(rp.ok);
    const r = applyPack(located.located, rp.pack, storage, 'w1');
    assert.ok(r.ok);
    assert.ok(r.ok);
    assert.deepEqual(r.report.replaced.sort(), ['error.mp3', 'save.mp3']);
    assert.equal(r.report.baseline.length, 29);

    const packErrorHash = sha256File(path.join(rp.pack.dir, 'sounds', 'error.wav'));
    assert.equal(sha256File(path.join(tree.mediaDir, 'error.mp3')), packErrorHash);
    assert.equal(sha256File(path.join(tree.mediaDir, 'save.mp3')), sha256File(path.join(rp.pack.dir, 'sounds', 'save.wav')));
    assert.equal(sha256File(path.join(tree.mediaDir, 'format.mp3')), officialHash('format.mp3'));
    assert.equal(sha256File(path.join(tree.mediaDir, 'success.mp3')), officialHash('success.mp3'));

    assert.notEqual(readMarker(tree.mediaDir), undefined);
    assert.equal(fs.existsSync(path.join(tree.mediaDir, TX_NAME)), false);
    const state = loadState(storage);
    assert.equal(state.applied?.packId, 'pack-a');
    assert.equal(state.activePackId, 'pack-a');
    assert.equal(state.applied?.files['error.mp3'], packErrorHash);
    const vb = verifyBackup(backupDirFor(storage, located.located.fingerprint));
    assert.ok(vb.ok);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('switching packs recomputes undeclared slots back to official', () => {
  const root = makeTempRoot();
  try {
    const tree = buildInstallTree(root);
    const located = locate(tree.appRoot, '');
    assert.ok(located.ok);
    const storage = path.join(root, 'store');
    const ra = makePack(root, 'pack-a', {
      error: 'sounds/error.wav',
      save: 'sounds/save.wav',
    });
    assert.ok(ra.ok);
    assert.ok(applyPack(located.located, ra.pack, storage, 'w1').ok);

    const rb = makePack(root, 'pack-b', { save: 'sounds/save.wav' });
    assert.ok(rb.ok);
    const r2 = applyPack(located.located, rb.pack, storage, 'w1');
    assert.ok(r2.ok);
    assert.ok(r2.ok);
    assert.equal(
      sha256File(path.join(tree.mediaDir, 'save.mp3')),
      sha256File(path.join(rb.pack.dir, 'sounds', 'save.wav'))
    );
    assert.equal(sha256File(path.join(tree.mediaDir, 'error.mp3')), officialHash('error.mp3'));
    assert.equal(loadState(storage).applied?.packId, 'pack-b');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('responseReceived main key fills all four files', () => {
  const root = makeTempRoot();
  try {
    const tree = buildInstallTree(root);
    const located = locate(tree.appRoot, '');
    assert.ok(located.ok);
    const storage = path.join(root, 'store');
    const rp = makePack(root, 'pack-r', { responseReceived: 'sounds/rr.wav' });
    assert.ok(rp.ok);
    assert.ok(applyPack(located.located, rp.pack, storage, 'w1').ok);
    const hash = sha256File(path.join(rp.pack.dir, 'sounds', 'rr.wav'));
    for (let i = 1; i <= 4; i++) {
      assert.equal(sha256File(path.join(tree.mediaDir, `responseReceived${i}.mp3`)), hash);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('responseReceived sub keys fill only their own files', () => {
  const root = makeTempRoot();
  try {
    const tree = buildInstallTree(root);
    const located = locate(tree.appRoot, '');
    assert.ok(located.ok);
    const storage = path.join(root, 'store');
    const rp = makePack(root, 'pack-r', {
      responseReceived1: 'sounds/r1.wav',
      responseReceived3: 'sounds/r3.wav',
    });
    assert.ok(rp.ok);
    assert.ok(applyPack(located.located, rp.pack, storage, 'w1').ok);
    assert.equal(
      sha256File(path.join(tree.mediaDir, 'responseReceived1.mp3')),
      sha256File(path.join(rp.pack.dir, 'sounds', 'r1.wav'))
    );
    assert.equal(
      sha256File(path.join(tree.mediaDir, 'responseReceived3.mp3')),
      sha256File(path.join(rp.pack.dir, 'sounds', 'r3.wav'))
    );
    assert.equal(
      sha256File(path.join(tree.mediaDir, 'responseReceived2.mp3')),
      officialHash('responseReceived2.mp3')
    );
    assert.equal(
      sha256File(path.join(tree.mediaDir, 'responseReceived4.mp3')),
      officialHash('responseReceived4.mp3')
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('failure at the Nth file rolls every committed file back', () => {
  const root = makeTempRoot();
  const patch = patchRenameFail(5, 'nth');
  try {
    const tree = buildInstallTree(root);
    const located = locate(tree.appRoot, '');
    assert.ok(located.ok);
    const storage = path.join(root, 'store');
    const rp = makePack(root, 'pack-a', {
      error: 'sounds/error.wav',
      save: 'sounds/save.wav',
    });
    assert.ok(rp.ok);
    const r = applyPack(located.located, rp.pack, storage, 'w1');
    assert.equal(r.ok, false);
    assert.ok(!r.ok && r.error.key === 'apply.rolledBack');
    for (const name of ['error.mp3', 'save.mp3', 'format.mp3', 'success.mp3']) {
      assert.equal(sha256File(path.join(tree.mediaDir, name)), officialHash(name), name);
    }
    assert.equal(readMarker(tree.mediaDir), undefined);
    assert.equal(fs.existsSync(path.join(tree.mediaDir, TX_NAME)), false);
    assert.equal(loadState(storage).applied, null);
    assert.ok(patch.count() >= 5);
  } finally {
    patch.restore();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('failure over an existing pack restores the previous pack, not official', () => {
  const root = makeTempRoot();
  try {
    const tree = buildInstallTree(root);
    const located = locate(tree.appRoot, '');
    assert.ok(located.ok);
    const storage = path.join(root, 'store');
    const ra = makePack(root, 'pack-a', {
      error: 'sounds/error.wav',
      save: 'sounds/save.wav',
    });
    assert.ok(ra.ok);
    assert.ok(applyPack(located.located, ra.pack, storage, 'w1').ok);
    const aErrorHash = sha256File(path.join(ra.pack.dir, 'sounds', 'error.wav'));

    const rb = makePack(root, 'pack-b', { save: 'sounds/save.wav' });
    assert.ok(rb.ok);
    const patch = patchRenameFail(3, 'nth');
    const r2 = applyPack(located.located, rb.pack, storage, 'w1');
    patch.restore();
    assert.equal(r2.ok, false);
    assert.ok(!r2.ok && r2.error.key === 'apply.rolledBack');
    assert.equal(sha256File(path.join(tree.mediaDir, 'error.mp3')), aErrorHash);
    assert.equal(
      sha256File(path.join(tree.mediaDir, 'save.mp3')),
      sha256File(path.join(ra.pack.dir, 'sounds', 'save.wav'))
    );
    assert.notEqual(readMarker(tree.mediaDir), undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('crash mid transaction is resolved by the next apply', () => {
  const root = makeTempRoot();
  try {
    const tree = buildInstallTree(root);
    const located = locate(tree.appRoot, '');
    assert.ok(located.ok);
    const storage = path.join(root, 'store');
    const ra = makePack(root, 'pack-a', { error: 'sounds/error.wav' });
    assert.ok(ra.ok);
    assert.ok(applyPack(located.located, ra.pack, storage, 'w1').ok);
    const aErrorHash = sha256File(path.join(ra.pack.dir, 'sounds', 'error.wav'));

    const rb = makePack(root, 'pack-b', { save: 'sounds/save.wav' });
    assert.ok(rb.ok);
    const patch = patchRenameFail(1, 'all');
    const r2 = applyPack(located.located, rb.pack, storage, 'w1');
    patch.restore();
    assert.equal(r2.ok, false);
    assert.ok(!r2.ok && r2.error.key === 'recovery.rollbackFailed');
    assert.notEqual(readPendingTx(tree.mediaDir), undefined);
    assert.equal(sha256File(path.join(tree.mediaDir, 'error.mp3')), aErrorHash);

    const r3 = applyPack(located.located, rb.pack, storage, 'w1');
    assert.ok(r3.ok);
    assert.equal(sha256File(path.join(tree.mediaDir, 'error.mp3')), officialHash('error.mp3'));
    assert.equal(
      sha256File(path.join(tree.mediaDir, 'save.mp3')),
      sha256File(path.join(rb.pack.dir, 'sounds', 'save.wav'))
    );
    assert.equal(readPendingTx(tree.mediaDir), undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('corrupt transaction record is a loud refusal', () => {
  const root = makeTempRoot();
  try {
    const tree = buildInstallTree(root);
    const located = locate(tree.appRoot, '');
    assert.ok(located.ok);
    fs.writeFileSync(path.join(tree.mediaDir, TX_NAME), 'garbage');
    const rp = makePack(root, 'pack-a', { error: 'sounds/error.wav' });
    assert.ok(rp.ok);
    const r = applyPack(located.located, rp.pack, path.join(root, 'store'), 'w1');
    assert.equal(r.ok, false);
    assert.ok(!r.ok && r.error.key === 'recovery.corrupt');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('apply refuses while another owner holds the lock', () => {
  const root = makeTempRoot();
  try {
    const tree = buildInstallTree(root);
    const located = locate(tree.appRoot, '');
    assert.ok(located.ok);
    const storage = path.join(root, 'store');
    assert.ok(acquireLock(storage, 'other-window').ok);
    const rp = makePack(root, 'pack-a', { error: 'sounds/error.wav' });
    assert.ok(rp.ok);
    const r = applyPack(located.located, rp.pack, storage, 'w1');
    assert.equal(r.ok, false);
    assert.ok(!r.ok && r.error.key === 'lock.busy');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('marker without a baseline refuses apply', () => {
  const root = makeTempRoot();
  try {
    const tree = buildInstallTree(root);
    const located = locate(tree.appRoot, '');
    assert.ok(located.ok);
    const storage = path.join(root, 'store');
    fs.writeFileSync(
      path.join(tree.mediaDir, '.vir.marker'),
      JSON.stringify({ packId: 'ghost', at: Date.now(), version: '1.143.1' })
    );
    const rp = makePack(root, 'pack-a', { error: 'sounds/error.wav' });
    assert.ok(rp.ok);
    const r = applyPack(located.located, rp.pack, storage, 'w1');
    assert.equal(r.ok, false);
    assert.ok(!r.ok && r.error.key === 'apply.noBaseline');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('disabled slot keeps official audio and is reported', () => {
  const root = makeTempRoot();
  try {
    const tree = buildInstallTree(root);
    const located = locate(tree.appRoot, '');
    assert.ok(located.ok);
    const storage = path.join(root, 'store');
    const rp = makePack(root, 'pack-a', {
      error: 'sounds/error.wav',
      save: 'sounds/save.wav',
    });
    assert.ok(rp.ok);
    fs.rmSync(path.join(rp.pack.dir, 'sounds', 'save.wav'));
    const rechecked = readPack(rp.pack.dir);
    assert.ok(rechecked.ok);
    const r = applyPack(located.located, rechecked.pack, storage, 'w1');
    assert.ok(r.ok);
    assert.ok(r.ok);
    assert.equal(sha256File(path.join(tree.mediaDir, 'save.mp3')), officialHash('save.mp3'));
    assert.equal(r.report.disabled.save.key, 'pack.audioMissing');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
