// Market installer: fetch a pack from an author repository at an immutable
// commit into a temp directory OUTSIDE the packs folder, validate it whole
// with the pack reader, then land it with a three step swap so an update
// never destroys the working old pack. Direct install resolves a branch
// head to a SHA first, so a branch moving later cannot change what the
// user already locked in. Zero vscode imports.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { msg, VirMessage } from './msg';
import {
  AUDIO_LIMIT_BYTES,
  buildHopUrls,
  fetchFile,
  fetchFiles,
  HopAttempt,
  HOP_TIMEOUT_MS,
  MANIFEST_LIMIT_BYTES,
  PACK_CONCURRENCY,
  PACK_DEADLINE_MS,
  RawIo,
  SOURCE_TXT_LIMIT_BYTES,
} from './net-fetch';
import {
  checkPathSafety,
  compareVersion,
  PackInfo,
  parseVersion,
  readPack,
  scanPacks,
} from './pack-reader';
import { PACKS_DIR_NAME, PACK_MANIFEST_NAME } from './paths';

const RE_REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const RE_COMMIT = /^[0-9a-f]{40}$/;
export const DIRECT_DEFAULT_PACK_PATH = 'pack';
export const DIRECT_DEFAULT_BRANCH = 'main';
const ORIGIN_NAME = '.vir-origin.json';
// Names the installer itself writes into the temp pack; a slot pointing at
// one of them would collide during download, so they are reserved.
const RESERVED_SLOT_TARGETS: ReadonlyArray<string> = [
  PACK_MANIFEST_NAME,
  'SOURCE.txt',
  ORIGIN_NAME,
];
const INSTALLING_DIR_NAME = 'installing';
const OLD_TMP_SUFFIX = '.vir-old';

export interface PackLocation {
  repo: string;
  commit: string;
  packPath: string;
}

export interface InstallOptions {
  storageDir: string;
  rawIo: RawIo;
  mirrorPrefix: string;
  owner: string;
  signal?: AbortSignal;
}

export type InstallOutcome =
  | { status: 'installed'; pack: PackInfo; warnings: VirMessage[] }
  | { status: 'updated'; pack: PackInfo; warnings: VirMessage[] }
  | { status: 'uptoDate'; packId: string; localVersion: string }
  | { status: 'failed'; error: VirMessage; attempts: HopAttempt[] };

interface RemoteManifest {
  id: string;
  name: string;
  version: string;
  author: string;
  license: string;
  sourceLicense: string;
  slots: Record<string, string>;
  raw: Buffer;
}

function strOf(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function fail(error: VirMessage, attempts: HopAttempt[] = []): InstallOutcome {
  return { status: 'failed', error, attempts };
}

// One file through the hop chain at a location, keeping every attempt.
async function fetchAt(
  rawIo: RawIo,
  loc: PackLocation,
  relPath: string,
  limitBytes: number,
  mirrorPrefix: string,
  signal: AbortSignal,
  headers?: Record<string, string>
): Promise<{ ok: true; data: Buffer } | { ok: false; attempts: HopAttempt[] }> {
  const urls = buildHopUrls({
    repo: loc.repo,
    ref: loc.commit,
    filePath: loc.packPath === '' ? relPath : loc.packPath + '/' + relPath,
    mirrorPrefix,
  });
  const r = await fetchFile(rawIo, urls, limitBytes, HOP_TIMEOUT_MS, signal, headers);
  return r.ok ? { ok: true, data: r.data } : { ok: false, attempts: r.attempts };
}

export async function fetchRemoteManifest(
  rawIo: RawIo,
  loc: PackLocation,
  mirrorPrefix: string,
  signal?: AbortSignal
): Promise<
  { ok: true; manifest: RemoteManifest } | { ok: false; error: VirMessage; attempts: HopAttempt[] }
> {
  if (!RE_REPO.test(loc.repo)) {
    return { ok: false, error: msg('install.repoBad', loc.repo), attempts: [] };
  }
  if (!RE_COMMIT.test(loc.commit)) {
    return { ok: false, error: msg('install.commitBad', loc.commit), attempts: [] };
  }
  const unsafe = checkPathSafety(loc.packPath);
  if (unsafe || loc.packPath === '' || loc.packPath.split('/').includes('')) {
    return { ok: false, error: msg('install.packPathBad', loc.packPath), attempts: [] };
  }
  const sig = signal ?? new AbortController().signal;
  const r = await fetchAt(rawIo, loc, PACK_MANIFEST_NAME, MANIFEST_LIMIT_BYTES, mirrorPrefix, sig);
  if (!r.ok) {
    return { ok: false, error: msg('install.manifestNet'), attempts: r.attempts };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(r.data.toString('utf8'));
  } catch {
    return { ok: false, error: msg('install.manifestParse'), attempts: [] };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: msg('install.manifestParse'), attempts: [] };
  }
  const m = parsed as Record<string, unknown>;
  const id = strOf(m.id);
  const name = strOf(m.name);
  const version = strOf(m.version);
  if (id === '' || name === '' || parseVersion(version) === undefined) {
    return { ok: false, error: msg('install.manifestFields'), attempts: [] };
  }
  if (typeof m.slots !== 'object' || m.slots === null || Array.isArray(m.slots)) {
    return { ok: false, error: msg('install.manifestSlots'), attempts: [] };
  }
  const slots: Record<string, string> = {};
  for (const key of Object.keys(m.slots)) {
    const rel = (m.slots as Record<string, unknown>)[key];
    if (typeof rel !== 'string' || rel === '') {
      return { ok: false, error: msg('install.slotPathBad', key), attempts: [] };
    }
    slots[key] = rel;
  }
  return {
    ok: true,
    manifest: {
      id,
      name,
      version,
      author: strOf(m.author),
      license: strOf(m.license),
      sourceLicense: strOf(m.sourceLicense),
      slots,
      raw: r.data,
    },
  };
}

