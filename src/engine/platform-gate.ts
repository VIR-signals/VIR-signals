// Platform gate (chapter 5): v1 supports the Windows user level install
// and, on the same footing, user writable positions such as a home
// directory tarball. Everything else is detected and refused with an
// explicit reason before any byte is touched — no degraded modes, no
// partial work, no elevation prompts. The write probe is injectable so
// every forbidden branch is fully testable on any machine. Zero vscode
// imports.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { VirMessage, msg } from './msg';
import { Located } from './locate';
import { PROBE_NAME } from './paths';

export type PlatformVerdict = { ok: true } | { ok: false; error: VirMessage };

export interface GateProbes {
  platform: NodeJS.Platform;
  /**
   * Try writing and removing one probe file inside mediaDir. EACCES or
   * EPERM means the position needs elevation; any other failure is an
   * honest IO condition and is reported as such.
   */
  writeProbe(mediaDir: string): { ok: true } | { ok: false; code: string };
}

export function defaultProbes(): GateProbes {
  return {
    platform: process.platform,
    writeProbe: realWriteProbe,
  };
}

function realWriteProbe(mediaDir: string): { ok: true } | { ok: false; code: string } {
  // Fixed name on purpose: a probe left behind by a crash stays
  // recognizable, idempotent on the next run, and is excluded from backup
  // and relayout listings like every other control file we own.
  const target = path.join(mediaDir, PROBE_NAME);
  try {
    fs.writeFileSync(target, '');
    fs.rmSync(target, { force: true });
    return { ok: true };
  } catch (e) {
    return { ok: false, code: String((e as { code?: string }).code ?? 'unknown') };
  }
}

function needsElevation(code: string): boolean {
  return code === 'EACCES' || code === 'EPERM';
}

// Verdict order: platform shape first (macOS app bundle, snap, flatpak),
// then the known Windows system position, then the write probe. The snap
// and flatpak branches are checked before the probe on purpose: those
// mounts fail writes for reasons no elevation can fix.
export function checkPlatform(located: Located, probes: GateProbes): PlatformVerdict {
  const norm = located.mediaDir.replace(/\\/g, '/').toLowerCase();
  if (probes.platform === 'darwin') {
    return { ok: false, error: msg('platform.macosApp') };
  }
  if (norm.startsWith('/snap/') || norm === '/snap') {
    return { ok: false, error: msg('platform.readOnlyMount', 'snap') };
  }
  if (norm.startsWith('/var/lib/flatpak/')) {
    return { ok: false, error: msg('platform.readOnlyMount', 'flatpak') };
  }
  if (norm.startsWith('c:/program files/')) {
    return { ok: false, error: msg('platform.systemInstall') };
  }
  const probe = probes.writeProbe(located.mediaDir);
  if (!probe.ok) {
    if (needsElevation(probe.code)) {
      return { ok: false, error: msg('platform.systemInstall') };
    }
    return { ok: false, error: msg('platform.probeIo', probe.code) };
  }
  return { ok: true };
}
