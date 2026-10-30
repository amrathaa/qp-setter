import type { GeneratedSection } from "./blueprint";

export interface StoredPaper {
  id: string;
  createdAt: string;
  title: string;
  subject: string;
  className: string;
  totalMarks: number;
  duration: number;
  difficulty: string;
  questionCount: number;
  sections: GeneratedSection[];
  /** Legacy: PDFs used to be stored inline; new papers keep them in IndexedDB. */
  pdfBase64?: string;
  hasPdf?: boolean;
  /** When this copy last changed; sync keeps the newer copy. Older records fall back to createdAt. */
  updatedAt?: string;
}

const PAPERS_KEY = "qp_setter_recent_papers";
const PROFILE_KEY = "qp_setter_profile";
// Deleted paper ids with the time they were deleted, so sync can remove them on other computers too.
const DELETED_PAPERS_KEY = "qp_setter_deleted_papers";

export interface TeacherProfile {
  name: string;
  department: string;
  updatedAt?: string;
}

export function loadProfile(): TeacherProfile {
  try {
    const parsed = JSON.parse(localStorage.getItem(PROFILE_KEY) || "{}");
    return {
      name: String(parsed.name || ""),
      department: String(parsed.department || ""),
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : undefined,
    };
  } catch {
    return { name: "", department: "" };
  }
}

/** Saves the profile; an edit is stamped now, while sync passes the other computer's time through. */
export function saveProfile(profile: TeacherProfile): void {
  try {
    localStorage.setItem(PROFILE_KEY, JSON.stringify({ ...profile, updatedAt: profile.updatedAt || new Date().toISOString() }));
  } catch {
    // the name simply won't persist across reloads
  }
}

/**
 * Loads recent papers from localStorage.
 */
