// Pack source seam (spec 1.2.1): the picker asks a source for candidate
// packs instead of scanning folders itself. Today the local packs folder
// is the only source; chapter 4 adds the registry source (index, online
// search, download) behind this same listing shape, so the picker flow
// never learns where packs come from. Node pure on purpose: no vscode
// import, testable outside the host.
import { PackInfo, ScannedPack, scanPacks } from '../engine/pack-reader';
import { packsDirFor } from '../engine/paths';
import { VirMessage } from '../engine/msg';
import { VirUiContext } from './extension-context';

export interface PackListing {
  good: PackInfo[];
  bad: Array<{ folderName: string; error: VirMessage }>;
}

export function localPackListing(ctx: VirUiContext): PackListing {
  const scanned: ScannedPack[] = scanPacks(packsDirFor(ctx.storageDir));
  const good: PackInfo[] = [];
  const bad: Array<{ folderName: string; error: VirMessage }> = [];
  for (const s of scanned) {
    if (s.result.ok) {
      good.push(s.result.pack);
    } else {
      bad.push({ folderName: s.folderName, error: s.result.error });
    }
  }
  return { good, bad };
}
