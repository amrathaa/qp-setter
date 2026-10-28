import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import type { GeneratedQuestion, GeneratedSection } from "./blueprint";
import { toRomanNumeral } from "./text-cleaner";

export type AnswerKeyLine = { label: string; text: string };

const stripNumber = (text: string) => text.replace(/^\s*\d+[.)]\s*/, "");

/**
 * The answer for one question as label/text rows, e.g. "Answer: b) cells" or "(ii) Key point: ...".
 * MCQ answers are matched to the current options, so a teacher's edits to the options are respected.
 */
export function answerLinesFor(question: GeneratedQuestion): AnswerKeyLine[] {
  if (question.parts?.length) {
    return question.parts.flatMap((part, index) => {
      const label = `(${toRomanNumeral(index + 1)})`;
      const kind = /^fill in the blank/i.test(part.text) ? "Answer" : "Key point";
      const lines = [{ label, text: part.answer ? `${kind}: ${part.answer}` : "Answer from the passage." }];
      if (part.alternative) {
        lines.push({ label: `${label} OR`, text: part.alternative.answer ? `Any relevant points from the passage: ${part.alternative.answer}` : "Answer from the passage." });
      }
      return lines;
    });
  }
  if (question.options?.length) {
    const index = question.options.findIndex((option) => option.trim().toLowerCase() === (question.answer || "").trim().toLowerCase());
    return [{
      label: "Answer",
      text: index >= 0
        ? `${String.fromCharCode(97 + index)}) ${question.options[index]}`
        : "Not set. Choose the correct option on the review screen.",
    }];
  }
  const lines = [{ label: "Key point", text: question.answer || "Answer from the chapter (no single source sentence)." }];
  if (question.alternative) {
    lines.push({ label: "OR", text: question.alternativeAnswer || "Answer from the chapter (no single source sentence)." });
  }
  return lines;
}

const loadFont = async (document: PDFDocument, path: string, fallback: StandardFonts) => {
  try {
    const response = await fetch(path);
    if (!response.ok) throw new Error("Font unavailable.");
    return await document.embedFont(new Uint8Array(await response.arrayBuffer()), { subset: true });
  } catch {
    return document.embedFont(fallback);
  }
};

// Replace characters the font cannot draw rather than failing the whole key.
const safeText = (font: PDFFont, text: string) =>
  [...text].map((character) => {
    try {
      font.encodeText(character);
      return character;
    } catch {
      return "?";
    }
  }).join("");

const wrap = (font: PDFFont, text: string, size: number, width: number) => {
  const lines: string[] = [];
  let current = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const candidate = current ? `${current} ${word}` : word;
    if (current && font.widthOfTextAtSize(candidate, size) > width) {
      lines.push(current);
      current = word;
    } else current = candidate;
  }
  if (current) lines.push(current);
  return lines.length ? lines : [""];
};

/**
 * Builds a separate teacher's answer key PDF for the drafted paper.
 */
export async function createAnswerKeyPdf(
  sections: GeneratedSection[],
  title: string,
  totalMarks: number,
): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  document.registerFontkit(fontkit);
  const regular = await loadFont(document, "/fonts/LiberationSans-Regular.ttf", StandardFonts.Helvetica);
  const bold = await loadFont(document, "/fonts/LiberationSans-Bold.ttf", StandardFonts.HelveticaBold);
  const [pageWidth, pageHeight] = [595.28, 841.89];
  const margin = 48;
  const width = pageWidth - margin * 2;
  let page: PDFPage = document.addPage([pageWidth, pageHeight]);
  let y = pageHeight - margin;

  const ensureSpace = (height: number) => {
    if (y - height >= margin + 20) return;
    page = document.addPage([pageWidth, pageHeight]);
    y = pageHeight - margin;
  };
  const write = (text: string, font: PDFFont, size: number, x = margin, lineWidth = width) => {
    for (const line of wrap(font, safeText(font, text), size, lineWidth)) {
      ensureSpace(size * 1.35);
      page.drawText(line, { x, y: y - size, size, font, color: rgb(0, 0, 0) });
      y -= size * 1.35;
    }
  };

  write(`Answer Key - ${title}`, bold, 15);
  write(`For teachers only. Total: ${totalMarks} marks.`, regular, 10);
  y -= 8;

  let number = 0;
  for (const section of sections) {
    if (!section.questions.length) continue;
    ensureSpace(40);
    y -= 6;
    write(section.label, bold, 12);
    y -= 2;
    for (const question of section.questions) {
      number += 1;
      ensureSpace(30);
      const stem = question.kind === "case"
        ? "Case-based question (passage)"
        : stripNumber(question.text).replace(/\s+/g, " ");
      write(`${number}. ${stem.length > 140 ? `${stem.slice(0, 137)}...` : stem}`, regular, 9, margin, width);
      for (const line of answerLinesFor(question)) {
        const labelText = safeText(bold, `${line.label}:`);
        const labelWidth = bold.widthOfTextAtSize(labelText, 10) + 6;
        ensureSpace(14);
        page.drawText(labelText, { x: margin + 14, y: y - 10, size: 10, font: bold, color: rgb(0, 0, 0) });
        write(line.text, regular, 10, margin + 14 + labelWidth, width - 14 - labelWidth);
      }
      y -= 5;
    }
  }

  const pages = document.getPages();
  pages.forEach((current, index) => {
    const label = `Answer Key - Page ${index + 1} of ${pages.length}`;
    current.drawText(label, { x: (pageWidth - regular.widthOfTextAtSize(label, 8)) / 2, y: 24, size: 8, font: regular, color: rgb(0.35, 0.35, 0.35) });
  });
  return document.save();
}
