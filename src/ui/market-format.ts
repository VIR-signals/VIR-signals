// Pure computations for the market panel: no vscode import, so the node
// test runner can exercise the coverage math directly.
import { RESPONSE_SUB_KEYS } from '../engine/slot-table';

// Slot names for the coverage line: numbered responseReceived sub keys
// count as the one shared slot they feed.
export function slotNamesOfKeys(keys: ReadonlyArray<string>): string[] {
  const names = new Set<string>();
  for (const k of keys) {
    names.add(RESPONSE_SUB_KEYS.includes(k) ? 'responseReceived' : k);
  }
  return [...names];
}
