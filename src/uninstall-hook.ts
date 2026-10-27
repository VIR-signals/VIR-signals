// vscode:uninstall hook. Runs with a few seconds of budget before the
// extension folder is deleted, straight from node without the extension
// host. Puts the official files back from the snapshot that lives next to
// this compiled script; when the snapshot is gone (an extension folder swap
// destroys it), falls through to the backup under global storage, which
// only dies after this hook has run. Exit codes per the contract: 0
// restored and verified, 1 no usable source with the site untouched, 2 the
// restore ran but verification failed or the outcome is uncertain.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { restoreFromSnapshot, restoreFromBackupRoot } from './engine/uninstall-restore';

const STORAGE_SEGMENTS = ['Code', 'User', 'globalStorage', 'vir-signals.vir-signals'];

function storageRootFromEnv(): string | undefined {
  const appData = process.env.APPDATA;
  if (appData === undefined || appData === '') {
    return undefined;
  }
  const root = path.join(appData, ...STORAGE_SEGMENTS);
  return fs.existsSync(root) ? root : undefined;
}

function main(): number {
  const outDir = path.dirname(__filename);
  const extensionDir = outDir === '.' ? process.cwd() : outDir;
  let outcome = restoreFromSnapshot(extensionDir);
  if (outcome.code !== 0) {
    const storageRoot = storageRootFromEnv();
    if (storageRoot !== undefined) {
      const viaBackup = restoreFromBackupRoot(storageRoot);
      outcome =
        viaBackup.code === 0 || viaBackup.code === 2
          ? viaBackup
          : { code: outcome.code, why: `${outcome.why}; ${viaBackup.why}` };
    }
  }
  if (outcome.code !== 0) {
    process.stderr.write(`vir uninstall: ${outcome.why}\n`);
  }
  return outcome.code;
}

process.exit(main());
