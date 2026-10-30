import { applySyncFile, buildSyncFile, loadSetting, saveSetting, type SyncResult } from "./storage";

// Chrome and Edge can keep a link to one file, so the app can read and write it without a file dialog.
// Other browsers only get manual save and load.
type WritableFile = { write: (data: string) => Promise<void>; close: () => Promise<void> };
export type SyncFileHandle = {
  name: string;
  getFile: () => Promise<File>;
  createWritable: () => Promise<WritableFile>;
  queryPermission?: (options: { mode: "readwrite" }) => Promise<PermissionState>;
  requestPermission?: (options: { mode: "readwrite" }) => Promise<PermissionState>;
};
type PickerWindow = Window & {
  showSaveFilePicker?: (options: unknown) => Promise<SyncFileHandle>;
  showOpenFilePicker?: (options: unknown) => Promise<SyncFileHandle[]>;
};

const HANDLE_KEY = "sync_file_handle";
const FILE_TYPES = [{ description: "QP Setter sync file", accept: { "application/json": [".json"] } }];
const picker = window as PickerWindow;

export const canLinkFile = typeof picker.showSaveFilePicker === "function";

export const isCancelled = (error: unknown) => error instanceof DOMException && error.name === "AbortError";

export const loadLinkedFile = () => (canLinkFile ? loadSetting<SyncFileHandle>(HANDLE_KEY) : Promise.resolve(undefined));

export const saveLinkedFile = (handle: SyncFileHandle | undefined) => saveSetting(HANDLE_KEY, handle);

/** Opens the browser's "save as" dialog for a new sync file. */
export const pickNewFile = () =>
  picker.showSaveFilePicker!({ suggestedName: "qp-setter-sync.json", types: FILE_TYPES });

/** Opens the browser's file dialog to choose an existing sync file. */
export const pickExistingFile = async () => (await picker.showOpenFilePicker!({ types: FILE_TYPES }))[0];

/**
 * Whether the app may read and write the linked file. Asking shows a browser prompt, which is only allowed
 * straight after a click; without asking, this reports whether access was already given.
 */
export async function hasFileAccess(handle: SyncFileHandle, ask: boolean): Promise<boolean> {
  if (!handle.queryPermission) return true;
  if ((await handle.queryPermission({ mode: "readwrite" })) === "granted") return true;
  if (!ask || !handle.requestPermission) return false;
  return (await handle.requestPermission({ mode: "readwrite" })) === "granted";
}

// One sync at a time, so an auto-sync and a click cannot both write the file.
let running: Promise<unknown> = Promise.resolve();

/**
 * Two-way sync with the linked file: merge what it holds into this browser, then write the merged result back.
 * Returns null when the file holds something other than QP Setter data, leaving it untouched.
 */
export function syncWithFile(handle: SyncFileHandle): Promise<SyncResult | "empty" | null> {
  const run = running.then(async () => {
    const text = await (await handle.getFile()).text();
    const result = text.trim() ? await applySyncFile(text) : "empty";
    if (result === null) return null;
    const writable = await handle.createWritable();
    await writable.write(await buildSyncFile());
    await writable.close();
    return result;
  });
  running = run.catch(() => undefined);
  return run;
}

/** For browsers without file linking: a sync file to download. */
export async function downloadSyncFile(): Promise<void> {
  const url = URL.createObjectURL(new Blob([await buildSyncFile()], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "qp-setter-sync.json";
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
