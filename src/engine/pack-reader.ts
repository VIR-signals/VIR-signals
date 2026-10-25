// Voice pack reader: manifest contract validation plus per slot audio
// checks. Manifest level violations reject the whole pack; single broken
// audio entries disable only their slot and the rest of the pack stays
// usable, with a written reason for every disabled slot.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { msg, VirMessage } from './msg';
import { AUDIO_SIZE_LIMIT_BYTES, PACK_MANIFEST_NAME } from './paths';
import { detectFormat, durationSeconds, softLimitForSlot } from './audio-check';
import { sha256Buffer } from './fsutil';
import { RESPONSE_SUB_KEYS, isKnownManifestSlotKey } from './slot-table';

export const SOURCE_LICENSES: ReadonlyArray<string> = [
  'original',
  'game-asset',
  'third-party-cc0',
  'unknown',
];

export type VersionTriple = [number, number, number];

export function parseVersion(v: string): VersionTriple | undefined {
  const parts = v.split('.');
  if (parts.length !== 3) {
    return undefined;
  }
  const out: VersionTriple = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    if (!/^\d+$/.test(parts[i])) {
      return undefined;
    }
    out[i] = Number(parts[i]);
  }
  return out;
}

export function compareVersion(a: VersionTriple, b: VersionTriple): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) {
      return a[i] < b[i] ? -1 : 1;
    }
  }
  return 0;
}

export interface SlotAudio {
  readonly key: string;
  readonly slot: string;
  readonly file: string;
  readonly absPath: string;
  readonly sha256: string;
  readonly seconds: number | undefined;
  readonly warnings: ReadonlyArray<VirMessage>;
}

export interface PackInfo {
  dir: string;
  id: string;
  name: string;
  version: string;
  versionTriple: VersionTriple;
  author: string;
  license: string;
  sourceLicense: string;
  language: string;
  categories: ReadonlyArray<string>;
  slots: Record<string, SlotAudio>;
  disabled: Record<string, VirMessage>;
}

export type ReadPackResult = { ok: true; pack: PackInfo } | { ok: false; error: VirMessage };

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

// Pack side of the shared path contract: forward slashes only, no parent
// escape, no drive letters, no absolute roots, no empty segments. Exported
// because the market chapters validate untrusted entry fields against the
// very same rule before any download starts.
export function checkPathSafety(rel: string): VirMessage | undefined {
  if (rel.length === 0) {
    return msg('pack.pathEmpty');
  }
  if (rel.includes('\\')) {
    return msg('pack.pathSlash', rel);
  }
  if (/^[a-z]:/i.test(rel) || rel.startsWith('/')) {
    return msg('pack.pathAbsolute', rel);
  }
  const segs = rel.split('/');
  if (segs.includes('..')) {
    return msg('pack.pathEscape', rel);
  }
  return undefined;
}

// Walk the relative path segment by segment: exact case match required at
// every step, symlinks rejected at every step.
function resolveCaseChecked(
  packDir: string,
  rel: string
): { abs: string } | VirMessage {
  const segs = rel.split('/');
  let cur = packDir;
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      return msg('pack.audioMissing', rel);
    }
    const hit = entries.find((e) => e.name === seg);
    if (!hit) {
      const ci = entries.find((e) => e.name.toLowerCase() === seg.toLowerCase());
      return ci ? msg('pack.caseMismatch', rel, ci.name) : msg('pack.audioMissing', rel);
    }
    if (hit.isSymbolicLink()) {
      return msg('pack.pathSymlink', rel);
    }
    const abs = path.join(cur, seg);
    if (i < segs.length - 1 && !hit.isDirectory()) {
      return msg('pack.audioMissing', rel);
    }
    if (i === segs.length - 1 && !hit.isFile()) {
      return msg('pack.audioMissing', rel);
    }
    cur = abs;
  }
  return { abs: path.join(packDir, rel) };
}

