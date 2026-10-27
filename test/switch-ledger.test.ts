// Behavior nails for the master switch flag on the state ledger. The switch
// lives in vir-state.json (VirState.enabled), never in editor settings, so
// the read must be lenient for ledgers written by older builds and the write
// must round trip both directions. Mirrors test/ledger.test.ts: node:test
// with a temp root per case.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { freshState, loadState, saveState, statePath } from '../src/engine/ledger';
import { makeTempRoot } from './helpers';

// Write a raw ledger object to disk, bypassing saveState, so the read path
// faces bytes we fully control (old-build shapes included).
function writeRawLedger(root: string, raw: unknown): void {
  fs.writeFileSync(statePath(root), JSON.stringify(raw, null, 2));
}

test('freshState defaults the switch to enabled', () => {
  const s = freshState();
  assert.equal(s.enabled, true);
  assert.equal(typeof s.enabled, 'boolean');
});

test('a disk ledger without an enabled field loads as enabled', () => {
  // Ledgers written before the switch existed must not boot the extension
  // disabled: absence reads as true.
  const root = makeTempRoot();
  try {
    writeRawLedger(root, { schemaVersion: 1, activePackId: 'demo' });
    const s = loadState(root);
    assert.equal(s.enabled, true);
    // The rest of the ledger still loads normally.
    assert.equal(s.activePackId, 'demo');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a disk ledger with enabled false loads as disabled', () => {
  const root = makeTempRoot();
  try {
    writeRawLedger(root, { schemaVersion: 1, enabled: false, activePackId: 'demo' });
    const s = loadState(root);
    assert.equal(s.enabled, false);
    // Disabling does not drop the selection.
    assert.equal(s.activePackId, 'demo');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a non-boolean enabled field loads leniently as enabled', () => {
  // Corrupt or foreign-typed values must not be interpreted as false: only
  // the literal boolean false disables the switch.
  const badValues = ['false', 'true', 0, 1, null, 'off', []];
  for (const bad of badValues) {
    const root = makeTempRoot();
    try {
      writeRawLedger(root, { schemaVersion: 1, enabled: bad });
      assert.equal(loadState(root).enabled, true, `enabled: ${JSON.stringify(bad)}`);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test('saveState round trips an enabled switch as true', () => {
  const root = makeTempRoot();
  try {
    const s = freshState();
    s.enabled = true;
    saveState(root, s);
    assert.equal(loadState(root).enabled, true);
    // The persisted bytes carry the boolean, not a coerced stand-in.
    const onDisk = JSON.parse(fs.readFileSync(statePath(root), 'utf8')) as { enabled: unknown };
    assert.equal(onDisk.enabled, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('saveState round trips a disabled switch as false', () => {
  const root = makeTempRoot();
  try {
    const s = freshState();
    s.enabled = false;
    s.activePackId = 'demo';
    saveState(root, s);
    const back = loadState(root);
    assert.equal(back.enabled, false);
    assert.equal(back.activePackId, 'demo');
    const onDisk = JSON.parse(fs.readFileSync(statePath(root), 'utf8')) as { enabled: unknown };
    assert.equal(onDisk.enabled, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
