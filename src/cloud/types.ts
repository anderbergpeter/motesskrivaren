export interface CloudFolder {
  id: string;
}

export interface CloudStorage {
  kind: 'google' | 'microsoft';
  label: string;
  isConnected(): boolean;
  /** Interactive sign-in (must be called from a user gesture). */
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  accountLabel(): string | null;
  /** Ensure the app's personal folder exists; returns its id. */
  ensureRootFolder(): Promise<string>;
  /** Create a sub folder and return its id. */
  ensureFolder(parentId: string, name: string): Promise<string>;
  /** Create or replace a text file; returns the file id. */
  putText(folderId: string, name: string, content: string, existingId?: string): Promise<string>;
  /** Upload a binary file; returns the file id. */
  putBlob(folderId: string, name: string, blob: Blob): Promise<string>;
}

export class CloudAuthError extends Error {}

export const ROOT_FOLDER_NAME = 'Mötesskrivaren';
