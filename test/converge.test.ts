// Tests for the master switch convergence engine: the expectedState truth
// table, the alreadyConverged site check, and convergeToExpected over the
// fake install tree. A converged site must cost zero writes (proved by a
// full mtime plus content snapshot of the media directory), a held lock must
// be waited out, and every failure path must surface its error key instead
// of throwing or silently swallowing.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as path from 'node:path';
import { locate } from '../src/engine/locate';
import { expectedState, loadState, saveState } from '../src/engine/ledger';
import {
  alreadyConverged,
  convergeToExpected,
  ConvergeOutcome,
} from '../src/engine/converge';
import { backupDirFor, loadBackupManifest, markerPath, readMarker } from '../src/engine/backup';
import { applyPack } from '../src/engine/replace';
import { readPack } from '../src/engine/pack-reader';
import { LOCK_NAME } from '../src/engine/paths';
import { sha256Buffer, sha256File } from '../src/engine/fsutil';
import {
  buildInstallTree,
  buildPack,
  fakeMp3,
  makeTempRoot,
  writePackManifest,
} from './helpers';

function officialHash(name: string): string {
  return sha256Buffer(fakeMp3(name));
}

function makePack(root: string, id: string, slots: Record<string, string>) {
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

function sleepReal(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Zero write witness: every file below root keyed by mtimeMs plus content
// hash, directories by their mere existence. Any create, delete, rewrite,
// or touch breaks the comparison.
function snapshotTree(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string, rel: string) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const ent of entries) {
      const relPath = rel === '' ? ent.name : rel + '/' + ent.name;
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        out.set(relPath, 'dir');
        walk(p, relPath);
      } else if (ent.isFile()) {
        const st = fs.statSync(p);
        out.set(relPath, `file:${st.mtimeMs}:${sha256File(p)}`);
      } else {
        out.set(relPath, 'other');
      }
    }
  };
  walk(root, '');
  return out;
}

function assertTreeUntouched(root: string, before: Map<string, string>): void {
  const after = snapshotTree(root);
  assert.deepEqual(
    [...after.keys()].sort(),
    [...before.keys()].sort(),
    'file set changed under ' + root
  );
  for (const key of before.keys()) {
    assert.equal(after.get(key), before.get(key), 'touched: ' + key);
  }
}

test('expectedState truth table: off switch or empty pack means native', () => {
  assert.deepEqual(expectedState(false, 'pack-a'), { kind: 'native' });
  assert.deepEqual(expectedState(false, ''), { kind: 'native' });
  assert.deepEqual(expectedState(true, ''), { kind: 'native' });
  assert.deepEqual(expectedState(true, 'pack-a'), { kind: 'pack', packId: 'pack-a' });
});

