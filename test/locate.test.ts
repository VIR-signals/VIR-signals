import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { locate } from '../src/engine/locate';
import { buildInstallTree, makeTempRoot } from './helpers';

test('locates media dir and fingerprint from the running app root', () => {
  const root = makeTempRoot();
  try {
    const tree = buildInstallTree(root);
    const r = locate(tree.appRoot, '');
    assert.ok(r.ok);
    assert.equal(r.located.mediaDir, tree.mediaDir);
    assert.equal(r.located.versionDir, tree.versionDir);
    assert.equal(r.located.fingerprint.version, '1.143.1');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('bin sh VERSIONFOLDER alone is enough', () => {
  const root = makeTempRoot();
  try {
    const tree = buildInstallTree(root);
    fs.rmSync(path.join(tree.installRoot, 'bin', 'code.cmd'));
    const r = locate(tree.appRoot, '');
    assert.ok(r.ok);
    assert.equal(r.located.versionDir, tree.versionDir);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('code.cmd path pattern resolves when sh pointer is gone', () => {
  const root = makeTempRoot();
  try {
    const tree = buildInstallTree(root);
    fs.rmSync(path.join(tree.installRoot, 'bin', 'code'));
    const r = locate(tree.appRoot, '');
    assert.ok(r.ok);
    assert.equal(r.located.versionDir, tree.versionDir);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('commit prefix dir resolves when both bin scripts are gone', () => {
  const root = makeTempRoot();
  try {
    const tree = buildInstallTree(root);
    fs.rmSync(path.join(tree.installRoot, 'bin'), { recursive: true, force: true });
    const r = locate(tree.appRoot, '');
    assert.ok(r.ok);
    assert.equal(r.located.versionDir, tree.versionDir);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('no resolvable version dir is a loud error', () => {
  const root = makeTempRoot();
  try {
    const tree = buildInstallTree(root);
    fs.rmSync(path.join(tree.installRoot, 'bin'), { recursive: true, force: true });
    fs.rmSync(path.join(tree.appRoot, 'product.json'));
    const r = locate(tree.appRoot, '');
    assert.equal(r.ok, false);
    assert.ok(!r.ok && r.error.key === 'locate.noVersionDir');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// Chapter 5 contract: a variant shipping fewer files still locates; the
// absent files are reported as missing so their slots keep official sound.
// A directory with none of the official files remains a loud failure.
test('incomplete media set locates and reports the missing files', () => {
  const root = makeTempRoot();
  try {
    const tree = buildInstallTree(root);
    fs.rmSync(path.join(tree.mediaDir, 'save.mp3'));
    const r = locate(tree.appRoot, '');
    assert.equal(r.ok, true);
    assert.ok(r.ok);
    assert.ok(r.located.missingFiles.includes('save.mp3'));
    assert.ok(!r.located.presentFiles.includes('save.mp3'));
    assert.ok(r.located.presentFiles.length > 0);
    for (const f of fs.readdirSync(tree.mediaDir)) {
      fs.rmSync(path.join(tree.mediaDir, f));
    }
    const empty = locate(tree.appRoot, '');
    assert.equal(empty.ok, false);
    assert.ok(!empty.ok && empty.error.key === 'locate.mediaMissing');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('store edition path is rejected', () => {
  const root = makeTempRoot();
  try {
    const storeDir = path.join(root, 'WindowsApps', 'Microsoft.VisualStudio.Code');
    fs.mkdirSync(storeDir, { recursive: true });
    const r = locate('nowhere', storeDir);
    assert.equal(r.ok, false);
    assert.ok(!r.ok && r.error.key === 'locate.storeEdition');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('manual install path targets that install', () => {
  const root = makeTempRoot();
  try {
    const treeA = buildInstallTree(root, 'aaaaaa1111');
    const treeB = buildInstallTree(root, 'bbbbbb2222', 'bbbbbb2222' + 'ffffffffff');
    const r = locate(treeA.appRoot, treeB.installRoot);
    assert.ok(r.ok);
    assert.equal(r.located.mediaDir, treeB.mediaDir);
    assert.equal(r.located.versionDir, 'bbbbbb2222');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('junctioned manual path resolves to the real install', () => {
  const root = makeTempRoot();
  try {
    const tree = buildInstallTree(root);
    const junction = path.join(root, 'current');
    fs.symlinkSync(tree.installRoot, junction, 'junction');
    const r = locate(tree.appRoot, junction);
    assert.ok(r.ok);
    assert.equal(r.located.installRoot, fs.realpathSync(tree.installRoot));
    assert.equal(r.located.versionDir, tree.versionDir);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
