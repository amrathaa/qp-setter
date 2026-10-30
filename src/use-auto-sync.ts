import { useCallback, useEffect, useRef, useState } from "react";
import type { SyncResult } from "./storage";
import {
  canLinkFile,
  hasFileAccess,
  isCancelled,
  loadLinkedFile,
  pickExistingFile,
  pickNewFile,
  saveLinkedFile,
  syncWithFile,
  type SyncFileHandle,
} from "./sync-file";

export type SyncState = "unlinked" | "needs-access" | "syncing" | "synced" | "error";

const LAST_SYNC_KEY = "qp_setter_last_sync";
// Coming back to the app re-syncs at most this often, to pick up work done on the other computer.
const REFOCUS_SYNC_MS = 30_000;
// Several changes in a row (deleting a few papers) become one sync.
const CHANGE_DELAY_MS = 1500;

function loadLastSync(): string {
  try {
    const saved = localStorage.getItem(LAST_SYNC_KEY) || "";
    // Older versions stored display text here rather than a time.
    return Number.isNaN(Date.parse(saved)) ? "" : saved;
  } catch {
    return "";
  }
}

function describe(result: SyncResult | "empty"): string {
  if (result === "empty") return "Your papers were saved to the new sync file.";
  const parts = [
    result.added && `${result.added} paper${result.added === 1 ? "" : "s"} added`,
    result.updated && `${result.updated} updated`,
    result.removed && `${result.removed} removed`,
    result.profileChanged && "profile updated",
  ].filter(Boolean);
  const changes = parts.length ? `From the other computer: ${parts.join(", ")}.` : "Everything is up to date.";
  return result.papersSaved ? changes : `${changes} Recent papers could not be updated because the browser's storage is full.`;
}

/**
 * Keeps this browser and the linked sync file in step: syncs when the app opens or comes back into view,
 * and shortly after the teacher changes something. `onChanged` refreshes the app after the file brought changes.
 */
export function useAutoSync(onChanged: (result: SyncResult) => void) {
  const [handle, setHandle] = useState<SyncFileHandle | null>(null);
  const [state, setState] = useState<SyncState>("unlinked");
  const [message, setMessage] = useState("");
  const [lastSynced, setLastSynced] = useState(loadLastSync);
  const handleRef = useRef<SyncFileHandle | null>(null);
  const onChangedRef = useRef(onChanged);
  const lastRunAt = useRef(0);
  const changeTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    onChangedRef.current = onChanged;
  }, [onChanged]);

  // `ask` may show the browser's permission prompt, so it is only true straight after a click.
  const run = useCallback(async (target: SyncFileHandle, ask: boolean) => {
    lastRunAt.current = Date.now();
    try {
      if (!(await hasFileAccess(target, ask))) {
        setState("needs-access");
        setMessage(`Click "Sync now" to let QP Setter use "${target.name}" again.`);
        return;
      }
      setState("syncing");
      const result = await syncWithFile(target);
      if (result === null) {
        setState("error");
        setMessage(`"${target.name}" isn't a QP Setter sync file, so it was left untouched. Choose another file.`);
        return;
      }
      if (result !== "empty") onChangedRef.current(result);
      const now = new Date().toISOString();
      setLastSynced(now);
      try {
        localStorage.setItem(LAST_SYNC_KEY, now);
      } catch {
        // only the "last synced" time is lost
      }
      setState("synced");
      setMessage(describe(result));
    } catch {
      setState("error");
      setMessage(`Couldn't open "${target.name}". Check it is still in your cloud folder, then click "Sync now".`);
    }
  }, []);

  const adoptFile = useCallback(
    (target: SyncFileHandle | null) => {
      handleRef.current = target;
      setHandle(target);
      if (!target) {
        setState("unlinked");
        setMessage("");
      }
    },
    [],
  );

  // Auto-load: sync as soon as the app opens.
  useEffect(() => {
    void loadLinkedFile().then((saved) => {
      if (!saved) return;
      adoptFile(saved);
      void run(saved, false);
    });
  }, [run, adoptFile]);

  // Pick up the other computer's work when the teacher comes back to this tab.
  useEffect(() => {
    const onVisible = () => {
      const target = handleRef.current;
      if (document.visibilityState === "visible" && target && Date.now() - lastRunAt.current > REFOCUS_SYNC_MS) {
        void run(target, false);
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [run]);

  /** Auto-save: call after the teacher changes something that is synced. */
  const notifyChanged = useCallback(() => {
    window.clearTimeout(changeTimer.current);
    changeTimer.current = window.setTimeout(() => {
      if (handleRef.current) void run(handleRef.current, false);
    }, CHANGE_DELAY_MS);
  }, [run]);

  const syncNow = useCallback(() => {
    if (handleRef.current) void run(handleRef.current, true);
  }, [run]);

  /** Links a new or existing sync file; must be called from a click. */
  const link = useCallback(
    async (which: "new" | "existing") => {
      try {
        const target = which === "new" ? await pickNewFile() : await pickExistingFile();
        await saveLinkedFile(target);
        adoptFile(target);
        await run(target, true);
      } catch (error) {
        if (!isCancelled(error)) {
          setState("error");
          setMessage("That file couldn't be used. Try another location.");
        }
      }
    },
    [run, adoptFile],
  );

  const unlink = useCallback(async () => {
    await saveLinkedFile(undefined);
    adoptFile(null);
  }, [adoptFile]);

  return { supported: canLinkFile, handle, state, message, lastSynced, notifyChanged, syncNow, link, unlink };
}

export type AutoSync = ReturnType<typeof useAutoSync>;