test('alreadyConverged: a fresh untouched site is converged for native', () => {
  const root = makeTempRoot();
  try {
    const tree = buildInstallTree(root);
    const located = locate(tree.appRoot, '');
    assert.ok(located.ok);
    const storage = path.join(root, 'store');
    assert.equal(alreadyConverged({ kind: 'native' }, storage, located.located), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('alreadyConverged: a bare on site marker breaks native convergence', () => {
  const root = makeTempRoot();
  try {
    const tree = buildInstallTree(root);
    const located = locate(tree.appRoot, '');
    assert.ok(located.ok);
    const storage = path.join(root, 'store');
    const rp = makePack(storage, 'pack-a', { error: 'sounds/error.wav' });
    assert.ok(rp.ok);
    assert.ok(applyPack(located.located, rp.pack, storage, 'w1').ok);
    // Simulate a lost ledger while the marker survived: applied null alone
    // must not read as native.
    const s = loadState(storage);
    s.applied = null;
    saveState(storage, s);
    assert.equal(alreadyConverged({ kind: 'native' }, storage, located.located), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('alreadyConverged: applied pack with matching fingerprint and marker is converged', () => {
  const root = makeTempRoot();
  try {
    const tree = buildInstallTree(root);
    const located = locate(tree.appRoot, '');
    assert.ok(located.ok);
    const storage = path.join(root, 'store');
    const rp = makePack(storage, 'pack-a', { error: 'sounds/error.wav' });
    assert.ok(rp.ok);
    assert.ok(applyPack(located.located, rp.pack, storage, 'w1').ok);
    assert.equal(
      alreadyConverged({ kind: 'pack', packId: 'pack-a' }, storage, located.located),
      true
    );
    // The same site is not converged for native while the pack is applied.
    assert.equal(alreadyConverged({ kind: 'native' }, storage, located.located), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('alreadyConverged: pack expectation rejects packId, fingerprint, and marker mismatches', () => {
  const root = makeTempRoot();
  try {
    const tree = buildInstallTree(root);
    const located = locate(tree.appRoot, '');
    assert.ok(located.ok);
    const storage = path.join(root, 'store');
    const rp = makePack(storage, 'pack-a', { error: 'sounds/error.wav' });
    assert.ok(rp.ok);
    assert.ok(applyPack(located.located, rp.pack, storage, 'w1').ok);
    const want = { kind: 'pack' as const, packId: 'pack-a' };

    assert.equal(alreadyConverged({ kind: 'pack', packId: 'other' }, storage, located.located), false);

    const s1 = loadState(storage);
    assert.ok(s1.applied);
    s1.applied.fingerprint = { ...s1.applied.fingerprint, version: '9.9.9' };
    saveState(storage, s1);
    assert.equal(alreadyConverged(want, storage, located.located), false);

    const s2 = loadState(storage);
    assert.ok(s2.applied);
    s2.applied.fingerprint = { ...s2.applied.fingerprint, commit: 'deadbeef' };
    saveState(storage, s2);
    assert.equal(alreadyConverged(want, storage, located.located), false);

    // Marker gone: the applied record alone is not the converged shape.
    const s3 = loadState(storage);
    assert.ok(s3.applied);
    s3.applied.fingerprint = located.located.fingerprint;
    saveState(storage, s3);
    fs.rmSync(markerPath(tree.mediaDir), { force: true });
    assert.equal(alreadyConverged(want, storage, located.located), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('converge native on an untouched site is none with zero writes', async () => {
  const root = makeTempRoot();
  try {
    const tree = buildInstallTree(root);
    const located = locate(tree.appRoot, '');
    assert.ok(located.ok);
    const storage = path.join(root, 'store');
    fs.mkdirSync(storage, { recursive: true });
    const beforeMedia = snapshotTree(tree.mediaDir);
    const beforeStore = snapshotTree(storage);

    const r = await convergeToExpected(located.located, storage, 'w1', undefined, {
      kind: 'native',
    });

    assert.ok(r.ok);
    assert.ok(r.ok && r.action === 'none');
    assertTreeUntouched(tree.mediaDir, beforeMedia);
    assertTreeUntouched(storage, beforeStore);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('converge native on a replaced site restores every official file', async () => {
  const root = makeTempRoot();
  try {
    const tree = buildInstallTree(root);
    const located = locate(tree.appRoot, '');
    assert.ok(located.ok);
    const storage = path.join(root, 'store');
    const rp = makePack(storage, 'pack-a', {
      error: 'sounds/error.wav',
      save: 'sounds/save.wav',
    });
    assert.ok(rp.ok);
    assert.ok(applyPack(located.located, rp.pack, storage, 'w1').ok);

    const r = await convergeToExpected(located.located, storage, 'w1', undefined, {
      kind: 'native',
    });

    assert.ok(r.ok);
    assert.ok(r.ok && r.action === 'restored');
    // Each media file lands byte for byte on the recorded backup content.
    const manifest = loadBackupManifest(
      backupDirFor(storage, located.located.fingerprint)
    );
    for (const name of Object.keys(manifest.files)) {
      assert.equal(
        sha256File(path.join(tree.mediaDir, name)),
        manifest.files[name],
        name
      );
    }
    // Which is also the pristine official payload.
    assert.equal(sha256File(path.join(tree.mediaDir, 'error.mp3')), officialHash('error.mp3'));
    assert.equal(sha256File(path.join(tree.mediaDir, 'success.mp3')), officialHash('success.mp3'));
    assert.equal(readMarker(tree.mediaDir), undefined);
    assert.equal(fs.existsSync(markerPath(tree.mediaDir)), false);
    assert.equal(loadState(storage).applied, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('converge native restores when only the marker survived the ledger', async () => {
  const root = makeTempRoot();
  try {
    const tree = buildInstallTree(root);
    const located = locate(tree.appRoot, '');
    assert.ok(located.ok);
    const storage = path.join(root, 'store');
    const rp = makePack(storage, 'pack-a', { error: 'sounds/error.wav' });
    assert.ok(rp.ok);
    assert.ok(applyPack(located.located, rp.pack, storage, 'w1').ok);
    const s = loadState(storage);
    s.applied = null;
    saveState(storage, s);

    const r = await convergeToExpected(located.located, storage, 'w1', undefined, {
      kind: 'native',
    });

    assert.ok(r.ok);
    assert.ok(r.ok && r.action === 'restored');
    assert.equal(sha256File(path.join(tree.mediaDir, 'error.mp3')), officialHash('error.mp3'));
    assert.equal(readMarker(tree.mediaDir), undefined);
    assert.equal(loadState(storage).applied, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('converge pack on the matching applied site is none with zero writes', async () => {
  const root = makeTempRoot();
  try {
    const tree = buildInstallTree(root);
    const located = locate(tree.appRoot, '');
    assert.ok(located.ok);
    const storage = path.join(root, 'store');
    const rp = makePack(storage, 'pack-a', { error: 'sounds/error.wav' });
    assert.ok(rp.ok);
    assert.ok(applyPack(located.located, rp.pack, storage, 'w1').ok);
    const beforeMedia = snapshotTree(tree.mediaDir);
    const beforeStore = snapshotTree(storage);

    const r = await convergeToExpected(located.located, storage, 'w1', undefined, {
      kind: 'pack',
      packId: 'pack-a',
    });

    assert.ok(r.ok);
    assert.ok(r.ok && r.action === 'none');
    assertTreeUntouched(tree.mediaDir, beforeMedia);
    assertTreeUntouched(storage, beforeStore);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('converge pack onto a native site reapplies the pack', async () => {
  const root = makeTempRoot();
  try {
    const tree = buildInstallTree(root);
    const located = locate(tree.appRoot, '');
    assert.ok(located.ok);
    const storage = path.join(root, 'store');
    const rp = makePack(storage, 'pack-a', {
      error: 'sounds/error.wav',
      save: 'sounds/save.wav',
    });
    assert.ok(rp.ok);

    const r = await convergeToExpected(located.located, storage, 'w1', undefined, {
      kind: 'pack',
      packId: 'pack-a',
    });

    assert.ok(r.ok);
    assert.ok(r.ok && r.action === 'reapplied');
    // Declared slots carry the pack audio.
    assert.equal(
      sha256File(path.join(tree.mediaDir, 'error.mp3')),
      sha256File(path.join(rp.pack.dir, 'sounds', 'error.wav'))
    );
    assert.equal(
      sha256File(path.join(tree.mediaDir, 'save.mp3')),
      sha256File(path.join(rp.pack.dir, 'sounds', 'save.wav'))
    );
    // Everything else keeps the official content, orphan included.
    assert.equal(sha256File(path.join(tree.mediaDir, 'format.mp3')), officialHash('format.mp3'));
    assert.equal(sha256File(path.join(tree.mediaDir, 'success.mp3')), officialHash('success.mp3'));
    const marker = readMarker(tree.mediaDir);
    assert.notEqual(marker, undefined);
    assert.ok(marker !== undefined && marker.packId === 'pack-a');
    assert.equal(loadState(storage).applied?.packId, 'pack-a');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('converge pack over an older pack recomputes the whole surface', async () => {
  const root = makeTempRoot();
  try {
    const tree = buildInstallTree(root);
    const located = locate(tree.appRoot, '');
    assert.ok(located.ok);
    const storage = path.join(root, 'store');
    const rb = makePack(storage, 'pack-b', { save: 'sounds/save-old.wav' });
    assert.ok(rb.ok);
    assert.ok(applyPack(located.located, rb.pack, storage, 'w1').ok);
    const ra = makePack(storage, 'pack-a', { error: 'sounds/error.wav' });
    assert.ok(ra.ok);

    const r = await convergeToExpected(located.located, storage, 'w1', undefined, {
      kind: 'pack',
      packId: 'pack-a',
    });

    assert.ok(r.ok);
    assert.ok(r.ok && r.action === 'reapplied');
    assert.equal(
      sha256File(path.join(tree.mediaDir, 'error.mp3')),
      sha256File(path.join(ra.pack.dir, 'sounds', 'error.wav'))
    );
    // The old pack slot is reset to official, not left behind.
    assert.equal(sha256File(path.join(tree.mediaDir, 'save.mp3')), officialHash('save.mp3'));
    const state = loadState(storage);
    assert.equal(state.applied?.packId, 'pack-a');
    assert.equal(state.activePackId, 'pack-a');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('converge with a missing pack id surfaces relayout.packMissing', async () => {
  const root = makeTempRoot();
  try {
    const tree = buildInstallTree(root);
    const located = locate(tree.appRoot, '');
    assert.ok(located.ok);
    const storage = path.join(root, 'store');
    const rp = makePack(storage, 'pack-a', { error: 'sounds/error.wav' });
    assert.ok(rp.ok);
    assert.ok(applyPack(located.located, rp.pack, storage, 'w1').ok);

    const r = await convergeToExpected(located.located, storage, 'w1', undefined, {
      kind: 'pack',
      packId: 'ghost',
    });

    assert.equal(r.ok, false);
    assert.ok(!r.ok && r.error.key === 'relayout.packMissing');
    assert.ok(!r.ok && r.error.args[0] === 'ghost');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('converge native without a backup surfaces restore.noBackup', async () => {
  const root = makeTempRoot();
  try {
    const tree = buildInstallTree(root);
    const located = locate(tree.appRoot, '');
    assert.ok(located.ok);
    const storage = path.join(root, 'store');
    const rp = makePack(storage, 'pack-a', { error: 'sounds/error.wav' });
    assert.ok(rp.ok);
    assert.ok(applyPack(located.located, rp.pack, storage, 'w1').ok);
    fs.rmSync(path.join(storage, 'backup'), { recursive: true, force: true });

    const r = await convergeToExpected(located.located, storage, 'w1', undefined, {
      kind: 'native',
    });

    assert.equal(r.ok, false);
    assert.ok(!r.ok && r.error.key === 'restore.noBackup');
    // Refusal happens before any mutation: the site still reads replaced.
    assert.notEqual(readMarker(tree.mediaDir), undefined);
    assert.notEqual(loadState(storage).applied, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('converge native with a corrupted backup surfaces restore.noBackup', async () => {
  const root = makeTempRoot();
  try {
    const tree = buildInstallTree(root);
    const located = locate(tree.appRoot, '');
    assert.ok(located.ok);
    const storage = path.join(root, 'store');
    const rp = makePack(storage, 'pack-a', { error: 'sounds/error.wav' });
    assert.ok(rp.ok);
    assert.ok(applyPack(located.located, rp.pack, storage, 'w1').ok);
    fs.writeFileSync(
      path.join(backupDirFor(storage, located.located.fingerprint), 'error.mp3'),
      fakeMp3('corrupted-backup-copy')
    );

    const r = await convergeToExpected(located.located, storage, 'w1', undefined, {
      kind: 'native',
    });

    assert.equal(r.ok, false);
    assert.ok(!r.ok && r.error.key === 'restore.noBackup');
    assert.notEqual(readMarker(tree.mediaDir), undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('converge waits out a lock held by another window instead of failing', async () => {
  const root = makeTempRoot();
  try {
    const tree = buildInstallTree(root);
    const located = locate(tree.appRoot, '');
    assert.ok(located.ok);
    const storage = path.join(root, 'store');
    const rp = makePack(storage, 'pack-a', { error: 'sounds/error.wav' });
    assert.ok(rp.ok);
    assert.ok(applyPack(located.located, rp.pack, storage, 'w1').ok);
    const lockFile = path.join(storage, LOCK_NAME);
    fs.writeFileSync(lockFile, JSON.stringify({ owner: 'someone-else', at: Date.now() }));

    let settled = false;
    const p = convergeToExpected(located.located, storage, 'w2', undefined, {
      kind: 'native',
    }).then((v) => {
      settled = true;
      return v;
    });

    // Half a second into the hold: no early return, no write to the site.
    await sleepReal(500);
    assert.equal(settled, false);
    assert.equal(fs.existsSync(lockFile), true);
    assert.notEqual(readMarker(tree.mediaDir), undefined);

    // The other window finishes and drops its lock.
    fs.unlinkSync(lockFile);
    const r = await p;
    assert.ok(r.ok);
    assert.ok(r.ok && r.action === 'restored');
    assert.equal(readMarker(tree.mediaDir), undefined);
    assert.equal(loadState(storage).applied, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// The bounded retry window is about ten real seconds (LOCK_RETRY_LIMIT of 40
// times 250 ms). Driving it with node:test mock timers keeps the case fast:
// the engine's sleep uses the bare global setTimeout, so ticking the mocked
// clock runs every retry against the very lock file on disk.
test('converge surfaces lock.busy after bounded retries, never stealing the lock', async () => {
  const root = makeTempRoot();
  try {
    const tree = buildInstallTree(root);
    const located = locate(tree.appRoot, '');
    assert.ok(located.ok);
    const storage = path.join(root, 'store');
    const rp = makePack(storage, 'pack-a', { error: 'sounds/error.wav' });
    assert.ok(rp.ok);
    assert.ok(applyPack(located.located, rp.pack, storage, 'w1').ok);
    const lockFile = path.join(storage, LOCK_NAME);
    fs.writeFileSync(lockFile, JSON.stringify({ owner: 'someone-else', at: Date.now() }));
    const beforeMedia = snapshotTree(tree.mediaDir);

    let outcome: ConvergeOutcome | undefined;
    let result: ConvergeOutcome;
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const p = convergeToExpected(located.located, storage, 'w2', undefined, {
        kind: 'native',
      }).then((v) => {
        outcome = v;
        return v;
      });

      // A few retries in: still waiting, nothing written, no early answer.
      for (let i = 0; i < 3; i++) {
        mock.timers.tick(250);
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      assert.equal(outcome, undefined, 'converge gave up before the retry window closed');
      assertTreeUntouched(tree.mediaDir, beforeMedia);

      // Run out the full bounded window (41 sleeps cover attempt 0..40).
      for (let i = 0; i < 48 && outcome === undefined; i++) {
        mock.timers.tick(250);
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      assert.notEqual(outcome, undefined, 'the bounded retry window never closed');
      result = await p;
    } finally {
      mock.timers.reset();
    }

    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.error.key === 'lock.busy');
    // The whole wait cost zero writes and the holder's lock was never taken.
    assertTreeUntouched(tree.mediaDir, beforeMedia);
    assert.equal(fs.existsSync(lockFile), true);
    assert.equal(JSON.parse(fs.readFileSync(lockFile, 'utf8')).owner, 'someone-else');
    assert.notEqual(loadState(storage).applied, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
