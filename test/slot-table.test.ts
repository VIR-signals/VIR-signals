import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SLOTS,
  SLOT_NAMES,
  SLOT_FILES,
  OFFICIAL_FILES,
  ORPHAN_FILES,
  RESPONSE_SUB_KEYS,
  slotByName,
  fileOwnerSlot,
  isKnownManifestSlotKey,
  settingKeysForSlots,
  affectedEventsForSlots,
} from '../src/engine/slot-table';

test('slot table holds 28 slots with unique names', () => {
  assert.equal(SLOTS.length, 28);
  assert.equal(new Set(SLOT_NAMES).size, 28);
});

test('official file set is 32 unique files', () => {
  assert.equal(SLOT_FILES.length, 31);
  assert.equal(OFFICIAL_FILES.length, 32);
  assert.equal(new Set(OFFICIAL_FILES).size, 32);
});

test('events and setting keys both count 38 and stay unique', () => {
  const events = SLOTS.flatMap((s) => [...s.events]);
  const keys = SLOTS.flatMap((s) => [...s.settingKeys]);
  assert.equal(events.length, 38);
  assert.equal(new Set(events).size, 38);
  assert.equal(keys.length, 38);
  assert.equal(new Set(keys).size, 38);
  for (const k of keys) {
    assert.ok(k.startsWith('accessibility.signals.'), k);
  }
});

test('8 shared slots carry 18 events', () => {
  const shared = SLOTS.filter((s) => s.events.length > 1);
  assert.equal(shared.length, 8);
  assert.equal(shared.flatMap((s) => [...s.events]).length, 18);
});

test('responseReceived slot owns four numbered files', () => {
  const entry = slotByName('responseReceived');
  assert.ok(entry);
  assert.equal(entry.files.length, 4);
  assert.equal(fileOwnerSlot('responseReceived3.mp3')?.slot, 'responseReceived');
  assert.equal(RESPONSE_SUB_KEYS.length, 4);
});

test('orphan success file belongs to no slot', () => {
  assert.deepEqual(ORPHAN_FILES, ['success.mp3']);
  assert.equal(fileOwnerSlot('success.mp3'), undefined);
});

test('manifest slot key acceptance follows the contract', () => {
  assert.equal(isKnownManifestSlotKey('error'), true);
  assert.equal(isKnownManifestSlotKey('responseReceived'), true);
  assert.equal(isKnownManifestSlotKey('responseReceived4'), true);
  assert.equal(isKnownManifestSlotKey('responseReceived5'), false);
  assert.equal(isKnownManifestSlotKey('success'), false);
  assert.equal(isKnownManifestSlotKey('errorOnLine'), false);
});

test('derived helpers aggregate keys and events', () => {
  assert.equal(settingKeysForSlots(['error']).length, 4);
  assert.equal(settingKeysForSlots(['error', 'save']).length, 5);
  assert.equal(settingKeysForSlots(['responseReceived']).length, 1);
  assert.equal(affectedEventsForSlots(['error']).length, 4);
  assert.equal(affectedEventsForSlots(['error', 'save']).length, 5);
});
