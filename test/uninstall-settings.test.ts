// Tests for the settings half of the uninstall hook: restoreSignalSettings
// walks the ledger of flipped accessibility.signals.* keys and edits the
// user settings.json as text (JSONC) so comments and trailing commas
// survive. Fixtures build a fake user-data tree: <root>/User/settings.json
// plus <root>/User/globalStorage/vir-signals.vir-signals/vir-state.json.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as path from 'node:path';
import { restoreSignalSettings } from '../src/engine/uninstall-settings';
import { makeTempRoot } from './helpers';

interface Fixture {
  root: string;
  userDir: string;
  storageRoot: string;
  settingsPath: string;
  statePath: string;
}

// storageRoot = <x>/User/globalStorage/vir-signals.vir-signals, so the
// module resolves the settings file two levels up, at <x>/User/settings.json.
function fixture(): Fixture {
  const root = makeTempRoot();
  const userDir = path.join(root, 'User');
  const storageRoot = path.join(userDir, 'globalStorage', 'vir-signals.vir-signals');
  fs.mkdirSync(storageRoot, { recursive: true });
  return {
    root,
    userDir,
    storageRoot,
    settingsPath: path.join(userDir, 'settings.json'),
    statePath: path.join(storageRoot, 'vir-state.json'),
  };
}

function writeLedger(f: Fixture, signalToggles: Record<string, unknown> | undefined): void {
  const ledger: Record<string, unknown> = { schema: 1 };
  if (signalToggles !== undefined) {
    ledger.signalToggles = signalToggles;
  }
  fs.writeFileSync(f.statePath, JSON.stringify(ledger, null, 2));
}

function writeSettings(f: Fixture, lines: string[]): void {
  // Joined with explicit \n so the fixture bytes never depend on the line
  // endings of this source file.
  fs.writeFileSync(f.settingsPath, lines.join('\n'));
}

function readSettings(f: Fixture): string {
  return fs.readFileSync(f.settingsPath, 'utf8');
}

// Independent tolerant reader used only for assertions: drop full-line
// comments and trailing commas, then strict-parse.
function parseJsonc(text: string): Record<string, unknown> {
  const stripped = text
    .split(/\r?\n/)
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n')
    .replace(/,(\s*[}\]])/g, '$1');
  return JSON.parse(stripped) as Record<string, unknown>;
}

