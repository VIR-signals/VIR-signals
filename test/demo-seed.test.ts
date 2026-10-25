// Demo pack seeding: the extension carries a demo pack next to its code and
// copies it into the packs folder exactly once. An existing demo is never
// touched, and a bundle without a demo reports ui.demoSeed.missing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { seedDemoPack } from '../src/ui/demo-seed';
import { VirUiContext } from '../src/ui/extension-context';
import { packsDirFor } from '../src/engine/paths';
import { buildFakeWav, makeTempRoot, writePackManifest } from './helpers';

function sha(p: string): string {
  return createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

// Recursive snapshot of a directory as relative path to file sha256.
function hashTree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string, prefix: string): void => {
    const entries = fs
      .readdirSync(d, { withFileTypes: true })
      .sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const ent of entries) {
      const rel = prefix === '' ? ent.name : prefix + '/' + ent.name;
      if (ent.isDirectory()) {
        walk(path.join(d, ent.name), rel);
      } else {
        out[rel] = sha(path.join(d, ent.name));
      }
    }
  };
  walk(dir, '');
  return out;
}

// A bundled demo folder under extensionDir: manifest, one wav slot and a
// provenance notice. Bytes are arbitrary but verifiable per file.
function buildBundledDemo(extensionDir: string, name: string, version: string): string {
  const src = path.join(extensionDir, 'demo');
  fs.mkdirSync(path.join(src, 'sounds'), { recursive: true });
  writePackManifest(src, {
    schema: 1,
    id: 'demo',
    name,
    version,
    license: 'CC0-1.0',
    sourceLicense: 'original',
    slots: { error: 'sounds/a.wav' },
  });
  buildFakeWav(path.join(src, 'sounds', 'a.wav'), 0.2);
  return src;
}

function ctxFor(storageDir: string, extensionDir: string): VirUiContext {
  return { storageDir, extensionDir, owner: 'owner-a' };
}

test('seeding copies the bundled demo into the packs folder file for file', () => {
  const root = makeTempRoot();
  try {
    const extensionDir = path.join(root, 'ext');
    const src = buildBundledDemo(extensionDir, 'Demo Pack', '1.0.0');
    fs.writeFileSync(path.join(src, 'SOURCE.txt'), 'bundled demo pack\n');

    const storageDir = path.join(root, 'storage');
    assert.equal(seedDemoPack(ctxFor(storageDir, extensionDir)), undefined);

    const target = path.join(packsDirFor(storageDir), 'demo');
    for (const rel of ['manifest.json', 'sounds/a.wav', 'SOURCE.txt']) {
      assert.equal(sha(path.join(target, rel)), sha(path.join(src, rel)), rel);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an existing user demo is never touched, not one byte changes', () => {
  const root = makeTempRoot();
  try {
    // The bundle exists and would be copied if the guard failed.
    const extensionDir = path.join(root, 'ext');
    buildBundledDemo(extensionDir, 'Demo Pack', '1.0.0');

    const storageDir = path.join(root, 'storage');
    const target = path.join(packsDirFor(storageDir), 'demo');
    fs.mkdirSync(path.join(target, 'sounds'), { recursive: true });
    // User edited the manifest and added a file the bundle does not carry.
    writePackManifest(target, {
      schema: 1,
      id: 'demo',
      name: 'My Own Mix',
      version: '9.9.9',
      license: 'CC0-1.0',
      sourceLicense: 'original',
      slots: { error: 'sounds/a.wav' },
    });
    buildFakeWav(path.join(target, 'sounds', 'a.wav'), 0.35);
    fs.writeFileSync(path.join(target, 'notes.txt'), 'user notes\n');

    const before = hashTree(target);
    assert.equal(seedDemoPack(ctxFor(storageDir, extensionDir)), undefined);
    assert.deepEqual(hashTree(target), before);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a bundle without a demo reports ui.demoSeed.missing and seeds nothing', () => {
  const root = makeTempRoot();
  try {
    const extensionDir = path.join(root, 'ext');
    fs.mkdirSync(extensionDir, { recursive: true });
    const storageDir = path.join(root, 'storage');
    const r = seedDemoPack(ctxFor(storageDir, extensionDir));
    assert.ok(r);
    assert.equal(r.key, 'ui.demoSeed.missing');
    assert.equal(fs.existsSync(path.join(packsDirFor(storageDir), 'demo')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
