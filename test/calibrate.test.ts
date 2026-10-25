import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as path from 'node:path';
import { findCalibrationPack, worksheetRows } from '../src/engine/calibrate';
import { scanPacks } from '../src/engine/pack-reader';
import { SLOT_NAMES } from '../src/engine/slot-table';
import { buildPack, makeTempRoot, writePackManifest } from './helpers';

function writePack(root: string, id: string, slots: Record<string, string>) {
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
  return dir;
}

test('picks the pack that covers every slot', () => {
  const root = makeTempRoot();
  try {
    writePack(root, 'partial', { error: 'sounds/error.wav' });
    const full: Record<string, string> = {};
    for (const s of SLOT_NAMES) {
      full[s] = `sounds/${s}.wav`;
    }
    writePack(root, 'calib-full', full);
    const found = findCalibrationPack(scanPacks(path.join(root, 'packs')));
    assert.ok(found);
    assert.equal(found.id, 'calib-full');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('no full coverage pack means no calibration pack', () => {
  const root = makeTempRoot();
  try {
    writePack(root, 'partial', { error: 'sounds/error.wav', save: 'sounds/save.wav' });
    assert.equal(findCalibrationPack(scanPacks(path.join(root, 'packs'))), undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('worksheet rows mirror the slot table', () => {
  const rows = worksheetRows();
  assert.equal(rows.length, 28);
  const errorRow = rows.find((r) => r.slot === 'error');
  assert.ok(errorRow);
  assert.equal(errorRow.events.length, 4);
  assert.equal(errorRow.settingKeys.length, 4);
  const rr = rows.find((r) => r.slot === 'responseReceived');
  assert.ok(rr);
  assert.equal(rr.files.length, 4);
});
