import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as path from 'node:path';
import { locate } from '../src/engine/locate';
import { applyPack } from '../src/engine/replace';
import { restoreFromSnapshot } from '../src/engine/uninstall-restore';
import { snapshotState } from '../src/engine/backup';
import { readMarker } from '../src/engine/backup';
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

interface Setup {
  root: string;
  tree: ReturnType<typeof buildInstallTree>;
  extensionDir: string;
  storage: string;
  apply(slots: Record<string, string>, id: string): void;
}

function setup(): Setup {
  const root = makeTempRoot();
  const tree = buildInstallTree(root);
  const s: Setup = {
    root,
    tree,
    extensionDir: path.join(root, 'ext'),
    storage: path.join(root, 'store'),
    apply(slots, id) {
      const located = locate(tree.appRoot, '');
      assert.ok(located.ok);
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
      const rp = readPack(dir);
      assert.ok(rp.ok);
      const r = applyPack(located.located, rp.pack, s.storage, 'w1', s.extensionDir);
      assert.ok(r.ok);
    },
  };
  return s;
}

test('apply writes the uninstall snapshot next to the engine output', () => {
  const s = setup();
  try {
    s.apply({ error: 'sounds/error.wav' }, 'pack-a');
    const snapDir = path.join(s.extensionDir, 'out', 'restore');
    assert.equal(fs.existsSync(path.join(snapDir, 'snapshot.json')), true);
    const names = fs.readdirSync(snapDir).filter((n) => n !== 'snapshot.json');
    assert.equal(names.length, 32);
    assert.equal(names.includes('success.mp3'), true);
    assert.equal(snapshotState(s.extensionDir), 'ok');
  } finally {
    fs.rmSync(s.root, { recursive: true, force: true });
  }
});

test('hook restore lays officials back, clears the marker, exits 0', () => {
  const s = setup();
  try {
    s.apply({ error: 'sounds/error.wav', save: 'sounds/save.wav' }, 'pack-a');
    assert.notEqual(readMarker(s.tree.mediaDir), undefined);
    const out = restoreFromSnapshot(s.extensionDir);
    assert.deepEqual(out, { code: 0 });
    for (const name of OFFICIAL_FILES) {
      assert.equal(sha256File(path.join(s.tree.mediaDir, name)), officialHash(name), name);
    }
    assert.equal(readMarker(s.tree.mediaDir), undefined);
  } finally {
    fs.rmSync(s.root, { recursive: true, force: true });
  }
});

test('missing snapshot exits 1 and leaves the site untouched', () => {
  const s = setup();
  try {
    s.apply({ error: 'sounds/error.wav' }, 'pack-a');
    fs.rmSync(path.join(s.extensionDir, 'out', 'restore'), { recursive: true, force: true });
    const out = restoreFromSnapshot(s.extensionDir);
    assert.deepEqual(out, { code: 1, why: 'snapshot.missing' });
    assert.equal(
      sha256File(path.join(s.tree.mediaDir, 'error.mp3')),
      sha256File(path.join(s.root, 'packs', 'pack-a', 'sounds', 'error.wav'))
    );
  } finally {
    fs.rmSync(s.root, { recursive: true, force: true });
  }
});

test('broken snapshot exits 1 and leaves the site untouched', () => {
  const s = setup();
  try {
    s.apply({ error: 'sounds/error.wav' }, 'pack-a');
    fs.writeFileSync(
      path.join(s.extensionDir, 'out', 'restore', 'snapshot.json'),
      'garbage'
    );
    const out = restoreFromSnapshot(s.extensionDir);
    assert.deepEqual(out, { code: 1, why: 'snapshot.bad' });
  } finally {
    fs.rmSync(s.root, { recursive: true, force: true });
  }
});

test('tampered snapshot file exits 2 on verification', () => {
  const s = setup();
  try {
    s.apply({ error: 'sounds/error.wav' }, 'pack-a');
    fs.appendFileSync(
      path.join(s.extensionDir, 'out', 'restore', 'error.mp3'),
      'x'
    );
    const out = restoreFromSnapshot(s.extensionDir);
    assert.deepEqual(out, { code: 2, why: 'snapshot.verifyFailed' });
  } finally {
    fs.rmSync(s.root, { recursive: true, force: true });
  }
});

test('stale media dir re-resolves through the install root', () => {
  const s = setup();
  try {
    s.apply({ error: 'sounds/error.wav' }, 'pack-a');
    const oldDir = path.join(s.tree.installRoot, s.tree.versionDir);
    const newDirName = 'aaaaaa9999';
    const newDir = path.join(s.tree.installRoot, newDirName);
    fs.mkdirSync(path.dirname(newDir), { recursive: true });
    fs.renameSync(oldDir, newDir);
    fs.writeFileSync(
      path.join(s.tree.installRoot, 'bin', 'code'),
      '#!/bin/sh\nVERSIONFOLDER="' + newDirName + '"\n'
    );
    const out = restoreFromSnapshot(s.extensionDir);
    assert.deepEqual(out, { code: 0 });
    const newMedia = path.join(
      newDir, 'resources', 'app', 'out', 'vs', 'platform', 'accessibilitySignal', 'browser', 'media'
    );
    assert.equal(sha256File(path.join(newMedia, 'error.mp3')), officialHash('error.mp3'));
  } finally {
    fs.rmSync(s.root, { recursive: true, force: true });
  }
});

test('site completely gone exits 1', () => {
  const s = setup();
  try {
    s.apply({ error: 'sounds/error.wav' }, 'pack-a');
    fs.rmSync(path.join(s.extensionDir, 'out', 'restore'), { recursive: true, force: true });
    fs.rmSync(s.tree.installRoot, { recursive: true, force: true });
    const out = restoreFromSnapshot(s.extensionDir);
    assert.equal(out.code, 1);
  } finally {
    fs.rmSync(s.root, { recursive: true, force: true });
  }
});
