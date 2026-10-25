// Mechanism six: calibration. A calibration pack speaks its own slot name
// in every slot, so applying it turns the sound set into a self describing
// map: trigger a signal, hear the slot name, and the trigger to slot mapping
// falls out by ear. The engine side is pure: pick the pack that covers every
// slot, and produce the worksheet rows straight from the slot table. The
// guided flow lives in the UI.
import { SLOTS } from './slot-table';
import { PackInfo, ScannedPack } from './pack-reader';

// The calibration signature: a pack whose usable slots cover all 28 slots.
export function findCalibrationPack(scanned: ReadonlyArray<ScannedPack>): PackInfo | undefined {
  for (const s of scanned) {
    if (!s.result.ok) {
      continue;
    }
    const covered = new Set(Object.values(s.result.pack.slots).map((a) => a.slot));
    if (covered.size === SLOTS.length) {
      return s.result.pack;
    }
  }
  return undefined;
}

export interface WorksheetRow {
  slot: string;
  files: ReadonlyArray<string>;
  events: ReadonlyArray<string>;
  settingKeys: ReadonlyArray<string>;
}

export function worksheetRows(): WorksheetRow[] {
  return SLOTS.map((e) => ({
    slot: e.slot,
    files: e.files,
    events: e.events,
    settingKeys: e.settingKeys,
  }));
}
