// Platform gate tests with injected probes: every forbidden branch is
// exercised without needing the real machine, plus the supported branches
// (Windows user level, home directory tarball) stay open. The variant
// missing-file behavior of the replacement chain lives here too.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { checkPlatform, GateProbes } from '../src/engine/platform-gate';
import { Located, locate } from '../src/engine/locate';
import { applyPack } from '../src/engine/replace';
import { readPack } from '../src/engine/pack-reader';
import { buildInstallTree, buildPack, makeTempRoot, writePackManifest } from './helpers';

function locatedAt(mediaDir: string): Located {
  return {
    installRoot: 'X:/install',
    versionDir: 'e646868227',
    appRoot: 'X:/install/e646868227/resources/app',
    mediaDir,
    fingerprint: { version: '1.143.1', commit: 'e6468682270123abcdabcdabcdabcdabcdabcd' },
    presentFiles: [],
    missingFiles: [],
  };
}

function probes(
  platform: NodeJS.Platform,
  write: { ok: true } | { ok: false; code: string }
): GateProbes {
  return { platform, writeProbe: () => write };
}

const WIN_OK = probes('win32', { ok: true });
const LINUX_OK = probes('linux', { ok: true });

test('darwin is refused with the macOS reason', () => {
  const r = checkPlatform(locatedAt('/Applications/Visual Studio Code.app/Contents/Resources/app/out/vs/platform/accessibilitySignal/browser/media'), probes('darwin', { ok: true }));
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.error.key, 'platform.macosApp');
  }
});

test('snap positions are refused as read only mounts', () => {
  const r = checkPlatform(locatedAt('/snap/code/123/usr/share/code/resources/app/out/vs/platform/accessibilitySignal/browser/media'), LINUX_OK);
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.error.key, 'platform.readOnlyMount');
    assert.equal(r.error.args[0], 'snap');
  }
});

test('flatpak positions are refused as read only mounts', () => {
  const r = checkPlatform(locatedAt('/var/lib/flatpak/app/com.visualstudio.code/current/active/files/extra/vscode/resources/app/out/vs/platform/accessibilitySignal/browser/media'), LINUX_OK);
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.error.key, 'platform.readOnlyMount');
    assert.equal(r.error.args[0], 'flatpak');
  }
});

test('Windows program files is refused as a system install', () => {
  const r = checkPlatform(
    locatedAt('C:\\Program Files\\Microsoft VS Code\\e646868227\\resources\\app\\out\\vs\\platform\\accessibilitySignal\\browser\\media'),
    WIN_OK
  );
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.error.key, 'platform.systemInstall');
  }
});

test('an EACCES probe on linux reports the system install reason', () => {
  const r = checkPlatform(
    locatedAt('/usr/share/code/resources/app/out/vs/platform/accessibilitySignal/browser/media'),
    probes('linux', { ok: false, code: 'EACCES' })
  );
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.error.key, 'platform.systemInstall');
  }
});

test('an EPERM probe on windows reports the system install reason', () => {
  const r = checkPlatform(
    locatedAt('D:\\tools\\vscode\\resources\\app\\out\\vs\\platform\\accessibilitySignal\\browser\\media'),
    probes('win32', { ok: false, code: 'EPERM' })
  );
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.error.key, 'platform.systemInstall');
  }
});

test('a probe failure that is not elevation is an honest io report', () => {
  const r = checkPlatform(
    locatedAt('C:\\Users\\me\\AppData\\Local\\Programs\\VS Code\\resources\\app\\out\\vs\\platform\\accessibilitySignal\\browser\\media'),
    probes('win32', { ok: false, code: 'ENOSPC' })
  );
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.error.key, 'platform.probeIo');
    assert.equal(r.error.args[0], 'ENOSPC');
  }
});

test('a windows user level install with a passing probe stays open', () => {
  const r = checkPlatform(
    locatedAt('C:\\Users\\me\\AppData\\Local\\Programs\\VS Code\\e646868227\\resources\\app\\out\\vs\\platform\\accessibilitySignal\\browser\\media'),
    WIN_OK
  );
  assert.equal(r.ok, true);
});

test('a home directory tarball on linux stays open', () => {
  const r = checkPlatform(
    locatedAt('/home/me/VSCode-linux-x64/resources/app/out/vs/platform/accessibilitySignal/browser/media'),
    LINUX_OK
  );
  assert.equal(r.ok, true);
});

test('apply skips slot files the editor variant does not ship', () => {
  const root = makeTempRoot();
  try {
    const tree = buildInstallTree(root);
    fs.rmSync(path.join(tree.mediaDir, 'save.mp3'));
    const located = locate(tree.appRoot, '');
    assert.ok(located.ok);
    const packDir = buildPack(root, 'mini', { save: 'sounds/s.wav' });
    writePackManifest(packDir, {
      schema: 1,
      id: 'mini',
      name: 'Mini',
      version: '1.0.0',
      author: 'A',
      license: 'MIT',
      sourceLicense: 'original',
      slots: { save: 'sounds/s.wav' },
    });
    const read = readPack(packDir);
    assert.ok(read.ok);
    const r = applyPack(located.located, read.pack, path.join(root, 'storage'), 'owner-x');
    assert.equal(r.ok, true);
    assert.ok(r.ok && r.report.disabled['save.mp3'] !== undefined);
    assert.ok(r.ok && r.report.disabled['save.mp3'].key === 'apply.fileMissing');
    assert.ok(r.ok && !r.report.replaced.includes('save.mp3'));
    assert.equal(fs.existsSync(path.join(tree.mediaDir, 'save.mp3')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a probe file left in the media dir never reaches backup or apply', () => {
  const root = makeTempRoot();
  try {
    const tree = buildInstallTree(root);
    fs.writeFileSync(path.join(tree.mediaDir, '.vir-probe'), '');
    const located = locate(tree.appRoot, '');
    assert.ok(located.ok);
    const storageDir = path.join(root, 'storage');
    const packDir = buildPack(root, 'mini2', { error: 'sounds/e.wav' });
    writePackManifest(packDir, {
      schema: 1,
      id: 'mini2',
      name: 'Mini2',
      version: '1.0.0',
      author: 'A',
      license: 'MIT',
      sourceLicense: 'original',
      slots: { error: 'sounds/e.wav' },
    });
    const read = readPack(packDir);
    assert.ok(read.ok);
    const r = applyPack(located.located, read.pack, storageDir, 'owner-y');
    assert.equal(r.ok, true);
    const backupDir = path.join(storageDir, 'backup');
    const versions = fs.readdirSync(backupDir);
    assert.equal(versions.length, 1);
    const manifest = JSON.parse(
      fs.readFileSync(path.join(backupDir, versions[0], 'backup.json'), 'utf8')
    );
    assert.equal('.vir-probe' in manifest.files, false);
    const st = JSON.parse(fs.readFileSync(path.join(storageDir, 'vir-state.json'), 'utf8'));
    assert.equal('.vir-probe' in st.applied.files, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
