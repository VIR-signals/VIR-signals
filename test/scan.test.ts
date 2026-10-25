// Zero literal copy scan: asserts that src holds no Chinese characters, no
// English sentence literals (quoted or templated), and no degrade
// vocabulary. Mirrors the repository gate; the banned words are assembled
// from pieces so this file itself stays clean.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ZH = /[\u4e00-\u9fff]/;
const EN_SENTENCE = /['"`]([A-Za-z][A-Za-z0-9 ,.!?:;'\-]{14,})['"`]/g;
const DEGRADE_WORDS = [
  'fall' + 'back',
  'leg' + 'acy',
  'backwards?- ?compat\\w*',
  'depre' + 'cat\\w*',
  'mig' + 'rat\\w+',
];
const DEGRADE = new RegExp('\\b(' + DEGRADE_WORDS.join('|') + ')\\b', 'i');

function collect(dir: string, out: string[]): string[] {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      collect(p, out);
    } else if (ent.isFile() && ent.name.endsWith('.ts')) {
      out.push(p);
    }
  }
  return out;
}

function srcFiles(): string[] {
  const root = path.resolve(__dirname, '..', '..', 'src');
  return collect(root, []).sort();
}

test('source tree is present and non trivial', () => {
  const files = srcFiles();
  assert.ok(files.length >= 15);
});

test('source holds no Chinese characters', () => {
  for (const p of srcFiles()) {
    const text = fs.readFileSync(p, 'utf8');
    const hit = ZH.exec(text);
    assert.equal(hit, null, `${p}: ${hit?.[0]}`);
  }
});

test('source holds no English sentence literals', () => {
  for (const p of srcFiles()) {
    const text = fs.readFileSync(p, 'utf8');
    for (const m of text.matchAll(EN_SENTENCE)) {
      assert.equal(
        /[a-z] [a-z]/.test(m[1]),
        false,
        `${p}: ${m[1].slice(0, 60)}`
      );
    }
  }
});

test('source holds no degrade vocabulary', () => {
  for (const p of srcFiles()) {
    const text = fs.readFileSync(p, 'utf8');
    const hit = DEGRADE.exec(text);
    assert.equal(hit, null, `${p}: ${hit?.[0]}`);
  }
});
