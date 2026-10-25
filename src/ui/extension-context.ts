// Shared UI context shape, kept in its own module so extension.ts and
// commands.ts never import each other.
export interface VirUiContext {
  readonly storageDir: string;
  readonly extensionDir: string;
  readonly owner: string;
}
