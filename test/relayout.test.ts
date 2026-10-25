import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as path from 'node:path';
import { locate } from '../src/engine/locate';
import { applyPack } from '../src/engine/replace';
import { checkVersionDrift, relayoutAfterUpdate } from '../src/engine/relayout';
import { backupDirFor, verifyBackup } from '../src/engine/backup';
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

// Simulate an editor update: a fresh version folder with fresh official
// files, the bin pointer moved to it, optional extra or renamed files.
function addVersion(
  installRoot: string,
  versionDir: string,
  commit: string,
  version: string,
  extra: string[] = []
): string {
  const appRoot = path.join(installRoot, versionDir, 'resources', 'app');
  const mediaDir = path.join(
    appRoot, 'out', 'vs', 'platform', 'accessibilitySignal', 'browser', 'media'
  );
  fs.mkdirSync(mediaDir, { recursive: true });
  fs.writeFileSync(
    path.join(installRoot, 'bin', 'code'),
    '#!/bin/sh\nVERSIONFOLDER="' + versionDir + '"\n'
  );
  fs.writeFileSync(
    path.join(appRoot, 'product.json'),
    JSON.stringify({ version, commit }, null, 2)
  );
  for (const f of OFFICIAL_FILES) {
    fs.writeFileSync(path.join(mediaDir, f), fakeMp3(f + versionDir));
  }
  for (const e of extra) {
    fs.writeFileSync(path.join(mediaDir, e), fakeMp3(e));
  }
  return appRoot;
}

