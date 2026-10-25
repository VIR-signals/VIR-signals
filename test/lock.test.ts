import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { LOCK_NAME, LOCK_STALE_MS } from '../src/engine/paths';
import { acquireLock, releaseLock } from '../src/engine/lock';
import { makeTempRoot } from './helpers';

test('first acquire wins, second owner is told busy', () => {
  const root = makeTempRoot();
  try {
    const a = acquireLock(root, 'window-a');
    assert.ok(a.ok);
    const b = acquireLock(root, 'window-b');
    assert.equal(b.ok, false);
    assert.ok(!b.ok && b.error.key === 'lock.busy');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('stale lock is reclaimed', () => {
  const root = makeTempRoot();
  try {
    fs.writeFileSync(
      path.join(root, LOCK_NAME),
      JSON.stringify({ owner: 'ghost', at: Date.now() - LOCK_STALE_MS - 1000 })
    );
    const a = acquireLock(root, 'window-a');
    assert.ok(a.ok);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('fresh foreign lock is not reclaimed', () => {
  const root = makeTempRoot();
  try {
    const a = acquireLock(root, 'window-a');
    assert.ok(a.ok);
    const b = acquireLock(root, 'window-b');
    assert.equal(b.ok, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('release only works for the owner', () => {
  const root = makeTempRoot();
  try {
    assert.ok(acquireLock(root, 'window-a').ok);
    releaseLock(root, 'window-b');
    assert.equal(fs.existsSync(path.join(root, LOCK_NAME)), true);
    releaseLock(root, 'window-a');
    assert.equal(fs.existsSync(path.join(root, LOCK_NAME)), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('lock can be reacquired after release', () => {
  const root = makeTempRoot();
  try {
    assert.ok(acquireLock(root, 'window-a').ok);
    releaseLock(root, 'window-a');
    assert.ok(acquireLock(root, 'window-b').ok);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
