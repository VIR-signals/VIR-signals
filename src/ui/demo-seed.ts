// Demo pack seeding. The extension carries the demo pack next to its code
// (the one sanctioned audio exception) and places it into the packs folder
// whenever the folder has no demo. An existing demo is never touched.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { VirMessage, msg } from '../engine/msg';
import { packsDirFor } from '../engine/paths';
import { ensureDir } from '../engine/fsutil';
import { VirUiContext } from './extension-context';

const DEMO_DIR_NAME = 'demo';

export function bundledDemoDir(extensionDir: string): string {
  return path.join(extensionDir, DEMO_DIR_NAME);
}

export function seedDemoPack(ctx: VirUiContext): VirMessage | undefined {
  const target = path.join(packsDirFor(ctx.storageDir), DEMO_DIR_NAME);
  const source = bundledDemoDir(ctx.extensionDir);
  if (!fs.existsSync(path.join(source, 'manifest.json'))) {
    return msg('ui.demoSeed.missing');
  }
  ensureDir(packsDirFor(ctx.storageDir));
  // The directory create is the gate: exclusive when absent, EEXIST when
  // the demo is already there (including a user modified one, which is
  // never touched), and it serializes two windows seeding at once so the
  // copy itself always has a single writer.
  try {
    fs.mkdirSync(target);
  } catch (e) {
    if ((e as { code?: string }).code === 'EEXIST') {
      return undefined;
    }
    throw e;
  }
  try {
    fs.cpSync(source, target, { recursive: true });
  } catch (e) {
    // A half seeded demo must not freeze into place: drop it so the next
    // activation retries, and let the error surface.
    fs.rmSync(target, { recursive: true, force: true });
    throw e;
  }
  return undefined;
}
