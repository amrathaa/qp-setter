import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import * as pdfjsLib from "pdfjs-dist";
import { analyzeBlueprintBytes, BlueprintAnalysisError, type BlueprintAnalysis, type GeneratedSection } from "./blueprint";
import { fillBlueprintPdf } from "./blueprint-reflow";

type Fixture = {
  name: string;
  expectedTier: 1 | 2 | 3 | "scanned";
  create: () => Promise<Uint8Array>;
  sections?: GeneratedSection[];
};

const addText = (
  page: ReturnType<PDFDocument["addPage"]>,
  text: string,
  x: number,
  y: number,
  font: Awaited<ReturnType<PDFDocument["embedFont"]>>,
  size = 12,
) => page.drawText(text, { x, y, font, size, color: rgb(0, 0, 0) });

const createPaper = async (
  size: [number, number],
  pages: Array<(document: PDFDocument, page: ReturnType<PDFDocument["addPage"]>, fonts: { regular: Awaited<ReturnType<PDFDocument["embedFont"]>>; bold: Awaited<ReturnType<PDFDocument["embedFont"]>>; times: Awaited<ReturnType<PDFDocument["embedFont"]>> }) => void>,
) => {
  const document = await PDFDocument.create();
  const regular = await document.embedFont(StandardFonts.Helvetica);
  const bold = await document.embedFont(StandardFonts.HelveticaBold);
  const times = await document.embedFont(StandardFonts.TimesRoman);
  for (const createPage of pages) {
    const page = document.addPage(size);
    createPage(document, page, { regular, bold, times });
  }
  return document.save();
};

