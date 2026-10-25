import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  compareVersion,
  parseVersion,
  readPack,
  scanPacks,
  ReadPackResult,
} from '../src/engine/pack-reader';
import { AUDIO_SIZE_LIMIT_BYTES } from '../src/engine/paths';
import { buildFakeWav, buildPack, fakeMp3, makeTempRoot, writePackManifest } from './helpers';

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
    slots: {
      error: 'sounds/error.wav',
      save: 'sounds/save.wav',
    },
  };
}

function expectErr(r: ReadPackResult): string {
  assert.equal(r.ok, false);
  assert.ok(!r.ok);
  return r.error.key;
}

test('valid pack reads with resolved slots and hashes', () => {
  const root = makeTempRoot();
  try {
    const dir = buildPack(root, 'demo-pack', {
      error: 'sounds/error.wav',
      save: 'sounds/save.wav',
    });
    writePackManifest(dir, baseManifest());
    const r = readPack(dir);
    assert.ok(r.ok);
    assert.equal(r.pack.id, 'demo-pack');
    assert.equal(r.pack.name, 'Demo Pack');
    assert.equal(Object.keys(r.pack.slots).length, 2);
    assert.equal(r.pack.slots.error.slot, 'error');
    assert.equal(r.pack.slots.error.sha256.length, 64);
    assert.equal(r.pack.disabled.error, undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('schema above the supported version rejects with upgrade hint', () => {
  const root = makeTempRoot();
  try {
    const dir = buildPack(root, 'demo-pack', { error: 'sounds/error.wav' });
    const m = baseManifest();
    m.schema = 2;
    writePackManifest(dir, m);
    assert.equal(expectErr(readPack(dir)), 'pack.schemaNewer');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('unknown slot key rejects the whole pack', () => {
  const root = makeTempRoot();
  try {
    const dir = buildPack(root, 'demo-pack', {
      error: 'sounds/error.wav',
      errorX: 'sounds/save.wav',
    });
    const m = baseManifest();
    (m.slots as Record<string, string>)['errorX'] = 'sounds/save.wav';
    writePackManifest(dir, m);
    assert.equal(expectErr(readPack(dir)), 'pack.unknownSlot');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('responseReceived main key and sub keys cannot coexist', () => {
  const root = makeTempRoot();
  try {
    const dir = buildPack(root, 'demo-pack', {
      responseReceived: 'sounds/a.wav',
      responseReceived1: 'sounds/b.wav',
    });
    const m = baseManifest();
    m.slots = {
      responseReceived: 'sounds/a.wav',
      responseReceived1: 'sounds/b.wav',
    };
    writePackManifest(dir, m);
    assert.equal(expectErr(readPack(dir)), 'pack.responseShape');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('responseReceived5 is an unknown key', () => {
  const root = makeTempRoot();
  try {
    const dir = buildPack(root, 'demo-pack', { responseReceived5: 'sounds/a.wav' });
    const m = baseManifest();
    m.slots = { responseReceived5: 'sounds/a.wav' };
    writePackManifest(dir, m);
    assert.equal(expectErr(readPack(dir)), 'pack.unknownSlot');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('missing or empty required fields reject', () => {
  const root = makeTempRoot();
  try {
    const dir = buildPack(root, 'demo-pack', { error: 'sounds/error.wav' });
    const m = baseManifest();
    delete m.id;
    writePackManifest(dir, m);
    assert.equal(expectErr(readPack(dir)), 'pack.fieldsMissing');

    const m2 = baseManifest();
    m2.license = '';
    writePackManifest(dir, m2);
    assert.equal(expectErr(readPack(dir)), 'pack.fieldsMissing');

    const m3 = baseManifest();
    delete m3.slots;
    writePackManifest(dir, m3);
    assert.equal(expectErr(readPack(dir)), 'pack.slotsMissing');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('missing manifest and broken json reject', () => {
  const root = makeTempRoot();
  try {
    const dir = path.join(root, 'packs', 'empty');
    fs.mkdirSync(dir, { recursive: true });
    assert.equal(expectErr(readPack(dir)), 'pack.manifestMissing');
    fs.writeFileSync(path.join(dir, 'manifest.json'), '{nope');
    assert.equal(expectErr(readPack(dir)), 'pack.manifestBad');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('version parses as three numeric parts and compares numerically', () => {
  assert.deepEqual(parseVersion('1.9.0'), [1, 9, 0]);
  assert.equal(parseVersion('1.9'), undefined);
  assert.equal(parseVersion('1.9.x'), undefined);
  assert.equal(compareVersion([1, 9, 0], [1, 10, 0]), -1);
  assert.equal(compareVersion([1, 10, 0], [1, 9, 0]), 1);
  assert.equal(compareVersion([1, 10, 0], [1, 10, 0]), 0);
});

test('version field must parse', () => {
  const root = makeTempRoot();
  try {
    const dir = buildPack(root, 'demo-pack', { error: 'sounds/error.wav' });
    const m = baseManifest();
    m.version = '1.2';
    writePackManifest(dir, m);
    assert.equal(expectErr(readPack(dir)), 'pack.versionBad');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('source license must be from the enum', () => {
  const root = makeTempRoot();
  try {
    const dir = buildPack(root, 'demo-pack', { error: 'sounds/error.wav' });
    const m = baseManifest();
    m.sourceLicense = 'made-up';
    writePackManifest(dir, m);
    assert.equal(expectErr(readPack(dir)), 'pack.sourceLicenseBad');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('path escape, absolute paths and backslashes reject the pack', () => {
  const root = makeTempRoot();
  try {
    const cases: Array<[string, string, string]> = [
      ['escape', 'sounds/../outside.wav', 'pack.pathEscape'],
      ['absolute', '/etc/host.wav', 'pack.pathAbsolute'],
      ['drive', 'C:/sounds/error.wav', 'pack.pathAbsolute'],
      ['backslash', 'sounds\\error.wav', 'pack.pathSlash'],
    ];
    for (const [label, rel, key] of cases) {
      const dir = buildPack(root, 'p-' + label, { error: 'sounds/error.wav' });
      const m = baseManifest();
      m.slots = { error: rel };
      writePackManifest(dir, m);
      assert.equal(expectErr(readPack(dir)), key, label);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('case mismatch disables only that slot', (t) => {
  const root = makeTempRoot();
  try {
    const dir = buildPack(root, 'demo-pack', {
      error: 'sounds/error.wav',
      save: 'sounds/save.wav',
    });
    fs.renameSync(
      path.join(dir, 'sounds', 'save.wav'),
      path.join(dir, 'sounds', 'Save.wav')
    );
    const m = baseManifest();
    m.slots = {
      error: 'sounds/error.wav',
      save: 'sounds/save.wav',
    };
    writePackManifest(dir, m);
    const r = readPack(dir);
    assert.ok(r.ok);
    assert.equal(r.pack.slots.save, undefined);
    assert.equal(r.pack.disabled.save.key, 'pack.caseMismatch');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('missing audio file disables only that slot', () => {
  const root = makeTempRoot();
  try {
    const dir = buildPack(root, 'demo-pack', {
      error: 'sounds/error.wav',
      save: 'sounds/save.wav',
    });
    fs.rmSync(path.join(dir, 'sounds', 'save.wav'));
    writePackManifest(dir, baseManifest());
    const r = readPack(dir);
    assert.ok(r.ok);
    assert.equal(Object.keys(r.pack.slots).length, 1);
    assert.equal(r.pack.disabled.save.key, 'pack.audioMissing');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('unknown audio container disables only that slot', () => {
  const root = makeTempRoot();
  try {
    const dir = buildPack(root, 'demo-pack', {
      error: 'sounds/error.wav',
      save: 'sounds/save.wav',
    });
    fs.writeFileSync(path.join(dir, 'sounds', 'save.wav'), Buffer.from('not audio at all'));
    writePackManifest(dir, baseManifest());
    const r = readPack(dir);
    assert.ok(r.ok);
    assert.equal(r.pack.disabled.save.key, 'pack.formatUnknown');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('oversize audio disables only that slot', () => {
  const root = makeTempRoot();
  try {
    const dir = buildPack(root, 'demo-pack', {
      error: 'sounds/error.wav',
      save: 'sounds/save.wav',
    });
    const big = Buffer.alloc(AUDIO_SIZE_LIMIT_BYTES + 1);
    big.write('ID3', 0, 'ascii');
    fs.writeFileSync(path.join(dir, 'sounds', 'save.wav'), big);
    writePackManifest(dir, baseManifest());
    const r = readPack(dir);
    assert.ok(r.ok);
    assert.equal(r.pack.disabled.save.key, 'pack.tooBig');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('pack with zero usable slots rejects', () => {
  const root = makeTempRoot();
  try {
    const dir = buildPack(root, 'demo-pack', { error: 'sounds/error.wav' });
    fs.rmSync(path.join(dir, 'sounds', 'error.wav'));
    writePackManifest(dir, baseManifest());
    assert.equal(expectErr(readPack(dir)), 'pack.noUsableSlots');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('long audio passes with a recorded warning', () => {
  const root = makeTempRoot();
  try {
    const dir = buildPack(root, 'demo-pack', {
      error: 'sounds/error.wav',
      progress: 'sounds/progress.wav',
    });
    buildFakeWav(path.join(dir, 'sounds', 'error.wav'), 3);
    buildFakeWav(path.join(dir, 'sounds', 'progress.wav'), 1.5);
    const m = baseManifest();
    m.slots = { error: 'sounds/error.wav', progress: 'sounds/progress.wav' };
    writePackManifest(dir, m);
    const r = readPack(dir);
    assert.ok(r.ok);
    assert.equal(r.pack.slots.error.warnings.length, 1);
    assert.equal(r.pack.slots.error.warnings[0].key, 'pack.tooLong');
    assert.equal(r.pack.slots.progress.warnings.length, 1);
    assert.equal(r.pack.slots.progress.warnings[0].key, 'pack.tooLong');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('symlinked audio rejects the pack', (t) => {
  const root = makeTempRoot();
  try {
    const dir = buildPack(root, 'demo-pack', { error: 'sounds/error.wav' });
    const real = path.join(root, 'real.wav');
    buildFakeWav(real, 0.2);
    try {
      fs.symlinkSync(real, path.join(dir, 'sounds', 'error.wav'));
    } catch (e) {
      return t.skip((e as { code?: string }).code === 'EPERM' ? 'symlink needs privilege' : undefined);
    }
    writePackManifest(dir, baseManifest());
    assert.equal(expectErr(readPack(dir)), 'pack.pathSymlink');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('mp3 container is accepted and estimated', () => {
  const root = makeTempRoot();
  try {
    const dir = buildPack(root, 'demo-pack', { error: 'sounds/error.mp3' });
    fs.writeFileSync(path.join(dir, 'sounds', 'error.mp3'), fakeMp3('seed', 8000));
    const m = baseManifest();
    m.slots = { error: 'sounds/error.mp3' };
    writePackManifest(dir, m);
    const r = readPack(dir);
    assert.ok(r.ok);
    assert.equal(typeof r.pack.slots.error.seconds, 'number');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('scan rejects the later folder with a duplicate id', () => {
  const root = makeTempRoot();
  try {
    const a = buildPack(root, 'a-first', { error: 'sounds/error.wav' });
    writePackManifest(a, baseManifest());
    const b = buildPack(root, 'b-second', { save: 'sounds/save.wav' });
    const m = baseManifest();
    m.slots = { save: 'sounds/save.wav' };
    writePackManifest(b, m);
    const scanned = scanPacks(path.join(root, 'packs'));
    assert.equal(scanned.length, 2);
    assert.ok(scanned[0].result.ok);
    assert.equal(scanned[1].result.ok, false);
    assert.ok(!scanned[1].result.ok && scanned[1].result.error.key === 'pack.duplicateId');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('scan on a missing folder returns empty', () => {
  const root = makeTempRoot();
  try {
    assert.deepEqual(scanPacks(path.join(root, 'nope')), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
