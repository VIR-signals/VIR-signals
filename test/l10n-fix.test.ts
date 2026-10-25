// Regression nails for the l10n fix. The bug had two roots: the manifest
// lacked the "l10n" field so the platform never loaded our translations,
// and the staleness probe treated "platform has no translation" (it echoes
// the raw key back) as "needs reload", which looped the reload demand
// forever. The fix shipped three things: the manifest field, the
// staleVerdict probe, and a zh-hans alias copy of every bundle. These
// tests pin each of them against the real module and the real repo files.
// This file is read-only: no temp dirs, no writes.
import * as fs from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { staleVerdict } from '../src/ui/localize';

// Compiled tests run from out-test/test, so the repo root sits two levels up.
const repoRoot = path.resolve(__dirname, '..', '..');

function readJson(relPath: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, relPath), 'utf8'));
}

test('staleVerdict never flags the platform echoing the raw key', () => {
  // The platform returns the untranslated key itself when no translation
  // exists for it; a reload cannot conjure one, so that state is never
  // stale. Judging it stale is what once looped the reload demand.
  assert.equal(staleVerdict('locate.pathMissing', 'zh value', 'locate.pathMissing'), false);
  assert.equal(staleVerdict('anything.else', 'other zh value', 'anything.else'), false);
});

test('staleVerdict flags real platform English against our translation', () => {
  // The platform resolved a value that is neither the raw key nor ours:
  // genuinely stale, the reload hint is warranted.
  assert.equal(staleVerdict('Editor path not found', 'zh value', 'locate.pathMissing'), true);
  assert.equal(staleVerdict('Old English text {0}', 'zh value {0}', 'locate.pathMissing'), true);
});

test('staleVerdict accepts the platform already showing our text', () => {
  assert.equal(staleVerdict('zh value', 'zh value', 'locate.pathMissing'), false);
});

test('the zh-hans bundle alias stays a key-for-key copy of zh-cn', () => {
  const zhCn = readJson('l10n/bundle.l10n.zh-cn.json');
  const zhHans = readJson('l10n/bundle.l10n.zh-hans.json');
  assert.deepEqual(zhHans, zhCn);
});

test('the zh-hans manifest alias stays a key-for-key copy of zh-cn', () => {
  const zhCn = readJson('package.nls.zh-cn.json');
  const zhHans = readJson('package.nls.zh-hans.json');
  assert.deepEqual(zhHans, zhCn);
});

test('the manifest declares the l10n bundle directory', () => {
  const manifest = readJson('package.json') as { l10n?: unknown };
  assert.equal(manifest.l10n, './l10n');
});

test('the english and simplified bundles keep identical key sets', () => {
  const en = readJson('l10n/bundle.l10n.json') as Record<string, unknown>;
  const zhCn = readJson('l10n/bundle.l10n.zh-cn.json') as Record<string, unknown>;
  assert.deepEqual(Object.keys(zhCn).sort(), Object.keys(en).sort());
});
