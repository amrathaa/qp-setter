import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import type { GeneratedQuestion, GeneratedSection } from "./blueprint";
import { toRomanNumeral } from "./text-cleaner";
import { keywordMask } from "./keyword-highlight";
import { assetUrl } from "./asset-url";

export type AnswerKeyLine = { label: string; text: string; keywords?: string[] };

const stripNumber = (text: string) => text.replace(/^\s*\d+[.)]\s*/, "");

const missing = "No matching passage was found in the textbook. Add the model answer on the review screen.";

/**
 * The answer for one question as label/text rows, e.g. "Answer: b) cells" or a model answer with its keywords.
 * MCQ answers are matched to the current options, so a teacher's edits to the options are respected.
 */
export function answerLinesFor(question: GeneratedQuestion): AnswerKeyLine[] {
  if (question.parts?.length) {
    return question.parts.flatMap((part, index) => {
      const label = `(${toRomanNumeral(index + 1)})`;
      const isBlank = /^fill in the blank/i.test(part.text);
      const lines: AnswerKeyLine[] = [{
        label: isBlank ? `${label} Answer` : `${label} Model answer`,
        text: part.answer || missing,
        keywords: isBlank ? undefined : part.keywords,
      }];
      if (part.alternative) {
        lines.push({ label: `${label} OR`, text: part.alternative.answer || missing, keywords: part.alternative.keywords });
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
  const lines: AnswerKeyLine[] = [{ label: "Model answer", text: question.answer || missing, keywords: question.answerKeywords }];
  if (question.alternative) {
    lines.push({ label: "OR", text: question.alternativeAnswer || missing, keywords: question.alternativeKeywords });
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
  const regular = await loadFont(document, assetUrl("fonts/LiberationSans-Regular.ttf"), StandardFonts.Helvetica);
  const bold = await loadFont(document, assetUrl("fonts/LiberationSans-Bold.ttf"), StandardFonts.HelveticaBold);
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

  // Wraps text word by word, drawing keywords and key phrases in bold.
  const writeHighlighted = (text: string, keywords: string[], size: number, x: number, lineWidth: number) => {
    const space = regular.widthOfTextAtSize(" ", size);
    let line: Array<{ text: string; font: PDFFont }> = [];
    let used = 0;
    const flush = () => {
      if (!line.length) return;
      ensureSpace(size * 1.35);
      let cursor = x;
      for (const word of line) {
        page.drawText(word.text, { x: cursor, y: y - size, size, font: word.font, color: rgb(0, 0, 0) });
        cursor += word.font.widthOfTextAtSize(word.text, size) + space;
      }
      y -= size * 1.35;
      line = [];
      used = 0;
    };
    const words = text.split(/\s+/).filter(Boolean);
    const mask = keywordMask(words, keywords);
    for (const [index, raw] of words.entries()) {
      const font = mask[index] ? bold : regular;
      const word = safeText(font, raw);
      const wordWidth = font.widthOfTextAtSize(word, size);
      if (line.length && used + space + wordWidth > lineWidth) flush();
      used += (line.length ? space : 0) + wordWidth;
      line.push({ text: word, font });
    }
    flush();
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
        if (line.keywords) {
          // Long answers: label, then the textbook answer with its keywords in bold, then the keyword list.
          write(labelText, bold, 10, margin + 14, width - 14);
          writeHighlighted(line.text, line.keywords, 10, margin + 24, width - 24);
          if (line.keywords.length) {
            const listLabel = "Keywords to look for: ";
            ensureSpace(14);
            page.drawText(listLabel, { x: margin + 24, y: y - 9, size: 9, font: bold, color: rgb(0, 0, 0) });
            const offset = bold.widthOfTextAtSize(listLabel, 9);
            write(line.keywords.join(", "), regular, 9, margin + 24 + offset, width - 24 - offset);
          }
          y -= 3;
          continue;
        }
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
