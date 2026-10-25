import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Bundle,
  bundleFileNameFor,
  formatPlaceholders,
  lookup,
} from '../src/ui/localize';

test('chinese variants pick the simplified bundle', () => {
  assert.equal(bundleFileNameFor('zh-cn'), 'bundle.l10n.zh-cn.json');
  assert.equal(bundleFileNameFor('zh-CN'), 'bundle.l10n.zh-cn.json');
  assert.equal(bundleFileNameFor('zh-tw'), 'bundle.l10n.zh-cn.json');
  assert.equal(bundleFileNameFor('zh'), 'bundle.l10n.zh-cn.json');
});

test('everything else picks the default bundle', () => {
  assert.equal(bundleFileNameFor('en'), 'bundle.l10n.json');
  assert.equal(bundleFileNameFor('en-US'), 'bundle.l10n.json');
  assert.equal(bundleFileNameFor('de'), 'bundle.l10n.json');
  assert.equal(bundleFileNameFor('ja'), 'bundle.l10n.json');
});

test('placeholders fill by index and leave missing ones intact', () => {
  assert.equal(formatPlaceholders('{0} of {1}', ['a', 'b']), 'a of b');
  assert.equal(formatPlaceholders('{0} of {1}', ['a']), 'a of {1}');
  assert.equal(formatPlaceholders('no placeholders', []), 'no placeholders');
  assert.equal(formatPlaceholders('{1} then {0}', [1, 2]), '2 then 1');
});

test('lookup fills placeholders and passes unknown keys through', () => {
  const bundle: Bundle = { 'a.key': 'value {0}' };
  assert.equal(lookup(bundle, 'a.key', ['x']), 'value x');
  assert.equal(lookup(bundle, 'missing.key', []), 'missing.key');
});
