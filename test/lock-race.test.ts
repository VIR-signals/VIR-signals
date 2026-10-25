// Regression tests for the reclaim race in the cross window lock: the stale
// reclaim path re-reads the lock identity right before the delete, and a
// delete that loses to another window (ENOENT) must not crash the caller.
// Timing holes are injected by patching fs on the shared module object,
// the same technique replace.test.ts uses for renameSync.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as path from 'node:path';
import { LOCK_NAME, LOCK_STALE_MS } from '../src/engine/paths';
import { acquireLock, releaseLock } from '../src/engine/lock';
import { makeTempRoot } from './helpers';

test('reclaim spares a lock another window recreated after the staleness judgment', () => {
  const root = makeTempRoot();
  const origRead = fs.readFileSync;
  try {
    const lockFile = path.join(root, LOCK_NAME);
    const staleRaw = JSON.stringify({
      owner: 'ghost',
      at: Date.now() - LOCK_STALE_MS - 60000,
    });
    const freshRaw = JSON.stringify({ owner: 'live-window', at: Date.now() });
    // The other window already replaced the stale lock on disk. The patch
    // feeds the judgment read the pre-replacement payload, so this window
    // still judges the lock stale and enters the reclaim path.
    fs.writeFileSync(lockFile, freshRaw);
    let reads = 0;
    const patched = function (p: unknown, opts: unknown) {
      if (String(p) !== lockFile) {
        return origRead(p as never, opts as never);
      }
      reads += 1;
      return reads === 1 ? staleRaw : freshRaw;
    } as typeof fs.readFileSync;
    fs.readFileSync = patched;

    const res = acquireLock(root, 'window-a');

    assert.equal(res.ok, false);
    assert.ok(!res.ok && res.error.key === 'lock.busy');
    // The busy report names the current holder, not the stale ghost.
    assert.ok(!res.ok && res.error.args[0] === 'live-window');
    // The recreated lock survives on disk, byte for byte.
    assert.equal(fs.existsSync(lockFile), true);
    assert.equal(origRead(lockFile, 'utf8'), freshRaw);
  } finally {
    fs.readFileSync = origRead;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('reclaim does not crash when another window removed the stale lock first', () => {
  const root = makeTempRoot();
  const origUnlink = fs.unlinkSync;
  try {
    fs.writeFileSync(
      path.join(root, LOCK_NAME),
      JSON.stringify({ owner: 'ghost', at: Date.now() - LOCK_STALE_MS - 60000 })
    );
    const patched = function () {
      const err = new Error('injected race: already removed') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    } as typeof fs.unlinkSync;
    fs.unlinkSync = patched;

    let res: ReturnType<typeof acquireLock> | undefined;
    assert.doesNotThrow(() => {
      res = acquireLock(root, 'window-a');
    });
    assert.ok(res !== undefined);
    // The fake delete never removed the file, so the exclusive create that
    // follows loses with EEXIST and the caller gets a busy result.
    assert.equal(res.ok, false);
    assert.ok(!res.ok && res.error.key === 'lock.busy');
  } finally {
    fs.unlinkSync = origUnlink;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('unparseable lock past the stale window is still reclaimed without patches', () => {
  const root = makeTempRoot();
  try {
    const lockFile = path.join(root, LOCK_NAME);
    fs.writeFileSync(lockFile, 'not-a-lock-json');
    const old = new Date(Date.now() - LOCK_STALE_MS - 30000);
    fs.utimesSync(lockFile, old, old);
    const res = acquireLock(root, 'window-a');
    assert.ok(res.ok);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('release does not crash when another window removed the lock first', () => {
  const root = makeTempRoot();
  const origUnlink = fs.unlinkSync;
  try {
    assert.ok(acquireLock(root, 'window-a').ok);
    const patched = function () {
      const err = new Error('injected race: already removed') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    } as typeof fs.unlinkSync;
    fs.unlinkSync = patched;
    assert.doesNotThrow(() => {
      releaseLock(root, 'window-a');
    });
  } finally {
    fs.unlinkSync = origUnlink;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('release by a previous owner leaves the current holder lock intact', () => {
  const root = makeTempRoot();
  try {
    assert.ok(acquireLock(root, 'window-a').ok);
    releaseLock(root, 'window-a');
    assert.ok(acquireLock(root, 'window-b').ok);
    const lockFile = path.join(root, LOCK_NAME);
    const before = fs.readFileSync(lockFile, 'utf8');
    releaseLock(root, 'window-a');
    assert.equal(fs.existsSync(lockFile), true);
    assert.equal(fs.readFileSync(lockFile, 'utf8'), before);
    assert.equal(JSON.parse(fs.readFileSync(lockFile, 'utf8')).owner, 'window-b');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