// Resolve a branch head to its commit SHA through the GitHub REST API. The
// jsDelivr hop does not proxy the API, so this chain is direct plus mirror.
export async function resolveBranchHead(
  rawIo: RawIo,
  repo: string,
  branch: string,
  mirrorPrefix: string,
  signal?: AbortSignal
): Promise<{ ok: true; sha: string } | { ok: false; error: VirMessage; attempts: HopAttempt[] }> {
  if (!RE_REPO.test(repo) || branch === '') {
    return { ok: false, error: msg('direct.repoBad', repo), attempts: [] };
  }
  const sig = signal ?? new AbortController().signal;
  const [owner, name] = repo.split('/');
  const api =
    'https://api.github.com/repos/' +
    encodeURIComponent(owner) + '/' + encodeURIComponent(name) +
    '/commits/' + encodeURIComponent(branch);
  const urls = [api];
  if (mirrorPrefix !== '') {
    urls.push(mirrorPrefix + api);
  }
  const r = await fetchFile(rawIo, urls, MANIFEST_LIMIT_BYTES, HOP_TIMEOUT_MS, sig, {
    'user-agent': 'vir-signs',
    accept: 'application/vnd.github+json',
  });
  if (!r.ok) {
    return { ok: false, error: msg('direct.resolveNet'), attempts: r.attempts };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(r.data.toString('utf8'));
  } catch {
    return { ok: false, error: msg('direct.resolveParse'), attempts: [] };
  }
  const sha =
    typeof parsed === 'object' && parsed !== null
      ? strOf((parsed as Record<string, unknown>).sha)
      : '';
  if (!RE_COMMIT.test(sha)) {
    return { ok: false, error: msg('direct.resolveShape'), attempts: [] };
  }
  return { ok: true, sha };
}

// Parse the two direct-install input shapes: owner/repo (default pack path)
// and owner/repo/packPath.
export function parseDirectInput(
  input: string
): { ok: true; repo: string; packPath: string } | { ok: false; error: VirMessage } {
  const trimmed = input.trim();
  const segs = trimmed.split('/').filter((s) => s !== '');
  if (segs.length < 2) {
    return { ok: false, error: msg('direct.inputShape', trimmed) };
  }
  const repo = segs[0] + '/' + segs[1];
  if (!RE_REPO.test(repo)) {
    return { ok: false, error: msg('direct.repoBad', repo) };
  }
  const packPath = segs.length === 2 ? DIRECT_DEFAULT_PACK_PATH : segs.slice(2).join('/');
  const unsafe = checkPathSafety(packPath);
  if (unsafe || packPath === '') {
    return { ok: false, error: msg('direct.packPathBad', packPath) };
  }
  return { ok: true, repo, packPath };
}

function tmpRootFor(storageDir: string, id: string, owner: string): string {
  return path.join(storageDir, INSTALLING_DIR_NAME, id + '-' + owner.slice(0, 8));
}

function writeUnder(root: string, rel: string, data: Buffer): void {
  const target = path.resolve(root, rel);
  if (target !== path.resolve(root) && !target.startsWith(path.resolve(root) + path.sep)) {
    throw new Error('install.escape:' + rel);
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, data);
}

interface LocalState {
  dir: string;
  version: string;
  triple: [number, number, number];
}

function findLocal(packsDir: string, id: string): LocalState | undefined {
  for (const s of scanPacks(packsDir)) {
    if (s.result.ok && s.result.pack.id === id) {
      return {
        dir: s.dir,
        version: s.result.pack.version,
        triple: s.result.pack.versionTriple,
      };
    }
  }
  return undefined;
}

