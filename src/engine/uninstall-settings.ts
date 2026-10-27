// Uninstall settings restore: the extension flips editor signal settings on
// and off while it is installed; the uninstall hook puts them back to the
// values recorded in the ledger before the platform deletes the storage.
// Runs in the bare hook process, so the user settings file is edited as
// text: comments and trailing commas of the JSONC format must survive, a
// rewrite that no longer parses is rolled back and reported.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { STATE_NAME } from './paths';
import { atomicWriteFile } from './fsutil';

export type UninstallOutcome =
  | { code: 0 }
  | { code: 1; why: string }
  | { code: 2; why: string };

interface LedgerShape {
  signalToggles?: Record<string, unknown>;
}

function settingsPathFromStorage(storageRoot: string): string {
  // storageRoot = <user-data>/User/globalStorage/vir-signals.vir-signals
  return path.resolve(storageRoot, '..', '..', 'settings.json');
}

// Tolerant JSONC read: comments and trailing commas are accepted, exactly
// like the editor itself treats the file.
function readJsonc(text: string): Record<string, unknown> | undefined {
  const noComments = text
    .split(/\r?\n/)
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n');
  const noTrailing = noComments.replace(/,(\s*[}\]])/g, '$1');
  try {
    return JSON.parse(noTrailing) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

// Locate the entry lines of a key: flat object or single line scalar. The
// signal settings this module touches are always flat objects. Comment lines
// never count, even when they quote a key verbatim.
function findEntry(lines: string[], key: string): { start: number; end: number } | undefined {
  const anchor = `"${key}"`;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim().startsWith('//')) {
      continue;
    }
    const idx = lines[i].indexOf(anchor);
    if (idx !== -1 && lines[i].slice(idx + anchor.length).trimStart().startsWith(':')) {
      let depth = 0;
      let j = i;
      do {
        depth += (lines[j].match(/\{/g) ?? []).length - (lines[j].match(/\}/g) ?? []).length;
        j += 1;
      } while (j < lines.length && depth > 0);
      return { start: i, end: j }; // end exclusive
    }
  }
  return undefined;
}

function removeKey(text: string, key: string): string | undefined {
  const lines = text.split('\n');
  const entry = findEntry(lines, key);
  if (entry === undefined) {
    return undefined;
  }
  lines.splice(entry.start, entry.end - entry.start);
  // Tidy a doubled comma where two neighbors met: `},\n    ,` cannot happen
  // here (the removed entry carried its own), so only a leftover empty line
  // is dropped.
  return lines.join('\n');
}

function textEol(text: string): string {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

function replaceKey(text: string, key: string, valueText: string): string | undefined {
  const lines = text.split(textEol(text));
  const entry = findEntry(lines, key);
  if (entry === undefined) {
    return undefined;
  }
  const idx = lines[entry.start].indexOf(`"${key}"`);
  const hadComma = /,\s*$/.test(lines[entry.end - 1]);
  const one = `${' '.repeat(idx)}"${key}": ${valueText}${hadComma ? ',' : ''}`;
  lines.splice(entry.start, entry.end - entry.start, one);
  return lines.join(textEol(text));
}

function appendKey(text: string, key: string, valueText: string): string {
  const eol = textEol(text);
  const lines = text.split(eol);
  let last = lines.length - 1;
  while (last >= 0 && lines[last].trim() === '') {
    last -= 1;
  }
  const closeIdx = lines[last].lastIndexOf('}');
  if (closeIdx === -1) {
    throw new Error('settings.noRoot');
  }
  if (lines[last].trim().startsWith('}')) {
    // The brace stands on its own line: the entry before it must end with a
    // comma before the new one joins in (a last entry without a comma is the
    // editor writer's usual shape).
    let prev = last - 1;
    while (prev >= 0 && lines[prev].trim() === '') {
      prev -= 1;
    }
    if (prev >= 0 && !/,\s*$/.test(lines[prev])) {
      lines[prev] = lines[prev].replace(/\s*$/, ',');
    }
    const indent = ' '.repeat(closeIdx);
    lines.splice(last, 0, `${indent}"${key}": ${valueText},`);
  } else {
    // The brace shares its line with the last entry: separate with a comma.
    const head = lines[last].slice(0, closeIdx).replace(/\s*$/, '');
    lines[last] =
      `${head}${head.endsWith(',') ? '' : ','}${eol}` +
      `${' '.repeat(closeIdx)}"${key}": ${valueText} ${lines[last].slice(closeIdx)}`;
  }
  return lines.join(eol);
}

export function restoreSignalSettings(storageRoot: string): UninstallOutcome {
  const statePath = path.join(storageRoot, STATE_NAME);
  let ledger: LedgerShape;
  try {
    ledger = JSON.parse(fs.readFileSync(statePath, 'utf8')) as LedgerShape;
  } catch {
    // No ledger or an unreadable one: there is nothing recorded to restore.
    return { code: 0 };
  }
  const toggles = ledger.signalToggles;
  if (toggles === undefined || Object.keys(toggles).length === 0) {
    return { code: 0 };
  }

  const settingsPath = settingsPathFromStorage(storageRoot);
  if (!fs.existsSync(settingsPath)) {
    // The settings file is gone while recorded values exist: recreate it
    // holding the recorded originals, nothing else.
    const entries = Object.keys(toggles)
      .filter((k) => toggles[k] !== null)
      .map((k) => `  "${k}": ${JSON.stringify(toggles[k])},`);
    if (entries.length === 0) {
      return { code: 0 };
    }
    try {
      atomicWriteFile(settingsPath, `{\n${entries.join('\n')}\n}\n`);
    } catch (e) {
      return { code: 2, why: `settings.writeFailed: ${(e as Error).message}` };
    }
    return { code: 0 };
  }

  const original = fs.readFileSync(settingsPath, 'utf8');
  let text = original;
  try {
    for (const key of Object.keys(toggles)) {
      const recorded = toggles[key];
      const current = readJsonc(text)?.[key];
      const target = recorded === null ? undefined : recorded;
      if (JSON.stringify(current) === JSON.stringify(target)) {
        continue; // already at the recorded original
      }
      if (target === undefined) {
        text = removeKey(text, key) ?? text;
        continue;
      }
      const asText = JSON.stringify(target);
      const rewritten = replaceKey(text, key, asText);
      text = rewritten !== undefined ? rewritten : appendKey(text, key, asText);
    }
    if (text === original) {
      return { code: 0 };
    }
    // A rewrite that no longer parses is never shipped.
    if (readJsonc(text) === undefined) {
      return { code: 2, why: 'settings.rewriteUnparsable' };
    }
    atomicWriteFile(settingsPath, text);
    return { code: 0 };
  } catch (e) {
    return { code: 2, why: `settings.restoreFailed: ${(e as Error).message}` };
  }
}
