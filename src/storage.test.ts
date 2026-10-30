import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applySyncFile,
  buildSyncFile,
  deleteRecentPaper,
  loadProfile,
  loadRecentPapers,
  saveProfile,
  saveRecentPaper,
  type StoredPaper,
} from "./storage";

// Each simulated computer has its own browser storage; tests switch between them.
type Computer = { local: Map<string, string>; idb: IDBFactory };
const newComputer = (): Computer => ({ local: new Map(), idb: new IDBFactory() });
const switchTo = (computer: Computer) => {
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => computer.local.get(key) ?? null,
    setItem: (key: string, value: string) => computer.local.set(key, String(value)),
    removeItem: (key: string) => computer.local.delete(key),
  });
  vi.stubGlobal("indexedDB", computer.idb);
};

const paper = (id: string, title = id): StoredPaper => ({
  id,
  createdAt: new Date().toISOString(),
  title,
  subject: "Science",
  className: "IX",
  totalMarks: 10,
  duration: 60,
  difficulty: "Easy",
  questionCount: 1,
  sections: [{ label: "Section A", questions: [{ text: "1. Define a cell.", marks: 1 }] }],
});

let file = "";
// One sync, as the app does it: merge the shared file in, then write the merged result back.
const sync = async (computer: Computer) => {
  switchTo(computer);
  const result = file ? await applySyncFile(file) : null;
  file = await buildSyncFile();
  return result;
};
const titles = () => loadRecentPapers().map((p) => p.title).sort();
// "Most recent wins" needs time to pass between changes.
const later = () => vi.setSystemTime(Date.now() + 60_000);

let a: Computer;
let b: Computer;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-01T09:00:00Z"));
  file = "";
  a = newComputer();
  b = newComputer();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("sync between computers", () => {
  it("brings a new paper and the profile to the other computer", async () => {
    switchTo(a);
    saveRecentPaper(paper("p1", "Term 1"));
    saveProfile({ name: "Priya", department: "Science" });
    await sync(a);
    const result = await sync(b);
    expect(result?.added).toBe(1);
    expect(titles()).toEqual(["Term 1"]);
    expect(loadProfile().name).toBe("Priya");
  });

  it("keeps papers made on both computers", async () => {
    switchTo(a);
    saveRecentPaper(paper("p1", "From A"));
    switchTo(b);
    saveRecentPaper(paper("p2", "From B"));
    await sync(a);
    await sync(b);
    await sync(a);
    expect(titles()).toEqual(["From A", "From B"]);
    switchTo(b);
    expect(titles()).toEqual(["From A", "From B"]);
  });

  it("removes a deleted paper everywhere and keeps it deleted", async () => {
    switchTo(a);
    saveRecentPaper(paper("p1"));
    await sync(a);
    await sync(b);
    later();
    switchTo(b);
    deleteRecentPaper("p1");
    await sync(b);
    const result = await sync(a);
    expect(result?.removed).toBe(1);
    expect(titles()).toEqual([]);
    // Syncing B again must not bring it back from anywhere.
    await sync(b);
    expect(titles()).toEqual([]);
  });

  it("takes the newer copy of a paper that changed", async () => {
    switchTo(a);
    saveRecentPaper(paper("p1", "Draft title"));
    await sync(a);
    await sync(b);
    later();
    switchTo(a);
    saveRecentPaper(paper("p1", "Final title"));
    await sync(a);
    const result = await sync(b);
    expect(result?.updated).toBe(1);
    expect(titles()).toEqual(["Final title"]);
  });

  it("keeps the most recent profile edit on both computers", async () => {
    switchTo(b);
    saveProfile({ name: "Edited on B", department: "x" });
    later();
    switchTo(a);
    saveProfile({ name: "Edited later on A", department: "y" });
    await sync(b);
    await sync(a);
    await sync(b);
    expect(loadProfile().name).toBe("Edited later on A");
    switchTo(a);
    expect(loadProfile().name).toBe("Edited later on A");
  });

  it("changes nothing when synced again", async () => {
    switchTo(a);
    saveRecentPaper(paper("p1"));
    await sync(a);
    await sync(b);
    const result = await sync(b);
    expect(result).toMatchObject({ added: 0, updated: 0, removed: 0, profileChanged: false });
  });

  it("refuses files that are not QP Setter sync files", async () => {
    switchTo(a);
    expect(await applySyncFile("not json")).toBeNull();
    expect(await applySyncFile(JSON.stringify({ questions: [] }))).toBeNull();
  });

  it("still loads sync files from the first version", async () => {
    switchTo(a);
    const v1 = JSON.stringify({ kind: "sync", version: 1, papers: [paper("old", "Old paper")], questions: [] });
    const result = await applySyncFile(v1);
    expect(result?.added).toBe(1);
    expect(titles()).toEqual(["Old paper"]);
  });
});
