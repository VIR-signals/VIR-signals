// Local pack source: the listing seam partitions the packs folder into
// usable packs and broken folders carrying keyed errors. The picker never
// learns where packs come from, so this covers the local folder source.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { localPackListing } from '../src/ui/pack-source';
import { VirUiContext } from '../src/ui/extension-context';
import { packsDirFor } from '../src/engine/paths';
import { buildPack, makeTempRoot, writePackManifest } from './helpers';

// extensionDir is inert for the local source but part of the ctx shape.
function makeCtx(storageDir: string): VirUiContext {
  return { storageDir, extensionDir: path.join(storageDir, 'unused-ext'), owner: 'owner-a' };
}

function baseManifest(): Record<string, unknown> {
  return {
    schema: 1,
    id: 'demo-pack',
    name: 'Demo Pack',
    version: '1.0.0',
    author: 'Tester',
    license: 'CC0-1.0',
    sourceLicense: 'original',
    language: 'none',
    categories: ['ui'],
    slots: { error: 'sounds/error.wav' },
  };
}

test('an empty packs folder yields empty good and bad lists', () => {
  const root = makeTempRoot();
  try {
    fs.mkdirSync(packsDirFor(root), { recursive: true });
    const listing = localPackListing(makeCtx(root));
    assert.deepEqual(listing.good, []);
    assert.deepEqual(listing.bad, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a valid pack is listed in good with its id', () => {
  const root = makeTempRoot();
  try {
    const dir = buildPack(root, 'demo-pack', { error: 'sounds/error.wav' });
    writePackManifest(dir, baseManifest());
    const listing = localPackListing(makeCtx(root));
    assert.deepEqual(listing.bad, []);
    assert.equal(listing.good.length, 1);
    assert.equal(listing.good[0].id, 'demo-pack');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a folder without a manifest is listed in bad with a keyed error', () => {
  const root = makeTempRoot();
  try {
    fs.mkdirSync(path.join(packsDirFor(root), 'no-manifest'), { recursive: true });
    const listing = localPackListing(makeCtx(root));
    assert.deepEqual(listing.good, []);
    assert.equal(listing.bad.length, 1);
    assert.equal(listing.bad[0].folderName, 'no-manifest');
    assert.equal(typeof listing.bad[0].error.key, 'string');
    assert.equal(listing.bad[0].error.key, 'pack.manifestMissing');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
