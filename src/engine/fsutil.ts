// File system helpers shared by the engine. All fs calls go through the
// namespace import so tests can intercept them. Thrown error messages are
// dot keys, never sentences.
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { TMP_SUFFIX } from './paths';

export function sha256Buffer(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

export function sha256File(p: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

export function ensureDir(p: string): void {
  fs.mkdirSync(p, { recursive: true });
}

// Write a file whole: write to a temp sibling, then rename over the target.
export function atomicWriteFile(p: string, data: string | Buffer): void {
  const tmp = p + TMP_SUFFIX;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, p);
}

// Replace one target file with the contents of src: copy next to the target
// under the temp suffix, then rename over the target.
export function replaceFileViaTmp(src: string, dst: string): void {
  const tmp = dst + TMP_SUFFIX;
  fs.copyFileSync(src, tmp);
  fs.renameSync(tmp, dst);
}

export function copyFileVerified(src: string, dst: string): void {
  fs.copyFileSync(src, dst);
  if (sha256File(dst) !== sha256File(src)) {
    throw new Error('io.copyHashMismatch');
  }
}

export function readJsonSync<T>(p: string): T {
  return JSON.parse(fs.readFileSync(p, 'utf8')) as T;
}

export function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.isFile()) {
      out.push(ent.name);
    }
  }
  return out.sort();
}

export function listDirs(dir: string): string[] {
  const out: string[] = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.isDirectory()) {
      out.push(ent.name);
    }
  }
  return out.sort();
}
