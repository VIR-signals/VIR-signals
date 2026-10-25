import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { locate } from '../src/engine/locate';
import {
  backupDirFor,
  deleteBackup,
  readMarker,
  takeBackup,
  verifyBackup,
  writeMarker,
} from '../src/engine/backup';
import { BACKUP_MANIFEST_NAME, MARKER_NAME } from '../src/engine/paths';
import { sha256File } from '../src/engine/fsutil';
import { buildInstallTree, makeTempRoot } from './helpers';

test('backup captures every official file with read back checks', () => {
  const root = makeTempRoot();
  try {
    const tree = buildInstallTree(root);
    const located = locate(tree.appRoot, '');
    assert.ok(located.ok);
    const storage = path.join(root, 'store');
    const r = takeBackup(located.located, storage);
    assert.ok(r.ok);
    assert.ok(r.ok && r.fileCount === 32);
    assert.ok(r.ok && r.manifest.files['success.mp3'] !== undefined);
    assert.ok(r.ok && r.manifest.files['error.mp3'] !== undefined);
    const verify = verifyBackup(backupDirFor(storage, located.located.fingerprint));
    assert.ok(verify.ok);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('backup hashes equal the live official files', () => {
  const root = makeTempRoot();
  try {
    const tree = buildInstallTree(root);
    const located = locate(tree.appRoot, '');
    assert.ok(located.ok);
    const storage = path.join(root, 'store');
    const r = takeBackup(located.located, storage);
    assert.ok(r.ok);
    assert.ok(r.ok);
    assert.equal(r.manifest.files['save.mp3'], sha256File(path.join(tree.mediaDir, 'save.mp3')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('marker on site refuses the backup', () => {
  const root = makeTempRoot();
  try {
    const tree = buildInstallTree(root);
    writeMarker(tree.mediaDir, { packId: 'p', at: Date.now(), version: '1.143.1' });
    const located = locate(tree.appRoot, '');
    assert.ok(located.ok);
    const r = takeBackup(located.located, path.join(root, 'store'));
    assert.equal(r.ok, false);
    assert.ok(!r.ok && r.error.key === 'backup.blocked');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('unreadable marker still counts as present', () => {
  const root = makeTempRoot();
  try {
    const tree = buildInstallTree(root);
    fs.writeFileSync(path.join(tree.mediaDir, MARKER_NAME), 'junk');
    assert.notEqual(readMarker(tree.mediaDir), undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('corrupted backup copy fails verification', () => {
  const root = makeTempRoot();
  try {
    const tree = buildInstallTree(root);
    const located = locate(tree.appRoot, '');
    assert.ok(located.ok);
    const storage = path.join(root, 'store');
    const r = takeBackup(located.located, storage);
    assert.ok(r.ok);
    assert.ok(r.ok);
    fs.appendFileSync(path.join(r.dir, 'save.mp3'), 'x');
    const v = verifyBackup(r.dir);
    assert.equal(v.ok, false);
    assert.ok(!v.ok && v.error.key === 'backup.verifyFailed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('missing backup directory fails verification', () => {
  const root = makeTempRoot();
  try {
    const v = verifyBackup(path.join(root, 'nope'));
    assert.equal(v.ok, false);
    assert.ok(!v.ok && v.error.key === 'backup.absent');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a new fingerprint backup replaces the old one', () => {
  const root = makeTempRoot();
  try {
    const treeA = buildInstallTree(root, 'aaaaaa1111');
    const locatedA = locate(treeA.appRoot, '');
    assert.ok(locatedA.ok);
    const storage = path.join(root, 'store');
    assert.ok(takeBackup(locatedA.located, storage).ok);

    const treeB = buildInstallTree(root, 'bbbbbb2222', 'bbbbbb2222' + 'ffffffffff');
    const locatedB = locate(treeB.appRoot, '');
    assert.ok(locatedB.ok);
    assert.ok(takeBackup(locatedB.located, storage).ok);

    const backupRoot = path.join(storage, 'backup');
    const remaining = fs.readdirSync(backupRoot);
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0], '1.143.1-bbbbbb2222');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('delete backup removes the whole backup area', () => {
  const root = makeTempRoot();
  try {
    const tree = buildInstallTree(root);
    const located = locate(tree.appRoot, '');
    assert.ok(located.ok);
    const storage = path.join(root, 'store');
    assert.ok(takeBackup(located.located, storage).ok);
    const dir = backupDirFor(storage, located.located.fingerprint);
    assert.equal(fs.existsSync(path.join(dir, BACKUP_MANIFEST_NAME)), true);
    deleteBackup(storage);
    assert.equal(fs.existsSync(path.join(storage, 'backup')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