test('null record deletes the whole key block and keeps the rest byte-identical', () => {
  const f = fixture();
  try {
    writeSettings(f, [
      '{',
      '  // window',
      '    "window.zoomLevel": 1,',
      '  "accessibility.signals.save": {',
      '    "sound": "on"',
      '  },',
      '  "editor.fontFamily": "Consolas, \'Courier New\', monospace",',
      '}',
    ]);
    writeLedger(f, { 'accessibility.signals.save': null });
    const out = restoreSignalSettings(f.storageRoot);
    assert.deepEqual(out, { code: 0 });
    // Everything except the three entry lines survives byte for byte:
    // the comment line, odd indentation, unrelated keys, trailing comma.
    assert.deepEqual(readSettings(f).split('\n'), [
      '{',
      '  // window',
      '    "window.zoomLevel": 1,',
      '  "editor.fontFamily": "Consolas, \'Courier New\', monospace",',
      '}',
    ]);
    const parsed = parseJsonc(readSettings(f));
    assert.equal('accessibility.signals.save' in parsed, false);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('object record replaces a different current value with the original', () => {
  const f = fixture();
  try {
    writeSettings(f, [
      '{',
      '  "editor.fontSize": 14,',
      '  "accessibility.signals.lineHasBreakpoint": {',
      '    "sound": "auto",',
      '    "announcement": true',
      '  },',
      '  "workbench.colorTheme": "Dark",',
      '}',
    ]);
    const recorded = { announcement: true };
    writeLedger(f, { 'accessibility.signals.lineHasBreakpoint': recorded });
    const out = restoreSignalSettings(f.storageRoot);
    assert.deepEqual(out, { code: 0 });
    assert.deepEqual(readSettings(f).split('\n'), [
      '{',
      '  "editor.fontSize": 14,',
      '  "accessibility.signals.lineHasBreakpoint": {"announcement":true},',
      '  "workbench.colorTheme": "Dark",',
      '}',
    ]);
    assert.deepEqual(
      parseJsonc(readSettings(f))['accessibility.signals.lineHasBreakpoint'],
      recorded
    );
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('replacement of the final entry keeps its missing trailing comma', () => {
  const f = fixture();
  try {
    writeSettings(f, [
      '{',
      '  "workbench.colorTheme": "Dark",',
      '  "accessibility.signals.save": {',
      '    "sound": "on"',
      '  }',
      '}',
    ]);
    const recorded = { sound: 'auto', announcement: true };
    writeLedger(f, { 'accessibility.signals.save': recorded });
    const out = restoreSignalSettings(f.storageRoot);
    assert.deepEqual(out, { code: 0 });
    assert.deepEqual(readSettings(f).split('\n'), [
      '{',
      '  "workbench.colorTheme": "Dark",',
      '  "accessibility.signals.save": {"sound":"auto","announcement":true}',
      '}',
    ]);
    assert.deepEqual(parseJsonc(readSettings(f))['accessibility.signals.save'], recorded);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('object record for a key missing from settings.json is appended', () => {
  const f = fixture();
  try {
    writeSettings(f, [
      '{',
      '  // theme',
      '  "workbench.colorTheme": "Dark",',
      '}',
    ]);
    const recorded = { sound: 'off' };
    writeLedger(f, { 'accessibility.signals.error': recorded });
    const out = restoreSignalSettings(f.storageRoot);
    assert.deepEqual(out, { code: 0 });
    // The new entry carries its own trailing comma, valid JSONC, and the
    // comment line above survives untouched.
    assert.deepEqual(readSettings(f).split('\n'), [
      '{',
      '  // theme',
      '  "workbench.colorTheme": "Dark",',
      '"accessibility.signals.error": {"sound":"off"},',
      '}',
    ]);
    assert.deepEqual(parseJsonc(readSettings(f))['accessibility.signals.error'], recorded);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('already-restored and null-with-key-absent records leave the file untouched', () => {
  // Variant A: current value equals the recorded original.
  const a = fixture();
  try {
    const original = [
      '{',
      '  "accessibility.signals.warning": {',
      '    "sound": "auto"',
      '  },',
      '}',
    ].join('\n');
    fs.writeFileSync(a.settingsPath, original);
    writeLedger(a, { 'accessibility.signals.warning': { sound: 'auto' } });
    assert.deepEqual(restoreSignalSettings(a.storageRoot), { code: 0 });
    assert.equal(readSettings(a), original);
  } finally {
    fs.rmSync(a.root, { recursive: true, force: true });
  }
  // Variant B: null record but the key is already gone from the file.
  const b = fixture();
  try {
    const original = '{\n  "editor.fontSize": 14\n}\n';
    fs.writeFileSync(b.settingsPath, original);
    writeLedger(b, { 'accessibility.signals.save': null });
    assert.deepEqual(restoreSignalSettings(b.storageRoot), { code: 0 });
    assert.equal(readSettings(b), original);
  } finally {
    fs.rmSync(b.root, { recursive: true, force: true });
  }
});

test('missing settings.json with only null records creates no file', () => {
  const f = fixture();
  try {
    writeLedger(f, {
      'accessibility.signals.save': null,
      'accessibility.signals.error': null,
    });
    const out = restoreSignalSettings(f.storageRoot);
    assert.deepEqual(out, { code: 0 });
    assert.equal(fs.existsSync(f.settingsPath), false);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('missing settings.json with object records is recreated holding only those keys', () => {
  const f = fixture();
  try {
    writeLedger(f, {
      'accessibility.signals.save': null,
      'accessibility.signals.error': { sound: 'off' },
      'accessibility.signals.warning': { announcement: false },
    });
    const out = restoreSignalSettings(f.storageRoot);
    assert.deepEqual(out, { code: 0 });
    // The null record means "no override existed before install", so it is
    // not written; the file holds exactly the two object records.
    assert.deepEqual(readSettings(f).split('\n'), [
      '{',
      '  "accessibility.signals.error": {"sound":"off"},',
      '  "accessibility.signals.warning": {"announcement":false},',
      '}',
      '',
    ]);
    const parsed = parseJsonc(readSettings(f));
    assert.deepEqual(parsed['accessibility.signals.error'], { sound: 'off' });
    assert.deepEqual(parsed['accessibility.signals.warning'], { announcement: false });
    assert.equal('accessibility.signals.save' in parsed, false);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('no ledger, unparsable ledger, no signalToggles, and empty toggles all exit 0 untouched', () => {
  const variants: Array<{ name: string; setup(fx: Fixture): void }> = [
    { name: 'ledger file missing', setup() { /* nothing written */ } },
    { name: 'ledger unparsable', setup(fx) { fs.writeFileSync(fx.statePath, 'not json'); } },
    { name: 'ledger without signalToggles', setup(fx) { writeLedger(fx, undefined); } },
    { name: 'signalToggles empty object', setup(fx) { writeLedger(fx, {}); } },
  ];
  for (const v of variants) {
    const f = fixture();
    try {
      const original = '{\n  // untouched\n  "editor.fontSize": 14,\n}\n';
      fs.writeFileSync(f.settingsPath, original);
      v.setup(f);
      assert.deepEqual(restoreSignalSettings(f.storageRoot), { code: 0 }, v.name);
      assert.equal(readSettings(f), original, v.name);
    } finally {
      fs.rmSync(f.root, { recursive: true, force: true });
    }
  }
});

test('unparsable settings.json with a needed write exits 2 and stays byte-identical', () => {
  // Two flavors: a file with no root brace to append into (the edit itself
  // throws), and a file the tolerant reader cannot parse where the rewrite
  // is rolled back before it ever reaches the disk.
  const broken = [
    { text: '{ "a": ', why: 'settings.restoreFailed: settings.noRoot' },
    { text: '{ "a": 1,, "b": 2 }', why: 'settings.rewriteUnparsable' },
  ];
  for (const { text, why } of broken) {
    const f = fixture();
    try {
      fs.writeFileSync(f.settingsPath, text);
      writeLedger(f, { 'accessibility.signals.error': { sound: 'off' } });
      const out = restoreSignalSettings(f.storageRoot);
      assert.ok(out.code === 2, text);
      assert.equal(out.why, why);
      // No half-finished rewrite reaches the disk, not even a temp sibling.
      assert.equal(readSettings(f), text);
      const leftovers = fs.readdirSync(f.userDir).filter((n) => n !== 'globalStorage');
      assert.deepEqual(leftovers, ['settings.json']);
    } finally {
      fs.rmSync(f.root, { recursive: true, force: true });
    }
  }
});

// --- Regression pins for the text-editing fixes (comment-aware findEntry,
// append after a comma-less last entry, shared-line closing brace, EOL
// unification). Each shape below once produced a wrong or refused edit. ---

test('append after a last entry without trailing comma still yields parsable JSONC', () => {
  // The editor writer's usual shape: the final key carries no comma and the
  // closing brace stands on its own line.
  const f = fixture();
  try {
    writeSettings(f, [
      '{',
      '  // theme',
      '  "workbench.colorTheme": "Dark"',
      '}',
    ]);
    const recorded = { sound: 'off' };
    writeLedger(f, { 'accessibility.signals.error': recorded });
    const out = restoreSignalSettings(f.storageRoot);
    assert.deepEqual(out, { code: 0 });
    // The previous last entry gains the separating comma, the new entry
    // carries its own trailing comma, and the comment line survives.
    assert.deepEqual(readSettings(f).split('\n'), [
      '{',
      '  // theme',
      '  "workbench.colorTheme": "Dark",',
      '"accessibility.signals.error": {"sound":"off"},',
      '}',
    ]);
    assert.deepEqual(parseJsonc(readSettings(f)), {
      'workbench.colorTheme': 'Dark',
      'accessibility.signals.error': recorded,
    });
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('append into a single-line root whose brace shares the last entry line', () => {
  const f = fixture();
  try {
    writeSettings(f, [
      '{"editor.fontSize": 14, "accessibility.signals.warning": {"sound":"auto"} }',
    ]);
    const recorded = { sound: 'off' };
    writeLedger(f, { 'accessibility.signals.error': recorded });
    const out = restoreSignalSettings(f.storageRoot);
    assert.deepEqual(out, { code: 0 });
    const parts = readSettings(f).split('\n');
    // The one-liner splits at the brace: the original line keeps its content
    // and gains a comma; the new entry lands on the next line before `}`.
    assert.equal(parts.length, 2);
    assert.equal(
      parts[0],
      '{"editor.fontSize": 14, "accessibility.signals.warning": {"sound":"auto"},'
    );
    assert.equal(parts[1].trim(), '"accessibility.signals.error": {"sound":"off"} }');
    assert.deepEqual(parseJsonc(readSettings(f)), {
      'editor.fontSize': 14,
      'accessibility.signals.warning': { sound: 'auto' },
      'accessibility.signals.error': recorded,
    });
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('comment line quoting the key verbatim is kept and the real entry is deleted', () => {
  const f = fixture();
  try {
    writeSettings(f, [
      '{',
      '  // "accessibility.signals.save": old note',
      '  "editor.fontSize": 14,',
      '  "accessibility.signals.save": {',
      '    "sound": "on"',
      '  },',
      '}',
    ]);
    writeLedger(f, { 'accessibility.signals.save': null });
    const out = restoreSignalSettings(f.storageRoot);
    assert.deepEqual(out, { code: 0 });
    // The comment line must survive byte for byte; only the real entry
    // block is removed.
    assert.deepEqual(readSettings(f).split('\n'), [
      '{',
      '  // "accessibility.signals.save": old note',
      '  "editor.fontSize": 14,',
      '}',
    ]);
    const parsed = parseJsonc(readSettings(f));
    assert.equal('accessibility.signals.save' in parsed, false);
    assert.equal(parsed['editor.fontSize'], 14);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('append onto a CRLF file keeps CRLF line endings throughout', () => {
  const f = fixture();
  try {
    // Written as one string so the fixture bytes are CRLF regardless of the
    // line endings of this source file.
    fs.writeFileSync(
      f.settingsPath,
      '{\r\n  "workbench.colorTheme": "Dark"\r\n}\r\n'
    );
    const recorded = { sound: 'off' };
    writeLedger(f, { 'accessibility.signals.error': recorded });
    const out = restoreSignalSettings(f.storageRoot);
    assert.deepEqual(out, { code: 0 });
    const after = readSettings(f);
    // Every newline stays CR-prefixed: no lone LF is introduced.
    assert.equal(after.includes('\r\n'), true);
    assert.equal(after.split('\r\n').join('').includes('\n'), false);
    assert.deepEqual(parseJsonc(after), {
      'workbench.colorTheme': 'Dark',
      'accessibility.signals.error': recorded,
    });
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('mixed batch: delete, replace, append, and idempotent keys in one call', () => {
  const f = fixture();
  try {
    writeSettings(f, [
      '{',
      '  // keep: editor font',
      '  "editor.fontSize": 14,',
      '  "accessibility.signals.warning": {',
      '    "sound": "auto"',
      '  },',
      '  "accessibility.signals.save": {',
      '    "sound": "on"',
      '  },',
      '  "accessibility.signals.lineHasBreakpoint": {',
      '    "sound": "auto",',
      '    "announcement": true',
      '  },',
      '  "workbench.colorTheme": "Dark",',
      '}',
    ]);
    writeLedger(f, {
      'accessibility.signals.save': null,
      'accessibility.signals.lineHasBreakpoint': { announcement: true },
      'accessibility.signals.error': { sound: 'off' },
      'accessibility.signals.warning': { sound: 'auto' },
    });
    const out = restoreSignalSettings(f.storageRoot);
    assert.deepEqual(out, { code: 0 });
    assert.deepEqual(readSettings(f).split('\n'), [
      '{',
      '  // keep: editor font',
      '  "editor.fontSize": 14,',
      '  "accessibility.signals.warning": {',
      '    "sound": "auto"',
      '  },',
      '  "accessibility.signals.lineHasBreakpoint": {"announcement":true},',
      '  "workbench.colorTheme": "Dark",',
      '"accessibility.signals.error": {"sound":"off"},',
      '}',
    ]);
    // And the result still reads as the expected settings object.
    assert.deepEqual(parseJsonc(readSettings(f)), {
      'editor.fontSize': 14,
      'accessibility.signals.warning': { sound: 'auto' },
      'accessibility.signals.lineHasBreakpoint': { announcement: true },
      'workbench.colorTheme': 'Dark',
      'accessibility.signals.error': { sound: 'off' },
    });
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});