export function loadRecentPapers(): StoredPaper[] {
  try {
    const raw = localStorage.getItem(PAPERS_KEY);
    if (!raw) return [];
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

/**
 * Saves a paper's details to localStorage. Returns false if the browser refused.
 * The PDF itself goes to IndexedDB (see savePaperPdf) because localStorage only holds about 5 MB.
 */
export function saveRecentPaper(paper: StoredPaper): boolean {
  const papers = loadRecentPapers();
  const updated = [{ ...paper, updatedAt: new Date().toISOString() }, ...papers.filter((p) => p.id !== paper.id)];
  const kept = updated.slice(0, 30);
  for (const dropped of updated.slice(30)) void deletePaperPdf(dropped.id);
  try {
    localStorage.setItem(PAPERS_KEY, JSON.stringify(kept));
    return true;
  } catch (err) {
    console.error("Failed to save paper to localStorage:", err);
    return false;
  }
}

/**
 * Delete a paper by id.
 */
export function deleteRecentPaper(id: string): StoredPaper[] {
  void deletePaperPdf(id);
  saveDeletedPapers({ ...loadDeletedPapers(), [id]: new Date().toISOString() });
  try {
    const papers = loadRecentPapers().filter((p) => p.id !== id);
    localStorage.setItem(PAPERS_KEY, JSON.stringify(papers));
    return papers;
  } catch {
    return loadRecentPapers();
  }
}

type DeletedPapers = Record<string, string>;

function loadDeletedPapers(): DeletedPapers {
  try {
    const parsed = JSON.parse(localStorage.getItem(DELETED_PAPERS_KEY) || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

// Keeps the 500 most recent deletions; older ones have long since reached every computer.
function saveDeletedPapers(deleted: DeletedPapers): void {
  const newest = Object.entries(deleted)
    .filter(([, at]) => typeof at === "string")
    .sort((a, b) => b[1].localeCompare(a[1]))
    .slice(0, 500);
  try {
    localStorage.setItem(DELETED_PAPERS_KEY, JSON.stringify(Object.fromEntries(newest)));
  } catch {
    // the deletion still applies here; it just may not reach other computers
  }
}

/**
 * Clears what removed features left in this browser: the Question bank's saved questions and the
 * Anthropic API key the AI feature kept. Runs at every start, so nothing secret lingers.
 */
export function clearRemovedFeatureData(): void {
  try {
    for (const key of ["qp_setter_question_bank", "qp_setter_bank_last_export", "qp_setter_anthropic_key"]) {
      localStorage.removeItem(key);
    }
  } catch {
    // nothing to clear
  }
}

const FILES_DB = "qp_setter_files";
const PDF_STORE = "paper_pdfs";
// Small values that must survive reloads but cannot go in localStorage, such as the sync file handle.
const SETTINGS_STORE = "settings";

const openFilesDb = () =>
  new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(FILES_DB, 5);
    request.onupgradeneeded = () => {
      for (const name of [PDF_STORE, SETTINGS_STORE]) {
        if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name);
      }
      // The Question bank feature was removed; drop its stored questions so they stop using space.
      if (request.result.objectStoreNames.contains("question_bank")) request.result.deleteObjectStore("question_bank");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

// Resolves once the transaction has committed, so a write refused for lack of space is reported.
const withStore = async <T>(
  storeName: string,
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest<T>,
) => {
  const db = await openFilesDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(storeName, mode);
      const request = action(transaction.objectStore(storeName));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = () => reject(transaction.error || request.error);
      transaction.onabort = () => reject(transaction.error || request.error);
    });
  } finally {
    db.close();
  }
};

const withPdfStore = <T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>) =>
  withStore(PDF_STORE, mode, action);

/**
 * Stores a generated paper PDF in IndexedDB. Returns false if the browser refused.
 */
export async function savePaperPdf(id: string, blob: Blob): Promise<boolean> {
  try {
    await withPdfStore("readwrite", (store) => store.put(blob, id));
    return true;
  } catch (err) {
    console.error("Failed to store paper PDF:", err);
    return false;
  }
}

export async function loadPaperPdf(id: string): Promise<Blob | null> {
  try {
    return (await withPdfStore<Blob | undefined>("readonly", (store) => store.get(id))) || null;
  } catch {
    return null;
  }
}

export async function deletePaperPdf(id: string): Promise<void> {
  try {
    await withPdfStore("readwrite", (store) => store.delete(id));
  } catch {
    // ignore
  }
}

/**
 * Moves PDFs saved by older versions (base64 inside localStorage) into IndexedDB to free space.
 */
export async function migrateLegacyPaperPdfs(): Promise<StoredPaper[]> {
  const papers = loadRecentPapers();
  if (!papers.some((paper) => paper.pdfBase64)) return papers;
  const migrated: StoredPaper[] = [];
  for (const paper of papers) {
    if (!paper.pdfBase64) {
      migrated.push(paper);
      continue;
    }
    try {
      const blob = await (await fetch(paper.pdfBase64)).blob();
      const stored = await savePaperPdf(paper.id, blob);
      migrated.push(stored ? { ...paper, pdfBase64: undefined, hasPdf: true } : paper);
    } catch {
      migrated.push(paper);
    }
  }
  try {
    localStorage.setItem(PAPERS_KEY, JSON.stringify(migrated));
  } catch {
    // keep the old records if they cannot be rewritten
  }
  return loadRecentPapers();
}

/**
 * Asks the browser not to clear saved papers and questions when the disk runs low.
 * Returns whether storage is protected; browsers may decide this on their own.
 */
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    if (!navigator.storage?.persist) return false;
    return (await navigator.storage.persisted()) || (await navigator.storage.persist());
  } catch {
    return false;
  }
}

/**
 * Helper to convert Blob to base64 string for storage.
 */
export async function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

export async function loadSetting<T>(key: string): Promise<T | undefined> {
  try {
    return await withStore<T | undefined>(SETTINGS_STORE, "readonly", (store) => store.get(key));
  } catch {
    return undefined;
  }
}

export async function saveSetting(key: string, value: unknown): Promise<void> {
  try {
    if (value === undefined) await withStore(SETTINGS_STORE, "readwrite", (store) => store.delete(key));
    else await withStore(SETTINGS_STORE, "readwrite", (store) => store.put(value, key));
  } catch {
    // the setting simply isn't remembered
  }
}

type SyncPaper = StoredPaper & { pdfData?: string };

const changedAt = (paper: StoredPaper) => paper.updatedAt || paper.createdAt || "";

/**
 * Everything worth carrying to another computer: profile, Recent papers (with their PDFs) and recent deletions.
 */
export async function buildSyncFile(): Promise<string> {
  const papers: SyncPaper[] = [];
  for (const paper of loadRecentPapers()) {
    const blob = paper.pdfBase64 ? null : await loadPaperPdf(paper.id);
    papers.push({ ...paper, pdfData: paper.pdfBase64 || (blob ? await blobToBase64(blob) : undefined), pdfBase64: undefined });
  }
  return JSON.stringify({
    app: "QP Setter",
    kind: "sync",
    version: 2,
    savedAt: new Date().toISOString(),
    profile: loadProfile(),
    papers,
    deleted: loadDeletedPapers(),
  });
}

