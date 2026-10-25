import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { freshState, loadState, saveState, statePath } from '../src/engine/ledger';
import { makeTempRoot } from './helpers';

test('missing state file yields the fresh default', () => {
  const root = makeTempRoot();
  try {
    const s = loadState(root);
    assert.deepEqual(s, freshState());
    assert.equal(s.stageOneDone, false);
    assert.equal(s.stageTwoDone, false);
    assert.equal(s.applied, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('save then load round trips the whole state', () => {
  const root = makeTempRoot();
  try {
    const s = freshState();
    s.stageOneDone = true;
    s.stageOneOwner = 'session-a';
    s.activePackId = 'demo';
    s.signalToggles['accessibility.signals.save'] = { sound: 'auto' };
    s.applied = {
      packId: 'demo',
      packName: 'Demo',
      fingerprint: { version: '1.143.1', commit: 'e646868227' },
      versionDir: 'e646868227',
      mediaDir: 'd://editor//media',
      installRoot: 'd://editor',
      files: { 'save.mp3': 'abc' },
      appliedAt: '2026-10-26T00:00:00.000Z',
    };
    saveState(root, s);
    assert.deepEqual(loadState(root), s);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('corrupt state file fails loudly', () => {
  const root = makeTempRoot();
  try {
    fs.writeFileSync(statePath(root), '{oops');
    assert.throws(() => loadState(root));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('unknown schema version fails loudly', () => {
  const root = makeTempRoot();
  try {
    fs.writeFileSync(statePath(root), JSON.stringify({ schemaVersion: 2 }));
    assert.throws(() => loadState(root), /state.schemaUnknown/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('atomic write leaves no temp sibling', () => {
  const root = makeTempRoot();
  try {
    saveState(root, freshState());
    const leftovers = fs.readdirSync(root).filter((n) => n.includes('vir-tmp'));
    assert.deepEqual(leftovers, []);
    assert.equal(path.basename(statePath(root)), 'vir-state.json');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
