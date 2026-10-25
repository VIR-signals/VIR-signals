// Fixture helpers for engine tests: a fake editor install tree, fake voice
// packs, and a minimal WAV writer. Nothing here touches a real editor.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { OFFICIAL_FILES } from '../src/engine/slot-table';

export function makeTempRoot(): string {
  return fs.mkdtempSync(path.join(tmpdir(), 'vir-test-'));
}

// Minimal PCM mono WAV writer: 8000 Hz, 16 bit.
export function buildFakeWav(p: string, seconds: number): void {
  const rate = 8000;
  const dataBytes = Math.max(1, Math.round(seconds * rate * 2));
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataBytes, 40);
  fs.writeFileSync(p, buf);
}

// Deterministic fake MP3 payload with a valid ID3 magic.
export function fakeMp3(seed: string, size = 512): Buffer {
  const buf = Buffer.alloc(size);
  buf.write('ID3', 0, 'ascii');
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h = (h ^ seed.charCodeAt(i)) * 16777619;
  }
  for (let i = 3; i < size; i++) {
    h = (h * 16777619 + i) >>> 0;
    buf[i] = h & 0xff;
  }
  return buf;
}

export interface FakeInstall {
  installRoot: string;
  appRoot: string;
  mediaDir: string;
  versionDir: string;
}

export function buildInstallTree(
  root: string,
  versionDir = 'e646868227',
  commit = 'e6468682270123abcdabcdabcdabcdabcdabcd',
  version = '1.143.1'
): FakeInstall {
  const installRoot = path.join(root, 'install');
  const appRoot = path.join(installRoot, versionDir, 'resources', 'app');
  const mediaDir = path.join(
    appRoot, 'out', 'vs', 'platform', 'accessibilitySignal', 'browser', 'media'
  );
  fs.mkdirSync(path.join(installRoot, 'bin'), { recursive: true });
  fs.mkdirSync(mediaDir, { recursive: true });
  fs.writeFileSync(
    path.join(installRoot, 'bin', 'code'),
    '#!/bin/sh\nVERSIONFOLDER="' + versionDir + '"\n'
  );
  fs.writeFileSync(
    path.join(installRoot, 'bin', 'code.cmd'),
    '@echo off\n"%~dp0..' + '\\' + versionDir + '\\resources\\app\\bin\\code.cmd" %*\n'
  );
  fs.writeFileSync(
    path.join(appRoot, 'product.json'),
    JSON.stringify({ version, commit }, null, 2)
  );
  for (const f of OFFICIAL_FILES) {
    fs.writeFileSync(path.join(mediaDir, f), fakeMp3(f));
  }
  return { installRoot, appRoot, mediaDir, versionDir };
}

// A pack folder: manifest.json plus sounds/*.wav, one per given slot.
export function buildPack(
  root: string,
  id: string,
  slots: Record<string, string>,
  seconds = 0.2
): string {
  const dir = path.join(root, 'packs', id);
  fs.mkdirSync(path.join(dir, 'sounds'), { recursive: true });
  for (const name of Object.keys(slots)) {
    buildFakeWav(path.join(dir, slots[name]), seconds);
  }
  return dir;
}

export function writePackManifest(dir: string, manifest: unknown): void {
  fs.writeFileSync(
    path.join(dir, 'manifest.json'),
    JSON.stringify(manifest, null, 2)
  );
}
