// Market UI pure computation tests: slot name normalization for the
// coverage line, the demo pack shape (2 slots, 5 events), and bundle
// parity for every market key across both languages.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { slotNamesOfKeys } from '../src/ui/market-format';
import { affectedEventsForSlots, SLOTS } from '../src/engine/slot-table';
import { loadBundle } from '../src/ui/localize';

function bundle(name: string): Record<string, string> {
  return loadBundle(path.join(__dirname, '..', '..', 'l10n'), name);
}

test('numbered responseReceived sub keys fold into the one shared slot', () => {
  assert.deepEqual(slotNamesOfKeys(['error', 'responseReceived1', 'responseReceived2']), ['error', 'responseReceived']);
  assert.deepEqual(slotNamesOfKeys(['save']), ['save']);
});

test('the demo pack shape counts 2 of 28 slots and 5 affected events', () => {
  const slots = slotNamesOfKeys(['error', 'save']);
  assert.equal(slots.length, 2);
  assert.equal(affectedEventsForSlots(slots).length, 5);
  assert.equal(SLOTS.length, 28);
});

test('both language bundles carry the exact same key set', () => {
  const en = bundle('bundle.l10n.json');
  const zh = bundle('bundle.l10n.zh-cn.json');
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort());
});

test('market keys exist with placeholders in both bundles', () => {
  const en = bundle('bundle.l10n.json');
  const zh = bundle('bundle.l10n.zh-cn.json');
  const keys = [
    'ui.market.coverage',
    'ui.market.coverUnknown',
    'ui.market.installDone',
    'ui.market.uptoDate',
    'net.oversize',
    'registry.schema',
    'install.mismatch',
    'install.rollback',
    'direct.inputShape',
  ];
  for (const k of keys) {
    assert.ok(en[k] !== undefined, 'missing en key ' + k);
    assert.ok(zh[k] !== undefined, 'missing zh key ' + k);
  }
  assert.ok(en['ui.market.coverage'].includes('{0}'));
  assert.ok(zh['ui.market.coverage'].includes('{0}'));
});

test('the registry setting defaults exist in the manifest', async () => {
  const manifest = (await import('node:fs')).readFileSync(
    path.join(__dirname, '..', '..', 'package.json'),
    'utf8'
  );
  const parsed = JSON.parse(manifest) as {
    contributes: { configuration: { properties: Record<string, { default?: string }> } };
  };
  const props = parsed.contributes.configuration.properties;
  assert.equal(props['vir.packRegistryRepo'].default, 'VIR-signals/VIR-registry');
  assert.equal(props['vir.packMirrorTemplate'].default, '');
});