export interface SyncResult {
  added: number;
  updated: number;
  removed: number;
  profile: TeacherProfile;
  profileChanged: boolean;
  papersSaved: boolean;
}

/**
 * Merges a sync file into this browser, both ways: for each paper the newer copy wins, and a deletion wins over
 * anything older than it. Afterwards this browser holds the merged result, ready to be written back to the file.
 * Returns null if the file is not a QP Setter sync file.
 */
export async function applySyncFile(fileText: string): Promise<SyncResult | null> {
  let parsed: { kind?: unknown; papers?: unknown; deleted?: unknown; profile?: Partial<TeacherProfile> };
  try {
    parsed = JSON.parse(fileText);
  } catch {
    return null;
  }
  if (parsed?.kind !== "sync" || !Array.isArray(parsed.papers)) return null;

  const deleted = loadDeletedPapers();
  if (parsed.deleted && typeof parsed.deleted === "object") {
    for (const [id, at] of Object.entries(parsed.deleted as Record<string, unknown>)) {
      if (typeof at === "string" && (!deleted[id] || at > deleted[id])) deleted[id] = at;
    }
  }

  const local = new Map(loadRecentPapers().map((paper) => [paper.id, paper]));
  const remote = new Map(
    (parsed.papers as SyncPaper[])
      .filter((paper) => paper && typeof paper.id === "string" && Array.isArray(paper.sections))
      .map((paper) => [paper.id, paper]),
  );

  let added = 0;
  let updated = 0;
  let removed = 0;
  const merged: StoredPaper[] = [];
  for (const id of new Set([...local.keys(), ...remote.keys()])) {
    const mine = local.get(id);
    const theirs = remote.get(id);
    const useTheirs = Boolean(theirs) && (!mine || changedAt(theirs!) > changedAt(mine));
    const winner = (useTheirs ? theirs : mine)!;

    if (deleted[id] && deleted[id] >= changedAt(winner)) {
      if (mine) {
        removed += 1;
        void deletePaperPdf(id);
      }
      continue;
    }
    // Saved again after it was deleted somewhere, so it stays.
    delete deleted[id];

    if (!useTheirs) {
      merged.push(mine!);
      continue;
    }
    const { pdfData, ...paper } = theirs!;
    let hasPdf = Boolean(mine?.hasPdf || mine?.pdfBase64);
    if (typeof pdfData === "string" && pdfData.startsWith("data:")) {
      try {
        hasPdf = (await savePaperPdf(id, await (await fetch(pdfData)).blob())) || hasPdf;
      } catch {
        // keep whatever PDF this computer already had
      }
    }
    merged.push({ ...paper, pdfBase64: undefined, hasPdf });
    if (mine) updated += 1;
    else added += 1;
  }

  merged.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const kept = merged.slice(0, 30);
  for (const dropped of merged.slice(30)) void deletePaperPdf(dropped.id);
  let papersSaved = true;
  try {
    localStorage.setItem(PAPERS_KEY, JSON.stringify(kept));
  } catch {
    papersSaved = false;
  }
  saveDeletedPapers(deleted);

  // The more recently edited profile wins; an empty one here is always filled in.
  const current = loadProfile();
  const theirs: TeacherProfile = {
    name: String(parsed.profile?.name || ""),
    department: String(parsed.profile?.department || ""),
    updatedAt: typeof parsed.profile?.updatedAt === "string" ? parsed.profile.updatedAt : undefined,
  };
  const currentIsEmpty = !current.name && !current.department;
  const profileChanged =
    (theirs.name !== current.name || theirs.department !== current.department) &&
    ((theirs.updatedAt || "") > (current.updatedAt || "") || (currentIsEmpty && Boolean(theirs.name || theirs.department)));
  if (profileChanged) saveProfile({ ...theirs, updatedAt: theirs.updatedAt || new Date().toISOString() });

  return {
    added: papersSaved ? added : 0,
    updated: papersSaved ? updated : 0,
    removed: papersSaved ? removed : 0,
    profile: loadProfile(),
    profileChanged,
    papersSaved,
  };
}
