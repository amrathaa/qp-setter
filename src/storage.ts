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

export interface StoredBankQuestion {
  id: string;
  text: string;
  marks: number;
  topic?: string;
  difficulty?: string;
  options?: string[];
  alternative?: string;
  dateAdded: string;
  paperTitle?: string;
}

const PAPERS_KEY = "qp_setter_recent_papers";
const BANK_KEY = "qp_setter_question_bank";
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
 * Saves a paper's details to localStorage and indexes its questions into the Question Bank.
 * The PDF itself goes to IndexedDB (see savePaperPdf) because localStorage only holds about 5 MB.
 */
export function saveRecentPaper(paper: StoredPaper): { paperSaved: boolean; bankSaved: boolean } {
  const bankSaved = saveQuestionsToBank(paper.sections, paper.title, paper.difficulty);
  const papers = loadRecentPapers();
  const updated = [paper, ...papers.filter((p) => p.id !== paper.id)];
  const kept = updated.slice(0, 30);
  for (const dropped of updated.slice(30)) void deletePaperPdf(dropped.id);
  try {
    localStorage.setItem(PAPERS_KEY, JSON.stringify(kept));
    return { paperSaved: true, bankSaved };
  } catch (err) {
    console.error("Failed to save paper to localStorage:", err);
    return { paperSaved: false, bankSaved };
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

const PDF_DB = "qp_setter_files";
const PDF_STORE = "paper_pdfs";

const openPdfDb = () =>
  new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(PDF_DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(PDF_STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

const withPdfStore = async <T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>) => {
  const db = await openPdfDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const request = action(db.transaction(PDF_STORE, mode).objectStore(PDF_STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
};

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
 * Loads question bank items from localStorage.
 */
export function loadQuestionBank(): StoredBankQuestion[] {
  try {
    const raw = localStorage.getItem(BANK_KEY);
    if (!raw) return getInitialQuestionBankSeed();
    const items = JSON.parse(raw);
    return Array.isArray(items) && items.length > 0 ? items : getInitialQuestionBankSeed();
  } catch {
    return getInitialQuestionBankSeed();
  }
}

/**
 * Saves a list of generated questions to the question bank.
 */
export function saveQuestionsToBank(
  sections: GeneratedSection[],
  paperTitle: string,
  difficulty = "Moderate",
): boolean {
  try {
    const currentBank = loadQuestionBank();
    const newItems: StoredBankQuestion[] = [];

    for (const section of sections) {
      for (const q of section.questions) {
        const cleanText = q.text.replace(/^\s*\d+[.)]\s*/, "").trim();
        // Avoid duplicate text in bank
        if (
          !currentBank.some((b) => b.text.toLowerCase() === cleanText.toLowerCase()) &&
          !newItems.some((b) => b.text.toLowerCase() === cleanText.toLowerCase())
        ) {
          newItems.push({
            id: `q_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
            text: cleanText,
            marks: q.marks || 1,
            difficulty,
            options: q.options,
            alternative: typeof q.alternative === "string" ? q.alternative : q.alternative?.text,
            dateAdded: new Date().toLocaleDateString(),
            paperTitle,
          });
        }
      }
    }

    if (newItems.length > 0) {
      const updated = [...newItems, ...currentBank].slice(0, 500);
      localStorage.setItem(BANK_KEY, JSON.stringify(updated));
    }
    return true;
  } catch (err) {
    console.error("Failed to update question bank:", err);
    return false;
  }
}

/**
 * Delete a question from the bank.
 */
export function deleteBankQuestion(id: string): StoredBankQuestion[] {
  try {
    const bank = loadQuestionBank().filter((q) => q.id !== id);
    localStorage.setItem(BANK_KEY, JSON.stringify(bank));
    return bank;
  } catch {
    return [];
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

/**
 * Initial seed questions so the Question Bank isn't empty on first run.
 */
function getInitialQuestionBankSeed(): StoredBankQuestion[] {
  return [
    {
      id: "seed_1",
      text: "Which of the following cellular organelles is primarily responsible for adenosine triphosphate (ATP) synthesis?",
      marks: 1,
      options: ["Ribosome", "Mitochondria", "Endoplasmic reticulum", "Golgi apparatus"],
      difficulty: "Easy",
      dateAdded: "2026-10-15",
      paperTitle: "Biology Sample Assessment",
    },
    {
      id: "seed_2",
      text: "Differentiate between endothermic and exothermic reactions with one balanced chemical equation for each.",
      marks: 2,
      difficulty: "Moderate",
      dateAdded: "2026-10-16",
      paperTitle: "Chemistry Mid-Term",
    },
    {
      id: "seed_3",
      text: "Explain Ohm's Law. Describe an experimental setup to verify the relationship between current and potential difference across a conductor.",
      marks: 3,
      difficulty: "Moderate",
      dateAdded: "2026-10-18",
      paperTitle: "Physics Annual Exam",
    },
    {
      id: "seed_4",
      text: "Explain the process of double fertilization in angiosperms. Discuss its biological significance and subsequent seed development.",
      marks: 5,
      alternative: "Describe the human digestive system with the aid of a labeled diagram. Detail the enzymatic digestion occurring in the stomach and small intestine.",
      difficulty: "Advanced",
      dateAdded: "2026-10-20",
      paperTitle: "Biology Mock Exam",
    },
  ];
}
