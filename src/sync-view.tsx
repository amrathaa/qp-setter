import { useState } from "react";
import { applySyncFile, type SyncResult } from "./storage";
import { downloadSyncFile } from "./sync-file";
import type { AutoSync } from "./use-auto-sync";

const formatTime = (iso: string) => (iso ? new Date(iso).toLocaleString() : "");

/**
 * The "Sync" screen: one file, kept in a OneDrive, Google Drive or Dropbox folder, keeps papers in step between computers.
 */
export function SyncView({ sync, onLoaded }: { sync: AutoSync; onLoaded: (result: SyncResult) => void }) {
  return (
    <div className="recent-container">
      <section className="page-intro">
        <div>
          <p className="eyebrow">SYNC <span className="line" /></p>
          <h1>Use QP Setter on <em>more than one computer.</em></h1>
          <p className="intro-copy">
            Keep one sync file in a folder that OneDrive, Google Drive or Dropbox already syncs, and link it on each
            computer. QP Setter then keeps it up to date for you.
          </p>
        </div>
      </section>

      {sync.supported ? <LinkedSync sync={sync} /> : <ManualSync onLoaded={onLoaded} />}

      <ul className="sync-notes">
        <li>The file holds your Recent papers with their PDFs, your profile, and which papers you deleted.</li>
        <li>
          New papers, deleted papers and profile edits reach the other computer. If the same thing changed on both,
          the most recent change wins.
        </li>
        <li>Your data goes only to your own cloud folder. QP Setter has no server.</li>
      </ul>
    </div>
  );
}

function LinkedSync({ sync }: { sync: AutoSync }) {
  const statusText = {
    unlinked: "No sync file linked on this computer",
    "needs-access": "Waiting for your permission",
    syncing: "Syncing…",
    synced: "Synced",
    error: "Sync problem",
  }[sync.state];

  return (
    <div className="sync-card">
      <div className="sync-status">
        <strong>
          <span className={`sync-dot ${sync.state}`} />
          {statusText}
          {sync.handle && ` · ${sync.handle.name}`}
        </strong>
        <small>{sync.lastSynced ? `Last synced ${formatTime(sync.lastSynced)}` : "Not synced from this browser yet."}</small>
      </div>

      {sync.handle ? (
        <div className="sync-actions">
          <button className="next-button" disabled={sync.state === "syncing"} onClick={sync.syncNow}>
            Sync now
          </button>
          <button className="q-action-btn" onClick={() => void sync.link("existing")}>
            Use a different file
          </button>
          <button className="q-action-btn" onClick={() => void sync.unlink()}>
            Stop syncing
          </button>
        </div>
      ) : (
        <div className="sync-actions">
          <button className="next-button" onClick={() => void sync.link("new")}>
            Create sync file…
          </button>
          <button className="back-button" onClick={() => void sync.link("existing")}>
            Link an existing sync file…
          </button>
        </div>
      )}

      {sync.message && (
        <p className={`status-note ${sync.state === "error" ? "error" : ""}`} role="status">
          {sync.message}
        </p>
      )}

      {sync.handle && (
        <small className="sync-auto-note">
          Syncs automatically when QP Setter opens, when you come back to it, and after you finish, delete or change
          something. When the browser asks, choose "Allow on every visit" so it can sync without a click.
        </small>
      )}
    </div>
  );
}

// Firefox and Safari can't keep a link to a file, so saving and loading are done by hand there.
function ManualSync({ onLoaded }: { onLoaded: (result: SyncResult) => void }) {
  const [message, setMessage] = useState({ text: "", isError: false });

  const load = async (file: File) => {
    const result = await applySyncFile(await file.text());
    if (!result) {
      setMessage({ text: `"${file.name}" is not a QP Setter sync file.`, isError: true });
      return;
    }
    onLoaded(result);
    setMessage({
      text: `Loaded "${file.name}": ${result.added} added, ${result.updated} updated, ${result.removed} removed.`,
      isError: !result.papersSaved,
    });
  };

  return (
    <div className="sync-card">
      <div className="sync-status">
        <strong>Manual sync</strong>
        <small>
          This browser can't update a file in place, so save a new copy into your cloud folder when you finish, and
          load it on the other computer. Chrome or Edge can sync automatically.
        </small>
      </div>
      <div className="sync-actions">
        <button
          className="next-button"
          onClick={() =>
            void downloadSyncFile().then(() =>
              setMessage({ text: "Downloaded qp-setter-sync.json. Move it into your cloud folder.", isError: false }),
            )
          }
        >
          Save sync file
        </button>
        <label className="back-button">
          Load a sync file…
          <input
            type="file"
            accept=".json,application/json"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) void load(file);
            }}
          />
        </label>
      </div>
      {message.text && (
        <p className={`status-note ${message.isError ? "error" : ""}`} role="status">
          {message.text}
        </p>
      )}
    </div>
  );
}