export function readPack(dir: string): ReadPackResult {
  const manifestPath = path.join(dir, PACK_MANIFEST_NAME);
  if (!fs.existsSync(manifestPath)) {
    return { ok: false, error: msg('pack.manifestMissing', dir) };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    return { ok: false, error: msg('pack.manifestBad', dir) };
  }
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, error: msg('pack.manifestBad', dir) };
  }
  const m = raw as Record<string, unknown>;
  if (m.schema !== 1) {
    if (typeof m.schema === 'number' && m.schema > 1) {
      return { ok: false, error: msg('pack.schemaNewer', String(m.schema)) };
    }
    return { ok: false, error: msg('pack.schemaBad', String(m.schema)) };
  }
  const id = str(m.id);
  const name = str(m.name);
  if (!id || !name) {
    return { ok: false, error: msg('pack.fieldsMissing', dir) };
  }
  const version = str(m.version);
  const triple = parseVersion(version);
  if (!triple) {
    return { ok: false, error: msg('pack.versionBad', version) };
  }
  const license = str(m.license);
  if (!license) {
    return { ok: false, error: msg('pack.fieldsMissing', dir) };
  }
  const sourceLicense = str(m.sourceLicense);
  if (!SOURCE_LICENSES.includes(sourceLicense)) {
    return { ok: false, error: msg('pack.sourceLicenseBad', sourceLicense) };
  }
  const slotsRaw = m.slots;
  if (typeof slotsRaw !== 'object' || slotsRaw === null || Array.isArray(slotsRaw)) {
    return { ok: false, error: msg('pack.slotsMissing', dir) };
  }
  const keys = Object.keys(slotsRaw);
  if (keys.length === 0) {
    return { ok: false, error: msg('pack.slotsMissing', dir) };
  }
  const subUsed = keys.filter((k) => RESPONSE_SUB_KEYS.includes(k));
  if (keys.includes('responseReceived') && subUsed.length > 0) {
    return { ok: false, error: msg('pack.responseShape') };
  }
  const slots: Record<string, SlotAudio> = {};
  const disabled: Record<string, VirMessage> = {};
  for (const key of keys) {
    if (!isKnownManifestSlotKey(key)) {
      return { ok: false, error: msg('pack.unknownSlot', key) };
    }
    const rel = (slotsRaw as Record<string, unknown>)[key];
    if (typeof rel !== 'string') {
      disabled[key] = msg('pack.slotPathBad', key);
      continue;
    }
    const unsafe = checkPathSafety(rel);
    if (unsafe) {
      return { ok: false, error: unsafe };
    }
    const resolved = resolveCaseChecked(dir, rel);
    if ('abs' in resolved === false) {
      disabled[key] = resolved as VirMessage;
      continue;
    }
    const buf = fs.readFileSync(resolved.abs);
    const format = detectFormat(buf);
    if (format === 'unknown') {
      disabled[key] = msg('pack.formatUnknown', rel);
      continue;
    }
    if (buf.length > AUDIO_SIZE_LIMIT_BYTES) {
      disabled[key] = msg('pack.tooBig', rel, buf.length);
      continue;
    }
    const slot = RESPONSE_SUB_KEYS.includes(key) ? 'responseReceived' : key;
    const seconds = durationSeconds(buf, format);
    const warnings: VirMessage[] = [];
    if (seconds !== undefined && seconds > softLimitForSlot(slot)) {
      warnings.push(msg('pack.tooLong', slot, Math.round(seconds * 10) / 10, softLimitForSlot(slot)));
    }
    slots[key] = {
      key,
      slot,
      file: rel,
      absPath: resolved.abs,
      sha256: sha256Buffer(buf),
      seconds,
      warnings,
    };
  }
  if (Object.keys(slots).length === 0) {
    return { ok: false, error: msg('pack.noUsableSlots', id) };
  }
  const categories = Array.isArray(m.categories)
    ? (m.categories as unknown[]).filter((c): c is string => typeof c === 'string')
    : [];
  return {
    ok: true,
    pack: {
      dir,
      id,
      name,
      version,
      versionTriple: triple,
      author: str(m.author),
      license,
      sourceLicense,
      language: str(m.language) || 'none',
      categories,
      slots,
      disabled,
    },
  };
}

// Look up a usable pack by id in the pack folder.
export function findPackById(packsDir: string, id: string): PackInfo | undefined {
  if (id === '') {
    return undefined;
  }
  for (const s of scanPacks(packsDir)) {
    if (s.result.ok && s.result.pack.id === id) {
      return s.result.pack;
    }
  }
  return undefined;
}

export interface ScannedPack {
  dir: string;
  folderName: string;
  result: ReadPackResult;
}

// Scan the pack folder in deterministic folder order: a repeated id rejects
// the later arrival.
export function scanPacks(packsDir: string): ScannedPack[] {
  if (!fs.existsSync(packsDir)) {
    return [];
  }
  const out: ScannedPack[] = [];
  const seen = new Set<string>();
  const entries = fs
    .readdirSync(packsDir, { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : 1));
  for (const ent of entries) {
    if (!ent.isDirectory() || ent.isSymbolicLink()) {
      continue;
    }
    const dir = path.join(packsDir, ent.name);
    let result = readPack(dir);
    if (result.ok && seen.has(result.pack.id)) {
      result = { ok: false, error: msg('pack.duplicateId', result.pack.id) };
    }
    if (result.ok) {
      seen.add(result.pack.id);
    }
    out.push({ dir, folderName: ent.name, result });
  }
  return out;
}