const fixtures: Fixture[] = [
  {
    name: "clean blueprint A-E pattern 19 questions",
    expectedTier: 2,
    create: () => createPaper([595, 842], [(_document, page, fonts) => {
      addText(page, "SCHOOL OF SCIENCE", 205, 805, fonts.bold, 14);
      addText(page, "Annual Examination", 220, 780, fonts.bold, 12);
      addText(page, "General instructions", 60, 742, fonts.bold, 10);
      addText(page, "Answer all questions in the spaces provided.", 60, 724, fonts.regular, 9);
      addText(page, "Section A", 60, 680, fonts.bold, 12);
      addText(page, "Section B", 60, 580, fonts.bold, 12);
      addText(page, "Section C", 60, 480, fonts.bold, 12);
      addText(page, "Section D", 60, 380, fonts.bold, 12);
      addText(page, "Section E", 60, 280, fonts.bold, 12);
      addText(page, "Page 1 of 1", 260, 18, fonts.regular, 9);
    }]),
    sections: [9, 4, 3, 2, 1].map((count, sectionIndex) => ({
      label: `Section ${String.fromCharCode(65 + sectionIndex)}`,
      questions: Array.from({ length: count }, (_, questionIndex) => ({
        text: `ACCEPTANCE ${String.fromCharCode(65 + sectionIndex)}${questionIndex + 1}: explain this concept.`,
        marks: [1, 2, 3, 5, 4][sectionIndex],
      })),
    })),
  },
  {
    name: "four-section pattern omits Section E",
    expectedTier: 2,
    create: async () => (await fixtures[0].create()),
    sections: [9, 4, 3, 2].map((count, sectionIndex) => ({
      label: `Section ${String.fromCharCode(65 + sectionIndex)}`,
      questions: Array.from({ length: count }, (_, questionIndex) => ({
        text: `FOUR ${String.fromCharCode(65 + sectionIndex)}${questionIndex + 1}: explain this concept.`,
        marks: [1, 2, 3, 5][sectionIndex],
      })),
    })),
  },
  {
    name: "one-page Section A/B/C",
    expectedTier: 2,
    create: () => createPaper([595, 842], [(_document, page, fonts) => {
      addText(page, "Annual Examination", 210, 780, fonts.bold, 16);
      addText(page, "Section A", 60, 690, fonts.bold, 13);
      addText(page, "Answer all questions.", 60, 672, fonts.regular, 10);
      addText(page, "Section B", 60, 460, fonts.bold, 13);
      addText(page, "Show your work.", 60, 442, fonts.regular, 10);
      addText(page, "Section C", 60, 230, fonts.bold, 13);
      addText(page, "Page 1 of 1", 260, 18, fonts.regular, 9);
    }]),
    sections: ["A", "B", "C"].map((label) => ({
      label: `Section ${label}`,
      questions: [{
        text: `FIXTURE ${label}: explain the key concept clearly.`,
        marks: 2,
        options: ["FIXTURE option a", "FIXTURE option b", "FIXTURE option c", "FIXTURE option d"],
        alternative: "FIXTURE alternative response with a reason.",
      }],
    })),
  },
  {
    name: "two-page PART I/PART II with running footer",
    expectedTier: 2,
    create: () => createPaper([612, 792], [(_document, page, fonts) => {
      addText(page, "Campus Assessment", 220, 760, fonts.bold, 12);
      addText(page, "PART I", 60, 650, fonts.bold, 13);
      addText(page, "Answer in complete sentences.", 60, 632, fonts.regular, 10);
      addText(page, "Page 1 of 2", 490, 20, fonts.regular, 9);
    }, (_document, page, fonts) => {
      addText(page, "Campus Assessment", 220, 760, fonts.bold, 12);
      addText(page, "PART II", 60, 650, fonts.bold, 13);
      addText(page, "Use the diagram where appropriate.", 60, 632, fonts.regular, 10);
      addText(page, "Page 2 of 2", 490, 20, fonts.regular, 9);
    }]),
    sections: ["Section A", "Section B"].map((label) => ({
      label,
      questions: [{ text: `FIXTURE ${label}: explain the result.`, marks: 3 }],
    })),
  },
  {
    name: "overflow continues beside its section",
    expectedTier: 2,
    create: () => createPaper([595, 842], [(_document, page, fonts) => {
      addText(page, "Assessment", 235, 780, fonts.bold, 15);
      addText(page, "Section A", 60, 690, fonts.bold, 13);
      addText(page, "Section B", 60, 230, fonts.bold, 13);
      addText(page, "Page 1 of 1", 260, 18, fonts.regular, 9);
    }]),
    sections: [
      {
        label: "Section A",
        questions: Array.from({ length: 40 }, (_, index) => ({ text: `FIXTURE A${index + 1}: explain this concept with a short supporting detail.`, marks: 2 })),
      },
      { label: "Section B", questions: [{ text: "FIXTURE B1: finish the paper.", marks: 1 }] },
    ],
  },
  {
    name: "no headings fallback",
    expectedTier: 3,
    create: () => createPaper([595, 842], [(_document, page, fonts) => {
      addText(page, "College Assessment", 205, 780, fonts.bold, 15);
      addText(page, "Answer every question in the spaces provided.", 60, 620, fonts.regular, 11);
      addText(page, "Use appropriate scientific terms in your answers.", 60, 600, fonts.regular, 11);
      addText(page, "Page 1 of 1", 260, 18, fonts.regular, 9);
    }]),
    sections: [{ label: "Section A", questions: [{ text: "FIXTURE fallback question.", marks: 1 }] }],
  },
  {
    name: "explicit section markers",
    expectedTier: 1,
    create: () => createPaper([595, 842], [(_document, page, fonts) => {
      addText(page, "Assessment", 235, 780, fonts.bold, 15);
      addText(page, "{{SECTION A}}", 60, 680, fonts.regular, 12);
      addText(page, "{{SECTION B}}", 60, 390, fonts.regular, 12);
      addText(page, "Page 1 of 1", 260, 18, fonts.regular, 9);
    }]),
    sections: ["A", "B"].map((label) => ({
      label: `Section ${label}`,
      questions: [{ text: `FIXTURE ${label}: marker placement check.`, marks: 2 }],
    })),
  },
  {
    name: "Times New Roman Letter with math symbols",
    expectedTier: 2,
    create: () => createPaper([612, 792], [(_document, page, fonts) => {
      addText(page, "Physics Paper", 235, 750, fonts.times, 16);
      addText(page, "Section A", 65, 650, fonts.times, 13);
      addText(page, "Answer all parts.", 65, 632, fonts.times, 11);
      addText(page, "Page 1 of 1", 500, 18, fonts.times, 9);
    }]),
    sections: [{ label: "Section A", questions: [{ text: "FIXTURE: calculate θ at 25° when x² = 4. नमूना", marks: 2 }] }],
  },
  {
    name: "scanned image PDF",
    expectedTier: "scanned",
    create: async () => {
      const pdfDocument = await PDFDocument.create();
      const page = pdfDocument.addPage([595, 842]);
      const canvas = document.createElement("canvas");
      canvas.width = 900;
      canvas.height = 1200;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Canvas is unavailable in the quality runner.");
      context.fillStyle = "white";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = "black";
      context.font = "48px serif";
      context.fillText("Section A", 100, 200);
      const image = await pdfDocument.embedPng(canvas.toDataURL("image/png"));
      page.drawImage(image, { x: 0, y: 0, width: 595, height: 842 });
      return pdfDocument.save();
    },
  },
];

