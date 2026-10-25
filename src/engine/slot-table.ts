// Slot table for editor sound set 1.143.1, verified against the official
// bundle and the reference mapping. A slot name equals its media file base
// name, except responseReceived which covers four numbered files. This table
// is version data: regenerate it with the calibration flow when the editor
// changes its sound set, the engine core stays untouched.

export interface SlotEntry {
  readonly slot: string;
  readonly events: ReadonlyArray<string>;
  readonly settingKeys: ReadonlyArray<string>;
  readonly files: ReadonlyArray<string>;
}

const SIG = 'accessibility.signals';

function one(slot: string, event: string, key: string): SlotEntry {
  return { slot, events: [event], settingKeys: [`${SIG}.${key}`], files: [`${slot}.mp3`] };
}

function many(
  slot: string,
  events: ReadonlyArray<string>,
  keys: ReadonlyArray<string>
): SlotEntry {
  return {
    slot,
    events,
    settingKeys: keys.map((k) => `${SIG}.${k}`),
    files: [`${slot}.mp3`],
  };
}

const RESPONSE_FILES: ReadonlyArray<string> = [
  'responseReceived1.mp3',
  'responseReceived2.mp3',
  'responseReceived3.mp3',
  'responseReceived4.mp3',
];

export const SLOTS: ReadonlyArray<SlotEntry> = [
  many('error',
    ['errorOnLine', 'errorAtPosition', 'noInlayHints', 'terminalCommandFailed'],
    ['lineHasError', 'positionHasError', 'noInlayHints', 'terminalCommandFailed']),
  many('warning',
    ['warningOnLine', 'warningAtPosition'],
    ['lineHasWarning', 'positionHasWarning']),
  many('break',
    ['break', 'onDebugBreak'],
    ['lineHasBreakpoint', 'onDebugBreak']),
  many('quickFixes',
    ['inlineSuggestion', 'terminalQuickFix'],
    ['lineHasInlineSuggestion', 'terminalQuickFix']),
  many('taskCompleted',
    ['taskCompleted', 'notebookCellCompleted'],
    ['taskCompleted', 'notebookCellCompleted']),
  many('taskFailed',
    ['taskFailed', 'notebookCellFailed'],
    ['taskFailed', 'notebookCellFailed']),
  many('voiceRecordingStarted',
    ['voiceRecordingStarted', 'voiceModeStarted'],
    ['voiceRecordingStarted', 'voiceModeStarted']),
  many('voiceRecordingStopped',
    ['voiceRecordingStopped', 'voiceModeStopped'],
    ['voiceRecordingStopped', 'voiceModeStopped']),
  one('save', 'save', 'save'),
  one('format', 'format', 'format'),
  one('clear', 'clear', 'clear'),
  one('progress', 'progress', 'progress'),
  one('foldedAreas', 'foldedArea', 'lineHasFoldedArea'),
  one('confetti', 'confetti', 'confetti'),
  one('terminalBell', 'terminalBell', 'terminalBell'),
  one('terminalCommandSucceeded', 'terminalCommandSucceeded', 'terminalCommandSucceeded'),
  one('diffLineInserted', 'diffLineInserted', 'diffLineInserted'),
  one('diffLineModified', 'diffLineModified', 'diffLineModified'),
  one('diffLineDeleted', 'diffLineDeleted', 'diffLineDeleted'),
  one('chatEditModifiedFile', 'chatEditModifiedFile', 'chatEditModifiedFile'),
  one('chatUserActionRequired', 'chatUserActionRequired', 'chatUserActionRequired'),
  one('codeActionTriggered', 'codeActionTriggered', 'codeActionTriggered'),
  one('codeActionApplied', 'codeActionApplied', 'codeActionApplied'),
  one('editsKept', 'editsKept', 'editsKept'),
  one('editsUndone', 'editsUndone', 'editsUndone'),
  one('nextEditSuggestion', 'nextEditSuggestion', 'nextEditSuggestion'),
  one('requestSent', 'chatRequestSent', 'chatRequestSent'),
  {
    slot: 'responseReceived',
    events: ['chatResponseReceived'],
    settingKeys: [`${SIG}.chatResponseReceived`],
    files: RESPONSE_FILES,
  },
];

// Sub keys the pack manifest may use to address single responseReceived files.
export const RESPONSE_SUB_KEYS: ReadonlyArray<string> = [
  'responseReceived1',
  'responseReceived2',
  'responseReceived3',
  'responseReceived4',
];

export const ORPHAN_FILES: ReadonlyArray<string> = ['success.mp3'];

export const SLOT_NAMES: ReadonlyArray<string> = SLOTS.map((s) => s.slot);

export const SLOT_FILES: ReadonlyArray<string> = SLOTS.flatMap((s) => [...s.files]);

// Every file of an official installation, slots plus orphan.
export const OFFICIAL_FILES: ReadonlyArray<string> = [...SLOT_FILES, ...ORPHAN_FILES];

export function slotByName(name: string): SlotEntry | undefined {
  return SLOTS.find((s) => s.slot === name);
}

export function fileOwnerSlot(fileName: string): SlotEntry | undefined {
  return SLOTS.find((s) => s.files.includes(fileName));
}

export function isKnownManifestSlotKey(key: string): boolean {
  return SLOT_NAMES.includes(key) || RESPONSE_SUB_KEYS.includes(key);
}

export function settingKeysForSlots(slotNames: ReadonlyArray<string>): string[] {
  const out: string[] = [];
  for (const name of slotNames) {
    const entry = slotByName(name);
    if (entry) {
      out.push(...entry.settingKeys);
    }
  }
  return out;
}

export function affectedEventsForSlots(slotNames: ReadonlyArray<string>): string[] {
  const out: string[] = [];
  for (const name of slotNames) {
    const entry = slotByName(name);
    if (entry) {
      out.push(...entry.events);
    }
  }
  return out;
}
