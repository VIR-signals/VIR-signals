// vscode:uninstall hook. Runs with a few seconds of budget before the
// extension folder is deleted, straight from node without the extension
// host. Puts the official files back from the snapshot that lives next to
// this compiled script. Exit codes per the contract: 0 restored and
// verified, 1 snapshot missing or broken with the site untouched, 2 the
// restore ran but verification failed or the outcome is uncertain.
import * as path from 'node:path';
import { restoreFromSnapshot } from './engine/uninstall-restore';

function main(): number {
  const outDir = path.dirname(__filename);
  const outcome = restoreFromSnapshot(outDir === '.' ? process.cwd() : outDir);
  if (outcome.code !== 0) {
    process.stderr.write(`vir uninstall: ${outcome.why}\n`);
  }
  return outcome.code;
}

process.exit(main());
