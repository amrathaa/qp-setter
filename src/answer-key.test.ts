import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { answerLinesFor, createAnswerKeyPdf } from "./answer-key";

describe("answer key", () => {
  it("gives an MCQ's answer as its option letter and text", () => {
    const lines = answerLinesFor({ text: "1. Which gas do plants release?", marks: 1, options: ["Nitrogen", "Oxygen", "Argon", "Helium"], answer: "Oxygen" });
    expect(lines).toEqual([{ label: "Answer", text: "b) Oxygen" }]);
  });

  it("asks the teacher to choose when an MCQ's answer matches no option", () => {
    const [line] = answerLinesFor({ text: "1. Pick one.", marks: 1, options: ["a", "b", "c", "d"], answer: "z" });
    expect(line.text).toMatch(/Not set/);
  });

  it("gives written questions their model answer and keywords", () => {
    const [line] = answerLinesFor({ text: "2. Define a cell.", marks: 2, answer: "The basic unit of life.", answerKeywords: ["unit", "life"] });
    expect(line).toEqual({ label: "Model answer", text: "The basic unit of life.", keywords: ["unit", "life"] });
  });

  it("builds a readable PDF", async () => {
    const bytes = await createAnswerKeyPdf(
      [
        { label: "Section A", questions: [{ text: "1. Which gas do plants release?", marks: 1, options: ["Nitrogen", "Oxygen", "Argon", "Helium"], answer: "Oxygen" }] },
        { label: "Section B", questions: [{ text: "2. Define a cell.", marks: 2, answer: "The basic unit of life." }] },
      ],
      "Unit test",
      3,
    );
    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getPageCount()).toBeGreaterThan(0);
  });
});
