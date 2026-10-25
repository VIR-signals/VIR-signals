// Structured engine message. The engine layer never holds sentences: every
// user facing report is a message key plus format arguments, and the UI layer
// renders the key through the language bundles.
export interface VirMessage {
  readonly key: string;
  readonly args: ReadonlyArray<string | number>;
}

export function msg(key: string, ...args: Array<string | number>): VirMessage {
  return { key, args };
}