const renderCanvas = async (bytes: Uint8Array, pageIndex: number) => {
  const pdf = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
  const page = await pdf.getPage(pageIndex + 1);
  const viewport = page.getViewport({ scale: 1 });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("Canvas is unavailable in the quality runner.");
  await page.render({ canvas, canvasContext: context, viewport }).promise;
  return canvas;
};

const compareHeaderPixels = async (source: Uint8Array, output: Uint8Array, analysis: BlueprintAnalysis) => {
  const [before, after] = await Promise.all([renderCanvas(source, 0), renderCanvas(output, 0)]);
  const height = Math.min(before.height, after.height, Math.ceil(before.height - analysis.headerBottomY));
  const left = before.getContext("2d", { willReadFrequently: true })!.getImageData(0, 0, before.width, height).data;
  const right = after.getContext("2d", { willReadFrequently: true })!.getImageData(0, 0, after.width, height).data;
  let compared = 0;
  let identical = 0;
  for (let y = 0; y < height; y += 2) {
    for (let x = 0; x < before.width; x += 2) {
      const offset = (y * before.width + x) * 4;
      compared += 1;
      if (left[offset] === right[offset] && left[offset + 1] === right[offset + 1] && left[offset + 2] === right[offset + 2]) identical += 1;
    }
  }
  return compared > 0 ? identical / compared : 0;
};

const checkNoOverlap = (analysis: BlueprintAnalysis, output: BlueprintAnalysis, fixturePrefix: string) => {
  const retainedLines = analysis.lines.filter((line) =>
    (line.pageIndex === 0 && line.y + line.fontSize * 0.8 >= analysis.headerBottomY) ||
    analysis.footerLines.has(line) ||
    analysis.pageNumberLines.has(line),
  );
  const generated = output.lines.filter((line) => line.text.includes(fixturePrefix));
  const noTextOverlap = generated.every((line) => retainedLines.every((original) => {
    if (line.pageIndex !== original.pageIndex) return true;
    const lineTop = line.y;
    const lineBottom = line.y - line.fontSize;
    const sourceTop = original.y + original.fontSize * 0.2;
    const sourceBottom = original.y - original.fontSize;
    return lineBottom >= sourceTop || sourceBottom >= lineTop || line.x >= original.xRight || line.xRight <= original.x;
  }));
  return { noTextOverlap };
};

const markerIsCovered = async (bytes: Uint8Array, analysis: BlueprintAnalysis) => {
  const region = analysis.regions.find((candidate) => candidate.source === "marker" && candidate.marker);
  if (!region?.marker) return true;
  const pdf = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
  const page = await pdf.getPage(region.marker.pageIndex + 1);
  const viewport = page.getViewport({ scale: 1 });
  const canvas = document.createElement("canvas");
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return false;
  await page.render({ canvas, canvasContext: context, viewport }).promise;
  const marker = region.marker;
  const xStart = Math.max(0, Math.floor(marker.x + marker.width * 0.1));
  const xEnd = Math.min(canvas.width - 1, Math.ceil(marker.x + marker.width * 0.9));
  const y = Math.max(0, Math.min(canvas.height - 1, Math.floor(canvas.height - marker.y - marker.height / 2)));
  let samples = 0;
  for (let x = xStart; x <= xEnd; x += 4) {
    const pixel = context.getImageData(x, y, 1, 1).data;
    if (pixel[0] > 240 && pixel[1] > 240 && pixel[2] > 240) samples += 1;
  }
  return samples > Math.max(1, Math.floor((xEnd - xStart) / 16));
};