// Download gates shared by the installer and the audition download: every
// slot path must pass the pack path contract before any transfer starts,
// and none may point at the installer reserved names, where a download
// would overwrite the manifest, the source note, or the origin record.
export function gateManifestSlots(slots: Record<string, string>): VirMessage | undefined {
  for (const key of Object.keys(slots)) {
    const rel = slots[key];
    const unsafe = checkPathSafety(rel);
    if (unsafe) {
      return msg('install.slotUnsafe', key);
    }
    if (RESERVED_SLOT_TARGETS.includes(rel)) {
      return msg('install.slotReserved', key, rel);
    }
  }
  return undefined;
}

export async function installPack(
  rawIo: RawIo,
  loc: PackLocation,
  opts: InstallOptions,
  expect?: { id: string; version: string; license: string; author: string; sourceLicense: string }
): Promise<InstallOutcome> {
  const signal = opts.signal ?? new AbortController().signal;
  const manifestR = await fetchRemoteManifest(rawIo, loc, opts.mirrorPrefix, signal);
  if (!manifestR.ok) {
    return fail(manifestR.error, manifestR.attempts);
  }
  const manifest = manifestR.manifest;
  const warnings: VirMessage[] = [];
  if (expect) {
    if (manifest.id !== expect.id || manifest.version !== expect.version) {
      return fail(msg('install.mismatch', manifest.id, manifest.version, expect.id, expect.version));
    }
    if (manifest.license !== expect.license) {
      warnings.push(msg('install.conflict.license', manifest.license, expect.license));
    }
    if (manifest.author !== expect.author) {
      warnings.push(msg('install.conflict.author', manifest.author, expect.author));
    }
    if (manifest.sourceLicense !== expect.sourceLicense) {
      warnings.push(msg('install.conflict.sourceLicense', manifest.sourceLicense, expect.sourceLicense));
    }
  }

  // Download gates before any transfer: every slot path must pass the pack
  // path contract here, not after the bytes arrive; and none may point at
  // the installer reserved names, where a download would overwrite the
  // manifest, the source note, or the origin record.
  const gate = gateManifestSlots(manifest.slots);
  if (gate !== undefined) {
    return fail(gate);
  }

  const packsDir = path.join(opts.storageDir, PACKS_DIR_NAME);
  const local = findLocal(packsDir, manifest.id);
  const remoteTriple = parseVersion(manifest.version);
  if (remoteTriple === undefined) {
    return fail(msg('install.manifestFields'));
  }
  if (local !== undefined) {
    if (path.basename(local.dir) !== manifest.id) {
      return fail(msg('install.manualDirConflict', manifest.id, path.basename(local.dir)));
    }
    if (compareVersion(remoteTriple, local.triple) <= 0) {
      return { status: 'uptoDate', packId: manifest.id, localVersion: local.version };
    }
  }

  const tmp = tmpRootFor(opts.storageDir, manifest.id, opts.owner);
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  try {
    writeUnder(tmp, PACK_MANIFEST_NAME, manifest.raw);
    const jobs: Array<{ urls: ReadonlyArray<string>; limitBytes: number; name: string }> = [];
    const rels: Record<string, string> = {};
    for (const key of Object.keys(manifest.slots)) {
      const rel = manifest.slots[key];
      rels[rel] = rel;
    }
    for (const rel of Object.keys(rels)) {
      jobs.push({
        name: rel,
        urls: buildHopUrls({
          repo: loc.repo,
          ref: loc.commit,
          filePath: loc.packPath + '/' + rel,
          mirrorPrefix: opts.mirrorPrefix,
        }),
        limitBytes: AUDIO_LIMIT_BYTES,
      });
    }
    jobs.push({
      name: 'SOURCE.txt',
      urls: buildHopUrls({
        repo: loc.repo,
        ref: loc.commit,
        filePath: loc.packPath + '/SOURCE.txt',
        mirrorPrefix: opts.mirrorPrefix,
      }),
      limitBytes: SOURCE_TXT_LIMIT_BYTES,
    });
    const results = await fetchFiles(rawIo, jobs, {
      timeoutMs: HOP_TIMEOUT_MS,
      deadlineMs: PACK_DEADLINE_MS,
      concurrency: PACK_CONCURRENCY,
      signal,
    });
    for (const r of results) {
      if (r.ok) {
        writeUnder(tmp, r.name === 'SOURCE.txt' ? 'SOURCE.txt' : r.name, r.data);
        continue;
      }
      // SOURCE.txt is optional: only an all-404 chain means it is absent.
      if (
        r.name === 'SOURCE.txt' &&
        r.attempts.length > 0 &&
        r.attempts.every((a) => a.failure === 'net.httpStatus' && a.detail.args[1] === 404)
      ) {
        continue;
      }
      return fail(msg('install.fileFailed', r.name), r.attempts);
    }

    // Whole pack validation: reader ok AND no disabled slot at all.
    const read = readPack(tmp);
    if (!read.ok) {
      return fail(read.error);
    }
    if (Object.keys(read.pack.disabled).length > 0) {
      return fail(msg('install.disabledSlots', Object.keys(read.pack.disabled).join(',')));
    }

    const target = path.join(packsDir, manifest.id);
    fs.mkdirSync(packsDir, { recursive: true });
    const origin = {
      repo: loc.repo,
      commit: loc.commit,
      packPath: loc.packPath,
      installedAt: new Date().toISOString(),
    };
    writeUnder(tmp, ORIGIN_NAME, Buffer.from(JSON.stringify(origin, null, 2), 'utf8'));

    if (local === undefined) {
      fs.renameSync(tmp, target);
      return { status: 'installed', pack: read.pack, warnings };
    }
    const hold = target + OLD_TMP_SUFFIX;
    fs.rmSync(hold, { recursive: true, force: true });
    fs.renameSync(target, hold);
    try {
      fs.renameSync(tmp, target);
    } catch {
      // Put the old pack back first; only then report the structured failure.
      fs.renameSync(hold, target);
      return fail(msg('install.rollback'));
    }
    fs.rmSync(hold, { recursive: true, force: true });
    return { status: 'updated', pack: read.pack, warnings };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// Whole-pack audition download: fetch the manifest and every slot audio
// into the caller's preview folder OUTSIDE the packs folder, then validate
// the pack exactly like the installer would, so what the audition panel
// plays is what an install would land. SOURCE.txt is provenance for
// installed packs and is not fetched here. On any failure the folder is
// removed again; on success the caller owns the cleanup.
export type PreviewOutcome =
  | { ok: true; pack: PackInfo }
  | { ok: false; error: VirMessage; attempts: HopAttempt[] };

export async function downloadPackForPreview(
  rawIo: RawIo,
  loc: PackLocation,
  mirrorPrefix: string,
  dir: string,
  signal?: AbortSignal
): Promise<PreviewOutcome> {
  const sig = signal ?? new AbortController().signal;
  // Clear any stale folder a crashed panel left behind before anything
  // else, so even an early failure (manifest unreachable, gate rejection)
  // leaves no leftover behind; the fresh folder only appears once the
  // gates have passed.
  fs.rmSync(dir, { recursive: true, force: true });
  const manifestR = await fetchRemoteManifest(rawIo, loc, mirrorPrefix, sig);
  if (!manifestR.ok) {
    return { ok: false, error: manifestR.error, attempts: manifestR.attempts };
  }
  const manifest = manifestR.manifest;
  const gate = gateManifestSlots(manifest.slots);
  if (gate !== undefined) {
    return { ok: false, error: gate, attempts: [] };
  }
  fs.mkdirSync(dir, { recursive: true });
  let keep = false;
  try {
    writeUnder(dir, PACK_MANIFEST_NAME, manifest.raw);
    const jobs: Array<{ urls: ReadonlyArray<string>; limitBytes: number; name: string }> = [];
    const rels: Record<string, string> = {};
    for (const key of Object.keys(manifest.slots)) {
      rels[manifest.slots[key]] = manifest.slots[key];
    }
    for (const rel of Object.keys(rels)) {
      jobs.push({
        name: rel,
        urls: buildHopUrls({
          repo: loc.repo,
          ref: loc.commit,
          filePath: loc.packPath + '/' + rel,
          mirrorPrefix,
        }),
        limitBytes: AUDIO_LIMIT_BYTES,
      });
    }
    const results = await fetchFiles(rawIo, jobs, {
      timeoutMs: HOP_TIMEOUT_MS,
      deadlineMs: PACK_DEADLINE_MS,
      concurrency: PACK_CONCURRENCY,
      signal: sig,
    });
    for (const r of results) {
      if (!r.ok) {
        return { ok: false, error: msg('install.fileFailed', r.name), attempts: r.attempts };
      }
      writeUnder(dir, r.name, r.data);
    }
    const read = readPack(dir);
    if (!read.ok) {
      return { ok: false, error: read.error, attempts: [] };
    }
    if (Object.keys(read.pack.disabled).length > 0) {
      return {
        ok: false,
        error: msg('install.disabledSlots', Object.keys(read.pack.disabled).join(',')),
        attempts: [],
      };
    }
    keep = true;
    return { ok: true, pack: read.pack };
  } finally {
    if (!keep) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}
