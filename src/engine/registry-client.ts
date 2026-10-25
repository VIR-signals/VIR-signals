// Registry index client: fetch registry.json through the three-hop
// transport, gate on the schema field, and parse every entry as untrusted
// input. A broken index is refused whole — one bad entry never silently
// disappears from the list. Zero vscode imports.
import { msg, VirMessage } from './msg';
import {
  buildHopUrls,
  fetchFile,
  HopAttempt,
  RawIo,
  REGISTRY_LIMIT_BYTES,
  TEXT_HOP_TIMEOUT_MS,
} from './net-fetch';
import { checkPathSafety, parseVersion } from './pack-reader';

export const REGISTRY_BRANCH = 'main';
export const REGISTRY_FILE = 'registry.json';

const RE_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const RE_REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const RE_COMMIT = /^[0-9a-f]{40}$/;
const RE_LOCALE = /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/;
const CATEGORIES = ['game', 'ui', 'voice', 'ambient', 'fun', 'other'];

export interface RegistryEntry {
  id: string;
  names: Readonly<Record<string, string>>;
  categories: ReadonlyArray<string>;
  language: string;
  author: string;
  version: string;
  repo: string;
  branch: string;
  commit: string;
  packPath: string;
  license: string;
  sourceLicense: string;
}

export type RegistryFetch =
  | { ok: true; entries: RegistryEntry[] }
  | {
      ok: false;
      reason: 'registry.net' | 'registry.parse' | 'registry.schema' | 'registry.shape' | 'registry.entry';
      error: VirMessage;
      attempts: HopAttempt[];
    };

export interface RegistryOptions {
  registryRepo: string;
  mirrorPrefix: string;
  signal?: AbortSignal;
}

function parseEntry(rawEntry: unknown, index: number): RegistryEntry | VirMessage {
  const where = String(index);
  if (typeof rawEntry !== 'object' || rawEntry === null || Array.isArray(rawEntry)) {
    return msg('registry.entryShape', where);
  }
  const e = rawEntry as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  const id = str(e.id);
  if (id === '' || !RE_ID.test(id)) {
    return msg('registry.entryId', where);
  }
  for (const field of ['author', 'version', 'repo', 'branch', 'license', 'sourceLicense', 'packPath', 'language']) {
    if (str(e[field]) === '') {
      return msg('registry.entryField', where, field);
    }
  }
  const commit = str(e.commit);
  if (!RE_COMMIT.test(commit)) {
    return msg('registry.entryCommit', where);
  }
  const repo = str(e.repo);
  if (!RE_REPO.test(repo)) {
    return msg('registry.entryRepo', where);
  }
  const packPath = str(e.packPath);
  // Entry pack paths follow the registry rule set, which additionally bans
  // empty segments.
  if (packPath.split('/').includes('') || checkPathSafety(packPath)) {
    return msg('registry.entryPackPath', where);
  }
  if (parseVersion(str(e.version)) === undefined) {
    return msg('registry.entryVersion', where);
  }
  // Display only fields get the same gate as the registry repository: the
  // index is untrusted input here, not something a CI upstream already
  // vetted.
  const language = str(e.language);
  if (language !== 'none' && !RE_LOCALE.test(language)) {
    return msg('registry.entryLanguage', where);
  }
  const namesRaw = e.names ?? {};
  if (typeof namesRaw !== 'object' || namesRaw === null || Array.isArray(namesRaw)) {
    return msg('registry.entryNames', where);
  }
  const names: Record<string, string> = {};
  for (const locale of Object.keys(namesRaw)) {
    if (!RE_LOCALE.test(locale)) {
      return msg('registry.entryNames', where);
    }
    const v = (namesRaw as Record<string, unknown>)[locale];
    if (typeof v !== 'string' || v === '') {
      return msg('registry.entryNames', where);
    }
    names[locale] = v;
  }
  if (e.categories !== undefined) {
    if (!Array.isArray(e.categories)) {
      return msg('registry.entryCategories', where);
    }
    for (const c of e.categories as unknown[]) {
      if (typeof c !== 'string' || !CATEGORIES.includes(c)) {
        return msg('registry.entryCategories', where);
      }
    }
  }
  const categories = Array.isArray(e.categories) ? (e.categories as string[]) : [];
  return {
    id,
    names,
    categories,
    language,
    author: str(e.author),
    version: str(e.version),
    repo,
    branch: str(e.branch),
    commit,
    packPath,
    license: str(e.license),
    sourceLicense: str(e.sourceLicense),
  };
}

export async function fetchRegistry(rawIo: RawIo, opts: RegistryOptions): Promise<RegistryFetch> {
  const urls = buildHopUrls({
    repo: opts.registryRepo,
    ref: REGISTRY_BRANCH,
    filePath: REGISTRY_FILE,
    mirrorPrefix: opts.mirrorPrefix,
  });
  const signal = opts.signal ?? new AbortController().signal;
  const r = await fetchFile(rawIo, urls, REGISTRY_LIMIT_BYTES, TEXT_HOP_TIMEOUT_MS, signal);
  if (!r.ok) {
    return { ok: false, reason: 'registry.net', error: msg('registry.net'), attempts: r.attempts };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(r.data.toString('utf8'));
  } catch {
    return { ok: false, reason: 'registry.parse', error: msg('registry.parse'), attempts: [] };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: 'registry.shape', error: msg('registry.shape'), attempts: [] };
  }
  const m = parsed as Record<string, unknown>;
  if (m.schema !== 1) {
    return { ok: false, reason: 'registry.schema', error: msg('registry.schema', String(m.schema)), attempts: [] };
  }
  if (!Array.isArray(m.packs)) {
    return { ok: false, reason: 'registry.shape', error: msg('registry.shape'), attempts: [] };
  }
  const entries: RegistryEntry[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < m.packs.length; i++) {
    const entry = parseEntry(m.packs[i], i);
    if ('key' in entry) {
      return { ok: false, reason: 'registry.entry', error: entry, attempts: [] };
    }
    if (seen.has(entry.id)) {
      return { ok: false, reason: 'registry.entry', error: msg('registry.entryDup', entry.id), attempts: [] };
    }
    seen.add(entry.id);
    entries.push(entry);
  }
  return { ok: true, entries };
}

// Display name for an entry: exact locale, then the primary language
// subtag (zh-cn falls back to zh), then the id itself. Pure and testable.
export function displayName(entry: RegistryEntry, locale: string): string {
  const exact = entry.names[locale];
  if (exact !== undefined) {
    return exact;
  }
  const primary = locale.split('-')[0];
  if (primary !== '' && entry.names[primary] !== undefined) {
    return entry.names[primary];
  }
  return entry.id;
}
