// Runtime language selection for UI messages. The extension host caches its
// l10n bundle choice per process, so an extension installed while the
// editor is running renders the default English strings until a full
// restart. Reading the bundle files directly and picking them by the window
// language makes every message follow the user configuration from the very
// first activation, restart or not. Command palette titles come from the
// manifest and stay subject to the platform cache; a restart fixes those.
import * as fs from 'node:fs';
import * as path from 'node:path';

export type Bundle = Record<string, string>;

const cache = new Map<string, Bundle>();

// Any Chinese variant falls back to the simplified bundle; everything else
// uses the default English bundle.
export function bundleFileNameFor(language: string): string {
  return language.toLowerCase().startsWith('zh')
    ? 'bundle.l10n.zh-cn.json'
    : 'bundle.l10n.json';
}

// The bundle directory from the compiled file location: out/ui -> l10n.
export function bundleDirFrom(startDir: string): string {
  return path.join(startDir, '..', '..', 'l10n');
}

export function loadBundle(dir: string, fileName: string): Bundle {
  const key = dir + '|' + fileName;
  const hit = cache.get(key);
  if (hit !== undefined) {
    return hit;
  }
  const loaded = JSON.parse(fs.readFileSync(path.join(dir, fileName), 'utf8')) as Bundle;
  cache.set(key, loaded);
  return loaded;
}

export function formatPlaceholders(text: string, args: ReadonlyArray<string | number>): string {
  return text.replace(/\{(\d+)\}/g, (m, i) => {
    const idx = Number(i);
    return idx < args.length ? String(args[idx]) : m;
  });
}

// A missing key passes through as itself, mirroring the platform l10n API.
export function lookup(bundle: Bundle, key: string, args: ReadonlyArray<string | number>): string {
  const raw = bundle[key];
  return raw === undefined ? key : formatPlaceholders(raw, args);
}
