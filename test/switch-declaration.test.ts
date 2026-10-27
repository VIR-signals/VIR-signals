// Declaration-plane nails for the master switch: the switch state must not
// leak back into the editor settings UI. The switch is a command plus ledger
// state only, so the manifest exposes no vir.enabled / vir.activePack
// settings, every localization ships the command title and the disabled
// banner with its turn-on action, and the dead settings keys are gone from
// the production source entirely. This file is read-only: no temp dirs, no
// writes, only repo files on disk.
import * as fs from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

// Compiled tests run from out-test/test, so the repo root sits two levels up
// (same convention as test/l10n-fix.test.ts).
const repoRoot = path.resolve(__dirname, '..', '..');

function readJson(relPath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, relPath), 'utf8')) as Record<
    string,
    unknown
  >;
}

function hasKey(obj: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

test('the manifest configuration exposes no switch state settings', () => {
  const manifest = readJson('package.json');
  const contributes = (manifest.contributes ?? {}) as Record<string, unknown>;
  const configuration = (contributes.configuration ?? {}) as Record<string, unknown>;
  const properties = (configuration.properties ?? {}) as Record<string, unknown>;
  assert.equal(hasKey(properties, 'vir.enabled'), false);
  assert.equal(hasKey(properties, 'vir.activePack'), false);
});

test('the manifest commands declare vir.toggleSwitch under the nls title reference', () => {
  const manifest = readJson('package.json');
  const contributes = (manifest.contributes ?? {}) as Record<string, unknown>;
  const commands = (contributes.commands ?? []) as Array<Record<string, unknown>>;
  const toggle = commands.find((c) => c.command === 'vir.toggleSwitch');
  assert.ok(toggle, 'vir.toggleSwitch must be a contributed command');
  assert.equal(toggle.title, '%vir.cmd.toggleSwitch.title%');
});

test('every package.nls bundle ships the toggleSwitch command title', () => {
  for (const rel of [
    'package.nls.json',
    'package.nls.zh-cn.json',
    'package.nls.zh-hans.json',
  ]) {
    const nls = readJson(rel);
    assert.equal(hasKey(nls, 'vir.cmd.toggleSwitch.title'), true, rel);
  }
});

test('no package.nls bundle describes the dead switch settings keys', () => {
  for (const rel of [
    'package.nls.json',
    'package.nls.zh-cn.json',
    'package.nls.zh-hans.json',
  ]) {
    const nls = readJson(rel);
    assert.equal(hasKey(nls, 'vir.enabled.description'), false, rel);
    assert.equal(hasKey(nls, 'vir.activePack.description'), false, rel);
  }
});

test('every l10n bundle ships the disabled banner and its turn-on action', () => {
  for (const rel of [
    'l10n/bundle.l10n.json',
    'l10n/bundle.l10n.zh-cn.json',
    'l10n/bundle.l10n.zh-hans.json',
  ]) {
    const bundle = readJson(rel);
    assert.equal(hasKey(bundle, 'ui.disabled'), true, rel);
    assert.equal(hasKey(bundle, 'ui.disabled.turnOn'), true, rel);
  }
});

test('no l10n bundle ships the retired openSettings action', () => {
  // The disabled banner must offer to turn the switch on directly, not send
  // the user digging through the settings page.
  for (const rel of [
    'l10n/bundle.l10n.json',
    'l10n/bundle.l10n.zh-cn.json',
    'l10n/bundle.l10n.zh-hans.json',
  ]) {
    const bundle = readJson(rel);
    assert.equal(hasKey(bundle, 'ui.disabled.openSettings'), false, rel);
  }
});

test('the production source has zero references to the dead settings keys', () => {
  // Walk every file under src/ and demand the literal key strings never come
  // back. Only this test suite is allowed to mention them.
  const srcDir = path.join(repoRoot, 'src');
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(p);
        continue;
      }
      const content = fs.readFileSync(p, 'utf8');
      if (content.includes('vir.enabled') || content.includes('vir.activePack')) {
        offenders.push(path.relative(repoRoot, p));
      }
    }
  };
  walk(srcDir);
  assert.deepEqual(offenders, []);
});