export const runBlueprintQualityCases = async () => {
  const results = [];
  for (const fixture of fixtures) {
    const source = await fixture.create();
    if (fixture.expectedTier === "scanned") {
      let message = "";
      try {
        await analyzeBlueprintBytes(source);
      } catch (error) {
        message = error instanceof BlueprintAnalysisError ? error.message : String(error);
      }
      results.push({
        case: fixture.name,
        tier: "scanned-stop",
        noTextOverlap: message.includes("This PDF looks scanned"),
        footerClear: true,
        numberingContinuous: true,
        expectedTier: message === "This PDF looks scanned (no selectable text). Please upload a text-based PDF.",
        message,
        continuationInserted: false,
      });
      continue;
    }
    const analysis = await analyzeBlueprintBytes(source);
    const output = await fillBlueprintPdf(source, analysis, fixture.sections || []);
    const outputAnalysis = await analyzeBlueprintBytes(output.bytes);
    const fixturePrefix = fixture.name.startsWith("clean blueprint")
      ? "ACCEPTANCE"
      : fixture.name.startsWith("four-section")
        ? "FOUR"
        : "FIXTURE";
    const fixtureLines = outputAnalysis.lines.filter((line) => line.text.includes(fixturePrefix));
    const numberMatches = fixtureLines.map((line) => Number(line.text.match(/^(?:Q\s*\.?\s*)?(\d+)[.)]?/)?.[1])).filter(Number.isFinite);
    const expectedQuestionCount = fixture.sections?.reduce((total, section) => total + section.questions.length, 0) || 0;
    const footerClear = fixtureLines.every((line) => {
      const style = analysis.pageStyles[Math.min(line.pageIndex, analysis.pageStyles.length - 1)];
      return line.y > style.footerTop + 8;
    });
    const preservation = checkNoOverlap(analysis, outputAnalysis, fixturePrefix);
    const headerSimilarity = await compareHeaderPixels(source, output.bytes, analysis);
    const headerPreserved = headerSimilarity > 0.98;
    const sectionLines = outputAnalysis.lines.filter((line) => /^Section\s+[A-Z0-9]+\b/.test(line.text));
    const expectedSectionCount = fixture.sections?.length || 0;
    const sectionLabelsMatch = new Set(output.report.map((row) => row.section)).size === expectedSectionCount;
    const headingFlow = fixture.name.startsWith("clean blueprint")
      ? (() => {
          const sourceSectionB = analysis.lines.find((line) => line.pageIndex === 0 && line.text === "Section B");
          const sectionB = sectionLines.find((line) => line.text.includes("Section B") && (!sourceSectionB || Math.abs(line.y - sourceSectionB.y) > 1));
          const lastAQuestion = outputAnalysis.lines.filter((line) => line.text.includes("ACCEPTANCE A")).sort((a, b) => a.pageIndex - b.pageIndex || a.y - b.y).at(-1);
          return Boolean(sectionB && lastAQuestion && (sectionB.pageIndex > lastAQuestion.pageIndex || sectionB.y < lastAQuestion.y));
        })()
      : true;
    const marginsConsistent = fixtureLines.every((line) =>
      line.x >= analysis.leftMargin - 1 && line.xRight <= analysis.pageStyles[0].pageWidth - analysis.rightMargin + 1,
    );
    const pageNumbersValid = Array.from({ length: outputAnalysis.pageStyles.length }, (_, index) =>
      outputAnalysis.lines.some((line) => line.pageIndex === index && line.text.includes(`Page ${index + 1} of ${outputAnalysis.pageStyles.length}`)),
    ).every(Boolean);
    const originalSectionE = analysis.lines.find((line) => line.pageIndex === 0 && line.text === "Section E");
    const sectionEOmitted = !fixture.name.startsWith("four-section") || Boolean(originalSectionE && !output.report.some((row) => row.section === "Section E"));
    const expectedFont = fixture.name.includes("Times") ? "liberationSerif" : "liberationSans";
    results.push({
      case: fixture.name,
      tier: analysis.tier,
      paperFont: analysis.paperFont,
      regions: analysis.regions.map((region) => ({ label: region.label, key: region.key, pageCount: region.slices.length })),
      headerSimilarity,
      headerPreserved,
      ...preservation,
      footerClear,
      numberingContinuous: numberMatches.length === expectedQuestionCount && numberMatches.every((number, index) => number === index + 1),
      questionNumbers: numberMatches,
      expectedTier: analysis.tier === fixture.expectedTier,
      fontFamilyMatches: analysis.paperFont === expectedFont,
      sectionLabelsMatch,
      headingFlow,
      marginsConsistent,
      pageNumbersValid,
      sectionEOmitted,
      markersHidden: fixture.expectedTier === 1 ? await markerIsCovered(output.bytes, analysis) : true,
      continuationInserted: outputAnalysis.pageStyles.length > analysis.pageStyles.length,
      unicodeSymbolsPreserved: !fixture.name.includes("Times") ||
        (["θ", "°", "²"].every((character) => outputAnalysis.lines.some((line) => line.text.includes(character))) &&
          (outputAnalysis.lines.some((line) => line.text.includes("नमूना")) ||
            (outputAnalysis.lines.some((line) => line.text.includes("?????") ) && output.warnings.some((warning) => warning.includes("ASCII equivalents"))))),
      warnings: output.warnings,
      report: output.report,
      pagesOut: outputAnalysis.pageStyles.length,
    });
  }
  return results;
};
