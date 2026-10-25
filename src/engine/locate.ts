// Mechanism one: locate the official sound directory. The running editor app
// root is the natural starting point; the bin scripts are the authority on
// which version folder is active. No disk wide guessing, no configured path
// tables: every value is resolved at runtime.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { VirMessage, msg } from './msg';
import { mediaDirUnder } from './paths';
import { OFFICIAL_FILES } from './slot-table';

export interface Fingerprint {
  readonly version: string;
  readonly commit: string;
}

export interface Located {
  readonly installRoot: string;
  readonly versionDir: string;
  readonly appRoot: string;
  readonly mediaDir: string;
  readonly fingerprint: Fingerprint;
  /** Official files that actually exist here; variants may lack some. */
  readonly presentFiles: ReadonlyArray<string>;
  /** Official files absent here; their slots keep official behavior. */
  readonly missingFiles: ReadonlyArray<string>;
}

export type LocateResult =
  | { ok: true; located: Located }
  | { ok: false; error: VirMessage };

function up3(p: string): string {
  return path.dirname(path.dirname(path.dirname(p)));
}

function readText(p: string): string | undefined {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return undefined;
  }
}

function readFingerprint(p: string): Fingerprint | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as {
      version?: unknown;
      commit?: unknown;
    };
    if (typeof raw.version !== 'string' || typeof raw.commit !== 'string') {
      return undefined;
    }
    return { version: raw.version, commit: raw.commit };
  } catch {
    return undefined;
  }
}

function isVersionDirCandidate(installRoot: string, dir: string | undefined): string | undefined {
  if (!dir || !/^[0-9a-f]{6,12}$/.test(dir)) {
    return undefined;
  }
  return fs.existsSync(path.join(installRoot, dir, 'resources')) ? dir : undefined;
}

// Version folder resolution from the install root, three ways in order of
// authority: the bin sh pointer, the bin cmd path pattern, then the commit
// prefix directory. Shared by locate and the uninstall hook.
export function resolveVersionDir(installRoot: string, commitPrefix: string | undefined): string | undefined {
  let versionDir: string | undefined;
  const codeSh = readText(path.join(installRoot, 'bin', 'code'));
  const m = codeSh !== undefined ? /VERSIONFOLDER="([0-9a-f]{6,12})"/.exec(codeSh) : undefined;
  if (m) {
    versionDir = isVersionDirCandidate(installRoot, m[1]);
  }
  if (versionDir === undefined) {
    const codeCmd = readText(path.join(installRoot, 'bin', 'code.cmd'));
    const m2 = codeCmd !== undefined ? /\\([0-9a-f]{6,12})\\resources/.exec(codeCmd) : undefined;
    if (m2) {
      versionDir = isVersionDirCandidate(installRoot, m2[1]);
    }
  }
  if (versionDir === undefined && commitPrefix !== undefined) {
    versionDir = isVersionDirCandidate(installRoot, commitPrefix);
  }
  return versionDir;
}

export function locate(appRoot: string, manualInstallPath: string): LocateResult {
  const manual = manualInstallPath.trim();
  let base: string;
  try {
    base = fs.realpathSync(manual.length > 0 ? manual : appRoot);
  } catch {
    return { ok: false, error: msg('locate.pathMissing', manual.length > 0 ? manual : appRoot) };
  }
  if (/windowsapps/i.test(base)) {
    return { ok: false, error: msg('locate.storeEdition') };
  }
  const installRoot = manual.length > 0 ? base : up3(base);
  const runningFp = readFingerprint(path.join(appRoot, 'product.json'));

  const versionDir = resolveVersionDir(installRoot, runningFp ? runningFp.commit.slice(0, 10) : undefined);
  if (versionDir === undefined) {
    return { ok: false, error: msg('locate.noVersionDir', installRoot) };
  }

  const targetAppRoot = path.join(installRoot, versionDir, 'resources', 'app');
  const fp = readFingerprint(path.join(targetAppRoot, 'product.json'));
  if (!fp) {
    return { ok: false, error: msg('locate.fingerprintMissing', targetAppRoot) };
  }
  const mediaDir = mediaDirUnder(targetAppRoot);
  if (!fs.existsSync(mediaDir) || !fs.statSync(mediaDir).isDirectory()) {
    return { ok: false, error: msg('locate.mediaMissing', mediaDir) };
  }
  // Variants of the editor may ship fewer sound files. The replacement
  // surface is whatever actually exists; nothing is guessed or fabricated,
  // and the missing files are reported as non covered.
  const presentFiles: string[] = [];
  const missingFiles: string[] = [];
  for (const f of OFFICIAL_FILES) {
    if (fs.existsSync(path.join(mediaDir, f))) {
      presentFiles.push(f);
    } else {
      missingFiles.push(f);
    }
  }
  if (presentFiles.length === 0) {
    return { ok: false, error: msg('locate.mediaMissing', mediaDir) };
  }
  return {
    ok: true,
    located: {
      installRoot,
      versionDir,
      appRoot: targetAppRoot,
      mediaDir,
      fingerprint: fp,
      presentFiles,
      missingFiles,
    },
  };
}
