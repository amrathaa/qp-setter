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
}

const PAPERS_KEY = "qp_setter_recent_papers";
const PROFILE_KEY = "qp_setter_profile";

export interface TeacherProfile {
  name: string;
  department: string;
}

export function loadProfile(): TeacherProfile {
  try {
    const parsed = JSON.parse(localStorage.getItem(PROFILE_KEY) || "{}");
    return { name: String(parsed.name || ""), department: String(parsed.department || "") };
  } catch {
    return { name: "", department: "" };
  }
}

const API_KEY_KEY = "qp_setter_anthropic_key";

/** The teacher's own Anthropic API key, kept only in this browser. */
export function loadApiKey(): string {
  try {
    return localStorage.getItem(API_KEY_KEY) || "";
  } catch {
    return "";
  }
}

export function saveApiKey(key: string): void {
  try {
    if (key) localStorage.setItem(API_KEY_KEY, key);
    else localStorage.removeItem(API_KEY_KEY);
  } catch {
    // the key is then only kept for this visit
  }
}

export function saveProfile(profile: TeacherProfile): void {
  try {
    localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
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
  const updated = [paper, ...papers.filter((p) => p.id !== paper.id)];
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
  try {
    const papers = loadRecentPapers().filter((p) => p.id !== id);
    localStorage.setItem(PAPERS_KEY, JSON.stringify(papers));
    return papers;
  } catch {
    return loadRecentPapers();
  }
}

const FILES_DB = "qp_setter_files";
const PDF_STORE = "paper_pdfs";
// Small values that must survive reloads but cannot go in localStorage, such as the sync file handle.
const SETTINGS_STORE = "settings";

const openFilesDb = () =>
  new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(FILES_DB, 4);
    request.onupgradeneeded = () => {
      for (const name of [PDF_STORE, SETTINGS_STORE]) {
        if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name);
      }
      // The Question bank feature was removed; drop its stored questions so they stop using space.
      if (request.result.objectStoreNames.contains("question_bank")) request.result.deleteObjectStore("question_bank");
      try {
        localStorage.removeItem("qp_setter_question_bank");
        localStorage.removeItem("qp_setter_bank_last_export");
      } catch {
        // nothing to clean up
      }
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

/**
 * Everything worth carrying to another computer: profile and Recent papers (with their PDFs).
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
    version: 1,
    savedAt: new Date().toISOString(),
    profile: loadProfile(),
    papers,
  });
}

export interface SyncResult {
  papersAdded: number;
  profile: TeacherProfile;
  papersSaved: boolean;
}

/**
 * Merges a sync file into this browser. It only adds what is missing here; nothing is deleted.
 * Returns null if the file is not a QP Setter sync file.
 */
export async function applySyncFile(fileText: string): Promise<SyncResult | null> {
  let parsed: { kind?: unknown; papers?: unknown; profile?: Partial<TeacherProfile> };
  try {
    parsed = JSON.parse(fileText);
  } catch {
    return null;
  }
  if (parsed?.kind !== "sync" || !Array.isArray(parsed.papers)) return null;

  const local = loadRecentPapers();
  const localIds = new Set(local.map((paper) => paper.id));
  const incoming = (parsed.papers as SyncPaper[]).filter(
    (paper) => paper && typeof paper.id === "string" && Array.isArray(paper.sections) && !localIds.has(paper.id),
  );
  const added: StoredPaper[] = [];
  for (const { pdfData, ...paper } of incoming) {
    let hasPdf = false;
    if (typeof pdfData === "string" && pdfData.startsWith("data:")) {
      try {
        hasPdf = await savePaperPdf(paper.id, await (await fetch(pdfData)).blob());
      } catch {
        hasPdf = false;
      }
    }
    added.push({ ...paper, pdfBase64: undefined, hasPdf });
  }
  const merged = [...local, ...added].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const kept = merged.slice(0, 30);
  for (const dropped of merged.slice(30)) void deletePaperPdf(dropped.id);
  let papersSaved = true;
  try {
    localStorage.setItem(PAPERS_KEY, JSON.stringify(kept));
  } catch {
    papersSaved = false;
  }

  // A profile set on this computer wins; an empty one is filled from the file.
  const current = loadProfile();
  const profile = {
    name: current.name || String(parsed.profile?.name || ""),
    department: current.department || String(parsed.profile?.department || ""),
  };
  saveProfile(profile);

  return {
    papersAdded: papersSaved ? added.filter((paper) => kept.includes(paper)).length : 0,
    profile,
    papersSaved,
  };
}
