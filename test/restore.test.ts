import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as path from 'node:path';
import { locate } from '../src/engine/locate';
import { applyPack } from '../src/engine/replace';
import { restoreOfficial } from '../src/engine/restore';
import { readMarker } from '../src/engine/backup';
import { loadState } from '../src/engine/ledger';
import { OFFICIAL_FILES } from '../src/engine/slot-table';
import { sha256Buffer, sha256File } from '../src/engine/fsutil';
import { readPack } from '../src/engine/pack-reader';
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

test('restore lays every official file back and clears the applied state', () => {
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
    assert.ok(applyPack(located.located, rp.pack, storage, 'w1').ok);

    const r = restoreOfficial(located.located, storage, 'w1');
    assert.ok(r.ok);
    assert.ok(r.ok && r.fileCount === 32);
    for (const name of OFFICIAL_FILES) {
      assert.equal(sha256File(path.join(tree.mediaDir, name)), officialHash(name), name);
    }
    assert.equal(readMarker(tree.mediaDir), undefined);
    const state = loadState(storage);
    assert.equal(state.applied, null);
    assert.equal(state.activePackId, 'pack-a');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('restore is repeatable', () => {
  const root = makeTempRoot();
  try {
    const tree = buildInstallTree(root);
    const located = locate(tree.appRoot, '');
    assert.ok(located.ok);
    const storage = path.join(root, 'store');
    const rp = makePack(root, 'pack-a', { error: 'sounds/error.wav' });
    assert.ok(rp.ok);
    assert.ok(applyPack(located.located, rp.pack, storage, 'w1').ok);
    assert.ok(restoreOfficial(located.located, storage, 'w1').ok);
    assert.ok(restoreOfficial(located.located, storage, 'w1').ok);
    assert.equal(sha256File(path.join(tree.mediaDir, 'error.mp3')), officialHash('error.mp3'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('restore without a backup refuses', () => {
  const root = makeTempRoot();
  try {
    const tree = buildInstallTree(root);
    const located = locate(tree.appRoot, '');
    assert.ok(located.ok);
    const r = restoreOfficial(located.located, path.join(root, 'store'), 'w1');
    assert.equal(r.ok, false);
    assert.ok(!r.ok && r.error.key === 'restore.noBackup');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('restore resolves a pending transaction first', () => {
  const root = makeTempRoot();
  try {
    const tree = buildInstallTree(root);
    const located = locate(tree.appRoot, '');
    assert.ok(located.ok);
    const storage = path.join(root, 'store');
    const ra = makePack(root, 'pack-a', { error: 'sounds/error.wav' });
    assert.ok(ra.ok);
    assert.ok(applyPack(located.located, ra.pack, storage, 'w1').ok);

    const rb = makePack(root, 'pack-b', { save: 'sounds/save.wav' });
    assert.ok(rb.ok);
    const orig = fs.renameSync;
    fs.renameSync = function (a, b) {
      if (String(a).endsWith('.mp3.vir-tmp')) {
        throw new Error('injected rename failure');
      }
      return orig(a, b);
    } as typeof fs.renameSync;
    const r2 = applyPack(located.located, rb.pack, storage, 'w1');
    fs.renameSync = orig;
    assert.equal(r2.ok, false);

    const r3 = restoreOfficial(located.located, storage, 'w1');
    assert.ok(r3.ok);
    assert.equal(sha256File(path.join(tree.mediaDir, 'error.mp3')), officialHash('error.mp3'));
    assert.equal(sha256File(path.join(tree.mediaDir, 'save.mp3')), officialHash('save.mp3'));
    assert.equal(fs.existsSync(path.join(tree.mediaDir, 'vir-tx.json')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