test('no drift while fingerprint and version dir hold still', () => {
  const root = makeTempRoot();
  try {
    const tree = buildInstallTree(root);
    const located = locate(tree.appRoot, '');
    assert.ok(located.ok);
    const storage = path.join(root, 'store');
    const rp = makePack(storage, 'pack-a', { error: 'sounds/error.wav' });
    assert.ok(rp.ok);
    assert.ok(applyPack(located.located, rp.pack, storage, 'w1').ok);
    const d = checkVersionDrift(located.located, storage);
    assert.equal(d.relayoutNeeded, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('fingerprint change relayouts: new backup plus pack over fresh files', () => {
  const root = makeTempRoot();
  try {
    const tree = buildInstallTree(root);
    const located = locate(tree.appRoot, '');
    assert.ok(located.ok);
    const storage = path.join(root, 'store');
    const rp = makePack(storage, 'pack-a', { error: 'sounds/error.wav' });
    assert.ok(rp.ok);
    assert.ok(applyPack(located.located, rp.pack, storage, 'w1').ok);

    const newAppRoot = addVersion(
      tree.installRoot,
      'aaaaaa9999',
      'aaaaaa9999' + '0123456789abcdef',
      '1.144.0'
    );
    const located2 = locate(newAppRoot, '');
    assert.ok(located2.ok);
    const d = checkVersionDrift(located2.located, storage);
    assert.equal(d.relayoutNeeded, true);
    assert.equal(d.reason?.key, 'relayout.fingerprintChanged');

    const r = relayoutAfterUpdate(located2.located, storage, 'w1');
    assert.ok(r.ok);
    assert.ok(r.ok);
    assert.equal(r.report.appliedAgain, true);
    assert.equal(
      sha256File(path.join(located2.located.mediaDir, 'error.mp3')),
      sha256File(path.join(rp.pack.dir, 'sounds', 'error.wav'))
    );
    assert.equal(
      sha256File(path.join(located2.located.mediaDir, 'format.mp3')),
      sha256Buffer(fakeMp3('format.mp3' + 'aaaaaa9999'))
    );
    assert.equal(loadState(storage).applied?.fingerprint.version, '1.144.0');
    const vb = verifyBackup(backupDirFor(storage, located2.located.fingerprint));
    assert.ok(vb.ok);
    assert.ok(vb.ok && vb.manifest.files['format.mp3'] === sha256Buffer(fakeMp3('format.mp3' + 'aaaaaa9999')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('version dir change with the same fingerprint still relayouts', () => {
  const root = makeTempRoot();
  try {
    const tree = buildInstallTree(root);
    const located = locate(tree.appRoot, '');
    assert.ok(located.ok);
    const storage = path.join(root, 'store');
    const rp = makePack(storage, 'pack-a', { save: 'sounds/save.wav' });
    assert.ok(rp.ok);
    assert.ok(applyPack(located.located, rp.pack, storage, 'w1').ok);

    const fp1 = loadState(storage).applied?.fingerprint;
    assert.ok(fp1);
    const newAppRoot = addVersion(tree.installRoot, 'aaaaaa8888', fp1.commit, fp1.version);
    const located2 = locate(newAppRoot, '');
    assert.ok(located2.ok);
    const d = checkVersionDrift(located2.located, storage);
    assert.equal(d.relayoutNeeded, true);
    assert.equal(d.reason?.key, 'relayout.versionDirChanged');

    const r = relayoutAfterUpdate(located2.located, storage, 'w1');
    assert.ok(r.ok);
    assert.ok(r.ok && r.report.appliedAgain === true);
    assert.equal(
      sha256File(path.join(located2.located.mediaDir, 'save.mp3')),
      sha256File(path.join(rp.pack.dir, 'sounds', 'save.wav'))
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('listing diff reports new files then vanished files', () => {
  const root = makeTempRoot();
  try {
    const tree = buildInstallTree(root);
    const located = locate(tree.appRoot, '');
    assert.ok(located.ok);
    const storage = path.join(root, 'store');
    const rp = makePack(storage, 'pack-a', { save: 'sounds/save.wav' });
    assert.ok(rp.ok);
    assert.ok(applyPack(located.located, rp.pack, storage, 'w1').ok);

    const app2 = addVersion(
      tree.installRoot,
      'aaaaaa9999',
      'aaaaaa9999' + '0123456789abcdef',
      '1.144.0',
      ['extraOne.mp3']
    );
    const located2 = locate(app2, '');
    assert.ok(located2.ok);
    const r2 = relayoutAfterUpdate(located2.located, storage, 'w1');
    assert.ok(r2.ok);
    assert.ok(r2.ok && r2.report.newFiles.includes('extraOne.mp3'));
    assert.ok(r2.ok && r2.report.vanishedFiles.length === 0);

    const app3 = addVersion(
      tree.installRoot,
      'aaaaaa7777',
      'aaaaaa7777' + '0123456789abcdef',
      '1.145.0'
    );
    const located3 = locate(app3, '');
    assert.ok(located3.ok);
    const r3 = relayoutAfterUpdate(located3.located, storage, 'w1');
    assert.ok(r3.ok);
    assert.ok(r3.ok && r3.report.vanishedFiles.includes('extraOne.mp3'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('missing pack after an update still refreshes the backup', () => {
  const root = makeTempRoot();
  try {
    const tree = buildInstallTree(root);
    const located = locate(tree.appRoot, '');
    assert.ok(located.ok);
    const storage = path.join(root, 'store');
    const rp = makePack(storage, 'pack-a', { save: 'sounds/save.wav' });
    assert.ok(rp.ok);
    assert.ok(applyPack(located.located, rp.pack, storage, 'w1').ok);
    fs.rmSync(path.join(storage, 'packs'), { recursive: true, force: true });

    const app2 = addVersion(
      tree.installRoot,
      'aaaaaa9999',
      'aaaaaa9999' + '0123456789abcdef',
      '1.144.0'
    );
    const located2 = locate(app2, '');
    assert.ok(located2.ok);
    const r = relayoutAfterUpdate(located2.located, storage, 'w1');
    assert.ok(r.ok);
    assert.ok(r.ok);
    assert.equal(r.report.appliedAgain, false);
    assert.ok(r.report.warnings.some((w) => w.key === 'relayout.packMissing'));
    assert.equal(loadState(storage).applied, null);
    assert.ok(verifyBackup(backupDirFor(storage, located2.located.fingerprint)).ok);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('relayout without applied state refuses', () => {
  const root = makeTempRoot();
  try {
    const tree = buildInstallTree(root);
    const located = locate(tree.appRoot, '');
    assert.ok(located.ok);
    const r = relayoutAfterUpdate(located.located, path.join(root, 'store'), 'w1');
    assert.equal(r.ok, false);
    assert.ok(!r.ok && r.error.key === 'relayout.notApplied');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
