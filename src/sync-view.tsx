import { useEffect, useState } from "react";
import { applySyncFile, buildSyncFile, loadSetting, saveSetting, type SyncResult } from "./storage";

// Chrome and Edge can keep a link to one file, so saving to the cloud folder needs no file dialog each time.
// Other browsers fall back to a normal download and file picker.
type WritableFile = { write: (data: string) => Promise<void>; close: () => Promise<void> };
type SyncFileHandle = {
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
const LAST_SYNC_KEY = "qp_setter_last_sync";
const FILE_TYPES = [{ description: "QP Setter sync file", accept: { "application/json": [".json"] } }];
const picker = window as PickerWindow;
const canLinkFile = typeof picker.showSaveFilePicker === "function";

async function hasWriteAccess(handle: SyncFileHandle) {
  if (!handle.queryPermission || !handle.requestPermission) return true;
  if ((await handle.queryPermission({ mode: "readwrite" })) === "granted") return true;
  return (await handle.requestPermission({ mode: "readwrite" })) === "granted";
}

const isAbort = (error: unknown) => error instanceof DOMException && error.name === "AbortError";

function loadLastSync(): string {
  try {
    return localStorage.getItem(LAST_SYNC_KEY) || "";
  } catch {
    return "";
  }
}

/**
 * The "Sync" screen: one file, kept in a OneDrive, Google Drive or Dropbox folder, carries papers between computers.
 */
export function SyncView({ onLoaded }: { onLoaded: (result: SyncResult) => void }) {
  const [handle, setHandle] = useState<SyncFileHandle | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState({ text: "", isError: false });
  const [lastSync, setLastSync] = useState(loadLastSync);

  useEffect(() => {
    if (canLinkFile) void loadSetting<SyncFileHandle>(HANDLE_KEY).then((saved) => saved && setHandle(saved));
  }, []);

  const noteSync = (text: string) => {
    const stamp = `${text} ${new Date().toLocaleString()}`;
    setLastSync(stamp);
    try {
      localStorage.setItem(LAST_SYNC_KEY, stamp);
    } catch {
      // only the "last synced" line is lost
    }
  };

  const linkFile = async (file: SyncFileHandle) => {
    setHandle(file);
    await saveSetting(HANDLE_KEY, file);
  };

  const run = async (task: () => Promise<void>) => {
    setBusy(true);
    setMessage({ text: "", isError: false });
    try {
      await task();
    } catch (error) {
      if (!isAbort(error)) {
        setMessage({ text: "That didn't work. Check the file is still in your cloud folder and try again.", isError: true });
      }
    } finally {
      setBusy(false);
    }
  };

  const save = (chooseNew = false) =>
    run(async () => {
      const data = await buildSyncFile();
      if (canLinkFile) {
        let target = chooseNew ? null : handle;
        if (!target) {
          target = await picker.showSaveFilePicker!({ suggestedName: "qp-setter-sync.json", types: FILE_TYPES });
          await linkFile(target);
        }
        if (!(await hasWriteAccess(target))) {
          setMessage({ text: "The browser was not allowed to write to the sync file.", isError: true });
          return;
        }
        const writable = await target.createWritable();
        await writable.write(data);
        await writable.close();
        setMessage({ text: `Saved to "${target.name}".`, isError: false });
      } else {
        const url = URL.createObjectURL(new Blob([data], { type: "application/json" }));
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = "qp-setter-sync.json";
        anchor.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
        setMessage({ text: "Downloaded qp-setter-sync.json. Move it into your cloud folder.", isError: false });
      }
      noteSync("Saved");
    });

  const applyText = async (text: string, name: string) => {
    const result = await applySyncFile(text);
    if (!result) {
      setMessage({ text: `"${name}" is not a QP Setter sync file.`, isError: true });
      return;
    }
    onLoaded(result);
    setMessage({
      text:
        `Loaded "${name}": ${result.papersAdded} new paper${result.papersAdded === 1 ? "" : "s"}.` +
        (result.papersSaved ? "" : " Recent papers could not be updated because the browser's storage is full."),
      isError: !result.papersSaved,
    });
    noteSync("Loaded");
  };

  const load = (chooseNew = false) =>
    run(async () => {
      let source = chooseNew ? null : handle;
      if (!source) {
        const [picked] = await picker.showOpenFilePicker!({ types: FILE_TYPES });
        source = picked;
        await linkFile(picked);
      }
      if (!(await hasWriteAccess(source))) {
        setMessage({ text: "The browser was not allowed to open the sync file.", isError: true });
        return;
      }
      const file = await source.getFile();
      await applyText(await file.text(), file.name);
    });

  return (
    <div className="recent-container">
      <section className="page-intro">
        <div>
          <p className="eyebrow">SYNC <span className="line" /></p>
          <h1>Use QP Setter on <em>more than one computer.</em></h1>
          <p className="intro-copy">
            Keep one sync file in a folder that OneDrive, Google Drive or Dropbox already syncs. Save to it when you
            finish on one computer, then load it on the other.
          </p>
        </div>
      </section>

      <div className="sync-card">
        <div className="sync-status">
          <strong>{handle ? `Sync file: ${handle.name}` : "No sync file chosen yet"}</strong>
          <small>{lastSync || "Not synced from this browser yet."}</small>
        </div>
        <div className="sync-actions">
          <button className="next-button" disabled={busy} onClick={() => void save()}>
            {handle || !canLinkFile ? "Save to sync file" : "Create sync file…"}
          </button>
          {canLinkFile ? (
            <button className="back-button" disabled={busy} onClick={() => void load()}>
              {handle ? "Load from sync file" : "Load a sync file…"}
            </button>
          ) : (
            <label className={`back-button ${busy ? "disabled" : ""}`}>
              Load a sync file…
              <input
                type="file"
                accept=".json,application/json"
                hidden
                disabled={busy}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (file) void run(async () => applyText(await file.text(), file.name));
                }}
              />
            </label>
          )}
          {handle && (
            <button className="q-action-btn" disabled={busy} onClick={() => void load(true)}>
              Use a different file
            </button>
          )}
        </div>
        {message.text && (
          <p className={`ai-status ${message.isError ? "error" : ""}`} role="status">
            {message.text}
          </p>
        )}
      </div>

      <ul className="sync-notes">
        <li>The file holds your Recent papers with their PDFs and your profile.</li>
        <li>Loading only adds what this computer is missing. It never deletes anything here.</li>
        <li>
          {canLinkFile
            ? "This browser remembers the file, so later saves and loads need just one click."
            : "In this browser each save downloads a new copy; Chrome or Edge can update the same file directly."}
        </li>
        <li>Your data goes only to your own cloud folder. QP Setter has no server.</li>
      </ul>
    </div>
  );
}
