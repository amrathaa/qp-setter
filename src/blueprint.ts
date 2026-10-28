import * as pdfjsLib from "pdfjs-dist";
import { cleanBrokenKerningWords } from "./text-cleaner";

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url,
).toString();

// Re-exported with the worker configured, for other lazily loaded PDF readers.
export { pdfjsLib };

export type BlueprintLine = {
  text: string;
  x: number;
  xRight: number;
  y: number;
  fontSize: number;
  fontFamily: string;
  fontName: string;
  bold: boolean;
  pageIndex: number;
  parts?: BlueprintLinePart[];
};

export type BlueprintLinePart = {
  text: string;
  x: number;
  xRight: number;
  fontSize: number;
  fontName: string;
  bold: boolean;
};

export type BlueprintHeaderField = {
  kind: "marks" | "time";
  pageIndex: number;
  text: string;
  value: number;
  x: number;
  xRight: number;
  y: number;
  fontSize: number;
  fontName: string;
  bold: boolean;
};

export type BlueprintPageStyle = {
  pageIndex: number;
  pageWidth: number;
  pageHeight: number;
  bodyFontSize: number;
  fontFamily: string;
  leftMargin: number;
  rightMargin: number;
  lineHeight: number;
  questionGap: number;
  numberingStyle: "1." | "1)" | "Q1." | "Q.1" | "(1)";
  showMarksRight: boolean;
  marksStyle: "square" | "round" | "marks";
  footerTop: number;
  headerBottom: number;
  safeTop: number;
  safeBottom: number;
};

export type BlueprintSlice = {
  pageIndex: number;
  startY: number;
  endY: number;
};

export type BlueprintRegion = {
  label: string;
  key: string | null;
  source: "marker" | "heading" | "fallback";
  marker?: { pageIndex: number; x: number; y: number; width: number; height: number };
  slices: BlueprintSlice[];
};

export type BlueprintInstructionLine = {
  text: string;
  fontSize: number;
  bold: boolean;
  x: number;
  gap: number;
};

export type BlueprintHeading = {
  text: string;
  key: string | null;
  fontSize: number;
  bold: boolean;
  align: "left" | "center";
  x: number;
  gapAbove: number;
  gapBelowHeading: number;
  instructions: BlueprintInstructionLine[];
};

export type BlueprintPageNumber = {
  sampleText: string;
  fontName: string;
  x: number;
  y: number;
  width: number;
  height: number;
  align: "left" | "center" | "right";
  fontSize: number;
  bold: boolean;
  pattern: "page-of" | "of" | "slash" | "wrapped" | "number";
};

export type BlueprintAnalysis = {
  lines: BlueprintLine[];
  bodyLines: BlueprintLine[];
  pageStyles: BlueprintPageStyle[];
  regions: BlueprintRegion[];
  headings: BlueprintHeading[];
  headerBottomY: number;
  generalInstructionsY?: number;
  pageBodyStarts: number[];
  leftMargin: number;
  rightMargin: number;
  bodyFontSize: number;
  paperFont: "carlito" | "liberationSans" | "liberationSerif";
  pageNumbers: Array<BlueprintPageNumber | null>;
  pageNumberLines: Set<BlueprintLine>;
  footerLines: Set<BlueprintLine>;
  runningHeaderLines?: Set<BlueprintLine>;
  headerLines: BlueprintLine[];
  headerFields: BlueprintHeaderField[];
  hasColoredBackground: boolean;
  generalInstructionsText: string;
  tier: 1 | 2 | 3;
  warnings: string[];
};

export type GeneratedQuestionPart = {
  text: string;
  marks: number;
  answer?: string;
  keywords?: string[];
  alternative?: { text: string; answer?: string; keywords?: string[] };
};

export type GeneratedQuestion = {
  text: string;
  marks?: number;
  options?: string[];
  alternative?: string | { text: string; options?: string[] };
  /** MCQ: the correct option's text. Written questions: the key textbook point for marking. */
  answer?: string;
  /** Key terms a marker looks for; highlighted in the answer key. */
  answerKeywords?: string[];
  alternativeAnswer?: string;
  alternativeKeywords?: string[];
  /** Case-based questions: the passage is `text`, followed by these sub-questions. */
  kind?: "case";
  parts?: GeneratedQuestionPart[];
};

export type GeneratedSection = {
  label: string;
  questions: GeneratedQuestion[];
};

export type BlueprintReportRow = {
  section: string;
  page: number;
  startY: number;
  endY: number;
  questionsDrawn: number;
};

export type BlueprintFillResult = {
  bytes: Uint8Array;
  warnings: string[];
  report: BlueprintReportRow[];
};

export class BlueprintAnalysisError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlueprintAnalysisError";
  }
}

type PageGeometry = { width: number; height: number };
type Marker = {
  pageIndex: number;
  x: number;
  y: number;
  fontSize: number;
  width: number;
  height: number;
  key: string | null;
};
type HeadingCandidate = { line: BlueprintLine; key: string | null; label: string };

const markerPattern = /\{\{\s*(questions|section\s*[A-Za-z0-9]+)\s*\}\}|\[\s*questions?\s*(here)?\s*\]/gi;
const headingPattern = /^\s*(section|part|group|unit|module|category|paper)\s*[-–—:.]?\s*([A-Za-z0-9]{1,4}|[IVXivx]+)\b/i;
const questionRangePattern = /^(?:Q\s*\.?\s*No\.?|Question\s*No\.?)\s*[:.]?\s*(\d+)\s*[-–—]|^(?:Q\s*\.?\s*No\.?|Question\s*No\.?)\s*[:.]?\s*(\d+)\s+(?:to|through)\s+(\d+)/i;
const numberStartPattern = /^(?:Q\s*\.?\s*\d+\.?|Q\.\s*\d+|\(\d+\)|\d+[.)])\s*/i;
const median = (values: number[], fallback: number) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) return fallback;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

const percentile = (values: number[], fraction: number, fallback: number) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) return fallback;
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))];
};

export const mapPaperFont = (name: string): BlueprintAnalysis["paperFont"] => {
  const normalized = name.replace(/^[A-Z]{6}\+/, "").toLowerCase();
  if (/calibri|carlito/.test(normalized)) return "carlito";
  if (/times|liberation.?serif|georgia|cambria|garamond|palatino/.test(normalized)) return "liberationSerif";
  if (/arial|helvetica|liberation.?sans|sans/.test(normalized)) return "liberationSans";
  return "liberationSans";
};

const mostCommon = (values: string[], fallback: string) => {
  const counts = new Map<string, number>();
  values.map((value) => value.trim()).filter(Boolean).forEach((value) => {
    counts.set(value, (counts.get(value) || 0) + 1);
  });
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || fallback;
};

const normalizeRunningText = (text: string) =>
  text.replace(/\d/g, "").replace(/\s+/g, " ").trim().toLowerCase();

const lineItemsToModel = (
  pageIndex: number,
  items: Array<{ str?: string; transform?: number[]; width?: number; fontName?: string }>,
  styles: Record<string, { fontFamily?: string }>,
  realFontNames: Map<string, string>,
): BlueprintLine[] => {
  const positioned = items.flatMap((item) => {
    const text = (item.str || "").trim();
    const transform = item.transform || [];
    if (!text || transform.length < 6) return [];
    const fontSize = Math.max(1, Math.hypot(transform[0] || 0, transform[1] || 0));
    const fontName = item.fontName ? realFontNames.get(item.fontName) || styles[item.fontName]?.fontFamily || "" : "";
    const fontFamily = fontName;
    return [{
      text,
      x: transform[4] || 0,
      xRight: (transform[4] || 0) + Math.max(0, item.width || 0),
      y: transform[5] || 0,
      fontSize,
      fontFamily,
      fontName,
      bold: /bold|black/i.test(fontName),
    }];
  }).sort((a, b) => b.y - a.y || a.x - b.x);

  const groups: Array<{ y: number; entries: typeof positioned }> = [];
  for (const item of positioned) {
    const group = groups.find((candidate) => {
      const groupSize = median(candidate.entries.map((entry) => entry.fontSize), item.fontSize);
      return Math.abs(candidate.y - item.y) <= Math.max(0.5, ((groupSize + item.fontSize) / 2) * 0.4);
    });
    if (group) {
      group.entries.push(item);
      group.y = median(group.entries.map((entry) => entry.y), group.y);
    } else groups.push({ y: item.y, entries: [item] });
  }

  return groups.map((group) => {
    const entries = group.entries.sort((a, b) => a.x - b.x);
    const family = mostCommon(entries.map((entry) => entry.fontFamily), "");
    let joinedText = "";
    for (let i = 0; i < entries.length; i += 1) {
      const cur = entries[i];
      joinedText += cur.text;
      const next = entries[i + 1];
      if (next) {
        const gap = next.x - cur.xRight;
        if (gap > cur.fontSize * 0.18 && !/\s$/.test(cur.text) && !/^\s/.test(next.text)) {
          joinedText += " ";
        }
      }
    }
    const text = cleanBrokenKerningWords(joinedText.replace(/\s+/g, " ").trim());
    return {
      text,
      x: Math.min(...entries.map((entry) => entry.x)),
      xRight: Math.max(...entries.map((entry) => entry.xRight)),
      y: group.y,
      fontSize: median(entries.map((entry) => entry.fontSize), 11),
      fontFamily: family,
      fontName: mostCommon(entries.map((entry) => entry.fontName), ""),
      bold: entries.filter((entry) => entry.bold).length > entries.length / 2,
      pageIndex,
      parts: entries.map(({ text: partText, x, xRight, fontSize, fontName, bold }) => ({ text: partText, x, xRight, fontSize, fontName, bold })),
    };
  }).sort((a, b) => b.y - a.y || a.x - b.x);
};

const identifyRunningLines = (lines: BlueprintLine[], geometries: PageGeometry[]) => {
  const repeated = new Set<BlueprintLine>();
  if (geometries.length > 1) {
    for (const line of lines) {
      const normalized = normalizeRunningText(line.text);
      if (normalized.length < 2) continue;
      const isRepeated = lines.some((candidate) =>
        candidate.pageIndex !== line.pageIndex &&
        normalizeRunningText(candidate.text) === normalized &&
        Math.abs(candidate.y - line.y) <= 3,
      );
      if (isRepeated) repeated.add(line);
    }
  }
  const footer = new Map<number, BlueprintLine[]>();
  const header = new Map<number, BlueprintLine[]>();
  for (const line of lines) {
    const height = geometries[line.pageIndex].height;
    const inSinglePageFooter = geometries.length === 1 && line.y <= height * 0.08;
    if ((repeated.has(line) || inSinglePageFooter) && !isPageNumberLine(line)) {
      if (line.y <= height * 0.25 || inSinglePageFooter) {
        footer.set(line.pageIndex, [...(footer.get(line.pageIndex) || []), line]);
      } else if (line.y >= height * 0.75) {
        header.set(line.pageIndex, [...(header.get(line.pageIndex) || []), line]);
      }
    }
  }
  const excluded = new Set([...repeated, ...[...footer.values(), ...header.values()].flat()]);
  return { repeated, footer, header, excluded };
};

const getLineGaps = (lines: BlueprintLine[]) => {
  const gaps: number[] = [];
  const typicalFontHeight = median(lines.map((line) => line.fontSize), 11);
  const pages = new Set(lines.map((line) => line.pageIndex));
  for (const pageIndex of pages) {
    const pageLines = lines.filter((line) => line.pageIndex === pageIndex).sort((a, b) => b.y - a.y);
    for (let index = 1; index < pageLines.length; index += 1) {
      const gap = pageLines[index - 1].y - pageLines[index].y;
      if (gap > 0 && gap <= Math.max(30, typicalFontHeight * 3)) gaps.push(gap);
    }
  }
  return gaps;
};

const getNumberingStyle = (bodyLines: BlueprintLine[]): BlueprintPageStyle["numberingStyle"] => {
  const patterns: Array<[BlueprintPageStyle["numberingStyle"], RegExp]> = [
    ["Q1.", /^Q\s*\d+\./i],
    ["Q.1", /^Q\.\s*\d+/i],
    ["(1)", /^\(\d+\)/],
    ["1)", /^\d+\)/],
    ["1.", /^\d+\./],
  ];
  const counts = new Map<BlueprintPageStyle["numberingStyle"], number>();
  for (const line of bodyLines) {
    const found = patterns.find(([, pattern]) => pattern.test(line.text));
    if (found) counts.set(found[0], (counts.get(found[0]) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || "1.";
};

const detectMarksStyle = (bodyLines: BlueprintLine[]) => {
  const counts = { square: 0, round: 0, marks: 0 };
  for (const line of bodyLines) {
    if (/\[\s*\d+\s*\]\s*$/.test(line.text)) counts.square += 1;
    else if (/\(\s*\d+\s*marks?\s*\)\s*$|\(\s*\d+\s*\)\s*$/i.test(line.text)) counts.round += 1;
    else if (/\b\d+\s*marks?\s*$/i.test(line.text)) counts.marks += 1;
  }
  const total = counts.square + counts.round + counts.marks;
  if (total < 3) return { showMarksRight: false, marksStyle: "square" as const };
  const marksStyle = (Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || "square") as keyof typeof counts;
  return { showMarksRight: true, marksStyle };
};

const parseHeadingKey = (key: string) => {
  const normalized = key.toUpperCase();
  const roman: Record<string, string> = { I: "1", II: "2", III: "3", IV: "4", V: "5", VI: "6", VII: "7", VIII: "8", IX: "9", X: "10" };
  return roman[normalized] || normalized;
};

const isCentered = (line: BlueprintLine, pageWidth: number) =>
  Math.abs((line.x + line.xRight) / 2 - pageWidth / 2) <= pageWidth * 0.1;

const locateMarkers = (lines: BlueprintLine[]): Marker[] => {
  const markers: Marker[] = [];
  for (const line of lines) {
    markerPattern.lastIndex = 0;
    for (const match of line.text.matchAll(markerPattern)) {
      const text = match[0];
      const section = text.match(/section\s*([A-Za-z0-9]+)/i);
      const prefix = line.text.slice(0, match.index || 0);
      const factor = line.text.length > 0
        ? Math.max(line.fontSize * 0.35, (line.xRight - line.x) / line.text.length)
        : line.fontSize * 0.52;
      markers.push({
        pageIndex: line.pageIndex,
        x: line.x + prefix.length * factor,
        y: line.y,
        fontSize: line.fontSize,
        width: text.length * factor + line.fontSize * 0.8,
        height: line.fontSize * 1.5,
        key: section ? parseHeadingKey(section[1]) : null,
      });
    }
  }
  return markers.sort((a, b) => a.pageIndex - b.pageIndex || b.y - a.y);
};

const findHeadingCandidates = (
  bodyLines: BlueprintLine[],
  geometries: PageGeometry[],
  medianLineGap: number,
) => {
  const headings: HeadingCandidate[] = [];
  const byPage = new Map<number, BlueprintLine[]>();
  for (const line of bodyLines) byPage.set(line.pageIndex, [...(byPage.get(line.pageIndex) || []), line]);
  for (const [pageIndex, pageLines] of byPage) {
    const ordered = [...pageLines].sort((a, b) => b.y - a.y);
    let inInstructions = false;
    for (let index = 0; index < ordered.length; index += 1) {
      const line = ordered[index];
      if (/^general\s+instructions?\b|^instructions?\b/i.test(line.text)) {
        inInstructions = true;
        continue;
      }
      const next = ordered[index + 1];
      const directHeadingMatch = line.text.match(headingPattern);
      const directQuestionMatch = line.text.match(questionRangePattern);
      const mergedText = !directHeadingMatch && !directQuestionMatch && next && line.y - next.y <= medianLineGap * 1.8 && line.text.length < 30
        ? `${line.text} ${next.text}`
        : line.text;
      const headingMatch = directHeadingMatch || mergedText.match(headingPattern);
      const questionMatch = directQuestionMatch || mergedText.match(questionRangePattern);
      if (!headingMatch && !questionMatch) continue;
      const pageWidth = geometries[pageIndex].width;
      const hasExtraSpace = index === 0 || ordered[index - 1].y - line.y > medianLineGap * 1.5;
      const isStandalone = line.text.length < 60 &&
        (line.bold || isCentered(line, pageWidth) || hasExtraSpace);
      if (!isStandalone || /\.$/.test(mergedText) || /question\s+number/i.test(mergedText)) continue;
      if (inInstructions) {
        inInstructions = false;
        if (!(line.bold || isCentered(line, pageWidth) || hasExtraSpace)) continue;
      }
      const key = headingMatch?.[2] || questionMatch?.[1] || questionMatch?.[2] || null;
      const label = headingMatch ? `${headingMatch[1]} ${headingMatch[2]}` : mergedText;
      headings.push({ line, key: key ? parseHeadingKey(key) : null, label });
    }
  }
  return headings.sort((a, b) => a.line.pageIndex - b.line.pageIndex || b.line.y - a.line.y);
};

const buildHeadingStyles = (
  candidates: HeadingCandidate[],
  lines: BlueprintLine[],
  geometries: PageGeometry[],
  medianLineGap: number,
): BlueprintHeading[] => candidates.map((candidate) => {
  const pageLines = lines
    .filter((line) => line.pageIndex === candidate.line.pageIndex)
    .sort((a, b) => b.y - a.y);
  const index = pageLines.indexOf(candidate.line);
  const previous = pageLines[index - 1];
  const measuredGapAbove = previous
    ? Math.max(0, previous.y - candidate.line.y - previous.fontSize * 1.3)
    : 14;
  const gapAbove = Math.min(measuredGapAbove, Math.max(14, medianLineGap * 1.5));
  const instructionLines: BlueprintInstructionLine[] = [];
  let prior = candidate.line;
  for (let nextIndex = index + 1; nextIndex < pageLines.length; nextIndex += 1) {
    const line = pageLines[nextIndex];
    if (
      candidates.some((heading) => heading.line === line) ||
      numberStartPattern.test(line.text)
    ) break;
    const baselineGap = prior.y - line.y;
    if (baselineGap > medianLineGap * 1.8) break;
    instructionLines.push({
      text: line.text,
      fontSize: line.fontSize,
      bold: line.bold,
      x: line.x,
      gap: instructionLines.length === 0 ? 0 : Math.max(0, baselineGap - prior.fontSize * 1.3),
    });
    prior = line;
  }
  const gapBelowHeading = instructionLines.length
    ? Math.max(0, candidate.line.y - (pageLines[index + 1].y + pageLines[index + 1].fontSize * 0.8))
    : 6;
  const pageWidth = geometries[candidate.line.pageIndex].width;
  const centered = Math.abs((candidate.line.x + candidate.line.xRight) / 2 - pageWidth / 2) < 15;
  // Keep the blueprint's own heading wording (e.g. "Section – A") so the output matches it.
  const ownText = candidate.line.text.trim();
  return {
    text: headingPattern.test(ownText) && ownText.length < 40 ? ownText : candidate.label,
    key: candidate.key,
    fontSize: candidate.line.fontSize,
    bold: candidate.line.bold,
    align: centered ? "center" : "left",
    x: candidate.line.x,
    gapAbove,
    gapBelowHeading: Math.max(0, gapBelowHeading),
    instructions: instructionLines,
  };
});

function isPageNumberText(value: string): boolean {
  const text = value.trim();
  return /^(?:page\s*)?[-–—]?\s*\d+\s*(?:(?:of|\/)\s*\d+)?\s*[-–—]?$/i.test(text);
}

function isPageNumberLine(line: BlueprintLine): boolean {
  return isPageNumberText(line.text) || /\bpage\s*\d+\s*(?:of|\/)\s*\d+\b/i.test(line.text);
}

const headerFieldPatterns: Record<BlueprintHeaderField["kind"], { label: RegExp; value: RegExp }> = {
  marks: {
    label: /(max(?:imum)?\.?\s*marks?|total\s*marks?)\s*[:=-]?\s*/i,
    value: /\d+/,
  },
  time: {
    label: /(time(?:\s*allowed)?|duration)\s*[:=-]?\s*/i,
    value: /(\d+(?:\.\d+)?\s*½?|½)\s*(hours?|hrs?\.?|minutes?|mins?\.?)/i,
  },
};

// Reads "1½ hours" / "90 minutes" / "2 hrs" as minutes.
export const parseDurationMinutes = (text: string) => {
  const match = text.match(headerFieldPatterns.time.value);
  if (!match) return NaN;
  const amount = match[1].replace(/\s+/g, "");
  const number = (Number(amount.replace("½", "")) || 0) + (amount.includes("½") ? 0.5 : 0);
  return /^h/i.test(match[2]) ? Math.round(number * 60) : Math.round(number);
};

const findHeaderFields = (headerLines: BlueprintLine[]): BlueprintHeaderField[] => {
  const fields: BlueprintHeaderField[] = [];
  for (const kind of ["marks", "time"] as const) {
    const { label, value } = headerFieldPatterns[kind];
    const whole = new RegExp(`${label.source}${value.source}`, "i");
    const labelOnly = new RegExp(`${label.source}$`, "i");
    search: for (const line of headerLines) {
      const parts = line.parts?.length ? line.parts : [line];
      for (let index = 0; index < parts.length; index += 1) {
        const part = parts[index];
        const next = parts[index + 1];
        // Either "Max Marks: 40" in one text item, or "Max Marks:" followed by a separate "40".
        const valuePart = labelOnly.test(part.text) && next && new RegExp(`^\\s*${value.source}\\s*$`, "i").test(next.text) ? next : null;
        if (!whole.test(part.text) && !valuePart) continue;
        const target = valuePart || part;
        const parsed = kind === "marks" ? Number(target.text.match(/(\d+)(?!.*\d)/)?.[1]) : parseDurationMinutes(target.text);
        fields.push({
          kind,
          pageIndex: line.pageIndex,
          text: target.text,
          value: parsed,
          x: target.x,
          xRight: target.xRight,
          y: line.y,
          fontSize: target.fontSize,
          fontName: target.fontName,
          bold: target.bold,
        });
        break search;
      }
    }
  }
  return fields;
};

const pageNumberPattern = (text: string): BlueprintPageNumber["pattern"] => {
  if (/^page\s/i.test(text)) return "page-of";
  if (/\bof\b/i.test(text)) return "of";
  if (/\//.test(text)) return "slash";
  if (/^\s*[-–—].*[-–—]\s*$/.test(text)) return "wrapped";
  return "number";
};

const getPageNumberAlignment = (
  line: BlueprintLine,
  pageWidth: number,
): BlueprintPageNumber["align"] => {
  const lineCenter = (line.x + line.xRight) / 2;
  if (Math.abs(lineCenter - pageWidth / 2) < 15) return "center";
  return lineCenter < pageWidth / 2 ? "left" : "right";
};

const detectColoredBackground = async (page: pdfjsLib.PDFPageProxy): Promise<boolean> => {
  const viewport = page.getViewport({ scale: 0.15 });
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.ceil(viewport.width));
  canvas.height = Math.max(1, Math.ceil(viewport.height));
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return false;
  await page.render({ canvas, canvasContext: context, viewport }).promise;
  const points = [
    [0.12, 0.12], [0.5, 0.12], [0.88, 0.12],
    [0.12, 0.5], [0.88, 0.5],
    [0.12, 0.88], [0.5, 0.88], [0.88, 0.88],
  ];
  let colored = 0;
  for (const [xRatio, yRatio] of points) {
    const x = Math.min(canvas.width - 1, Math.round(canvas.width * xRatio));
    const y = Math.min(canvas.height - 1, Math.round(canvas.height * yRatio));
    const pixel = context.getImageData(x, y, 1, 1).data;
    if (pixel[0] < 242 || pixel[1] < 242 || pixel[2] < 242) colored += 1;
  }
  return colored >= 5;
};

const createSlices = (
  startPage: number,
  startY: number,
  endPage: number,
  endY: number,
  styles: BlueprintPageStyle[],
): BlueprintSlice[] => {
  const slices: BlueprintSlice[] = [];
  for (let pageIndex = startPage; pageIndex <= endPage; pageIndex += 1) {
    const pageStyle = styles[pageIndex];
    if (!pageStyle) continue;
    const sliceStart = pageIndex === startPage ? startY : pageStyle.safeTop;
    const sliceEnd = pageIndex === endPage ? endY : pageStyle.safeBottom;
    if (sliceStart > sliceEnd + 2) slices.push({ pageIndex, startY: sliceStart, endY: sliceEnd });
  }
  return slices;
};

const collectMarkerRegions = (markers: Marker[], styles: BlueprintPageStyle[]): BlueprintRegion[] =>
  markers.map((marker, index) => {
    const next = markers[index + 1];
    const endPage = next?.pageIndex ?? styles.length - 1;
    const endY = next?.y + (next?.fontSize || 0) || styles[endPage]?.safeBottom || 0;
    const label = marker.key ? `Section ${marker.key}` : `Section ${String.fromCharCode(65 + index)}`;
    return {
      label,
      key: marker.key,
      source: "marker" as const,
      marker: { pageIndex: marker.pageIndex, x: marker.x, y: marker.y - marker.height * 0.2, width: marker.width, height: marker.height * 1.2 },
      slices: createSlices(
        marker.pageIndex,
        marker.y - marker.height - 10,
        endPage,
        endY,
        styles,
      ),
    };
  });

const collectHeadingRegions = (
  headings: HeadingCandidate[],
  bodyLines: BlueprintLine[],
  styles: BlueprintPageStyle[],
  medianLineGap: number,
): BlueprintRegion[] => headings.map((heading, index) => {
  const pageLines = bodyLines.filter((line) => line.pageIndex === heading.line.pageIndex).sort((a, b) => b.y - a.y);
  const headingIndex = pageLines.indexOf(heading.line);
  let lastInstructionLine = heading.line;
  for (let lineIndex = headingIndex + 1; lineIndex < pageLines.length; lineIndex += 1) {
    const line = pageLines[lineIndex];
    const gap = lastInstructionLine.y - line.y;
    if (gap > medianLineGap * 1.8 || numberStartPattern.test(line.text)) break;
    lastInstructionLine = line;
  }
  const startY = lastInstructionLine.y - lastInstructionLine.fontSize * 0.8 - 10;
  const next = headings[index + 1];
  const endPage = next?.line.pageIndex ?? styles.length - 1;
  const endY = next
    ? next.line.y + next.line.fontSize + 10
    : styles[endPage]?.safeBottom || 0;
  return {
    label: heading.label,
    key: heading.key,
    source: "heading",
    slices: createSlices(heading.line.pageIndex, startY, endPage, endY, styles),
  };
});

export const analyzeBlueprintBytes = async (input: Uint8Array | ArrayBuffer): Promise<BlueprintAnalysis> => {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const pdf = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
  const geometries: PageGeometry[] = [];
  const pageHasColoredBackground: boolean[] = [];
  const lines: BlueprintLine[] = [];
  for (let pageIndex = 0; pageIndex < pdf.numPages; pageIndex += 1) {
    const page = await pdf.getPage(pageIndex + 1);
    const viewport = page.getViewport({ scale: 1 });
    // pdfjs and pdf-lib share a bottom-left origin with y increasing upward; keep y unchanged.
    geometries.push({ width: viewport.width, height: viewport.height });
    const content = await page.getTextContent();
    await page.getOperatorList();
    const realFontNames = new Map<string, string>();
    for (const item of content.items as Array<{ fontName?: string }>) {
      if (!item.fontName || realFontNames.has(item.fontName)) continue;
      try {
        const font = page.commonObjs.get(item.fontName) as { name?: string; loadedName?: string };
        const name = font.name || font.loadedName || item.fontName;
        realFontNames.set(item.fontName, name.replace(/^[A-Z]{6}\+/, ""));
      } catch {
        realFontNames.set(item.fontName, item.fontName.replace(/^[A-Z]{6}\+/, ""));
      }
    }
    pageHasColoredBackground.push(await detectColoredBackground(page));
    lines.push(...lineItemsToModel(
      pageIndex,
      content.items as Array<{ str?: string; transform?: number[]; width?: number; fontName?: string }>,
      content.styles,
      realFontNames,
    ));
  }
  if (lines.length === 0) {
    throw new BlueprintAnalysisError("This PDF looks scanned (no selectable text). Please upload a text-based PDF.");
  }

  const warnings: string[] = [];
  const running = identifyRunningLines(lines, geometries);
  const pageNumberLines = new Set(lines.filter((line) =>
    isPageNumberLine(line) && (running.footer.has(line.pageIndex) || line.y <= geometries[line.pageIndex].height * 0.2),
  ));
  const bodyLines = lines.filter((line) => !running.excluded.has(line) && !pageNumberLines.has(line));
  // A footer that shares its line with the page number (e.g. "CLASS X ... Page 1 of 4") counts as found.
  if (!running.footer.size && !running.header.size && pageNumberLines.size === 0)
    warnings.push("Running headers or footers could not be detected; page-based margins were used.");
  const gaps = getLineGaps(bodyLines);
  const medianLineGap = median(gaps, 1.5 * median(bodyLines.map((line) => line.fontSize), 11));
  const headingCandidates = findHeadingCandidates(bodyLines, geometries, medianLineGap);
  const markers = locateMarkers(bodyLines);
  let tier: BlueprintAnalysis["tier"] = markers.length ? 1 : headingCandidates.length ? 2 : 3;
  let candidates = headingCandidates;
  if (markers.length) {
    candidates = markers.map((marker, index) => {
      const line = bodyLines.find((candidate) => candidate.pageIndex === marker.pageIndex && Math.abs(candidate.y - marker.y) < 1);
      return {
        line: line || {
          text: marker.key ? `Section ${marker.key}` : `Section ${String.fromCharCode(65 + index)}`,
          x: marker.x,
          xRight: marker.x + marker.width,
          y: marker.y,
          fontSize: marker.fontSize,
          fontFamily: "Liberation Sans",
          fontName: "Liberation Sans",
          bold: false,
          pageIndex: marker.pageIndex,
        },
        key: marker.key,
        label: marker.key ? `Section ${marker.key}` : `Section ${String.fromCharCode(65 + index)}`,
      };
    });
  }
  const headings = buildHeadingStyles(candidates, bodyLines, geometries, medianLineGap);
  const firstHeading = headings[0];
  const firstHeadingLine = firstHeading && candidates[0]?.line;
  const headerBottomY = firstHeading && firstHeadingLine
    ? firstHeadingLine.y + firstHeading.fontSize + firstHeading.gapAbove
    : geometries[0].height - 50;
  const firstPageBody = bodyLines.filter((line) => line.pageIndex === 0 && line.y < headerBottomY);
  const headingLineSet = new Set(candidates.map((candidate) => candidate.line));
  const bodyStyleLines = firstPageBody.filter((line) => !headingLineSet.has(line));
  const styleLines = bodyStyleLines.length ? bodyStyleLines : firstPageBody;
  const bodyFontSize = Math.max(9, Math.min(13, median(styleLines.map((line) => line.fontSize), 11)));
  if (firstPageBody.length === 0) warnings.push("No page-one body text could be isolated; default font size was used.");
  const fontFamily = mostCommon(styleLines.map((line) => line.fontName), "Liberation Sans");
  const paperFont = mapPaperFont(fontFamily);
  const centeredLine = (line: BlueprintLine) => Math.abs((line.x + line.xRight) / 2 - geometries[0].width / 2) < 15;
  const leftCandidates = styleLines.filter((line) => !centeredLine(line) && line.x <= geometries[0].width * 0.35);
  let leftMargin = median(leftCandidates.map((line) => line.x), 42);
  const rightEdge = percentile(styleLines.map((line) => line.xRight), 0.9, geometries[0].width - 42);
  let rightMargin = geometries[0].width - rightEdge;
  if (geometries[0].width - leftMargin - rightMargin < geometries[0].width * 0.7) {
    leftMargin = 42;
    rightMargin = 42;
  }
  const pageNumbers = geometries.map((geometry, pageIndex) => {
    const line = [...lines]
      .filter((candidate) => candidate.pageIndex === pageIndex && isPageNumberLine(candidate))
      .sort((a, b) => a.y - b.y)[0];
    if (!line) return null;
    // A footer such as "CLASS X SCIENCE ... Page 1 of 4" shares one line; use only the page-number item.
    const part = line.parts?.find((candidate) => isPageNumberText(candidate.text));
    const source = part ? { ...line, ...part } : line;
    return {
      sampleText: source.text,
      fontName: source.fontName,
      x: source.x,
      y: line.y,
      width: source.xRight - source.x,
      height: source.fontSize * 1.2,
      align: getPageNumberAlignment(source, geometry.width),
      fontSize: source.fontSize,
      bold: source.bold,
      pattern: pageNumberPattern(source.text),
    } satisfies BlueprintPageNumber;
  });
  const generalInstructionsText = lines
    .filter((line) => line.pageIndex === 0 && line.y + line.fontSize * 0.8 >= headerBottomY && !pageNumberLines.has(line))
    .sort((a, b) => b.y - a.y)
    .map((line) => line.text)
    .join(" ");
  const pageBodyStarts = geometries.map((geometry, pageIndex) => {
    if (pageIndex === 0) return headerBottomY;
    const body = bodyLines.filter((line) => line.pageIndex === pageIndex);
    return body.length
      ? Math.max(...body.map((line) => line.y + line.fontSize))
      : geometry.height - 50;
  });
  const numberingStyle = getNumberingStyle(bodyLines);
  const marks = detectMarksStyle(bodyLines);
  const pageStyles = geometries.map((geometry, pageIndex) => {
    const footerLines = running.footer.get(pageIndex) || [];
    const headerLines = running.header.get(pageIndex) || [];
    const footerTop = footerLines.length ? Math.max(...footerLines.map((line) => line.y + line.fontSize)) : geometry.height * 0.08;
    const headerBottom = headerLines.length ? Math.min(...headerLines.map((line) => line.y)) : geometry.height * 0.94;
    return {
      pageIndex,
      pageWidth: geometry.width,
      pageHeight: geometry.height,
      bodyFontSize,
      fontFamily,
      leftMargin,
      rightMargin,
      lineHeight: bodyFontSize * 1.3,
      questionGap: bodyFontSize * 0.4,
      numberingStyle,
      ...marks,
      footerTop,
      headerBottom,
      safeTop: headerBottom - 12,
      safeBottom: footerTop + 12,
    };
  });

  let regions: BlueprintRegion[] = [];
  if (markers.length > 0) {
    regions = collectMarkerRegions(markers, pageStyles);
  } else {
    const headings = findHeadingCandidates(bodyLines, geometries, medianLineGap);
    if (headings.length > 0) {
      tier = 2;
      regions = collectHeadingRegions(headings, bodyLines, pageStyles, medianLineGap);
    } else {
      tier = 3;
      warnings.push("No section headings found in the blueprint, so sections were added at the end.");
      const lastPage = Math.max(0, ...bodyLines.map((line) => line.pageIndex));
      const lastBodyLine = bodyLines.filter((line) => line.pageIndex === lastPage).sort((a, b) => a.y - b.y)[0];
      let pageIndex = lastPage;
      let startY = lastBodyLine ? lastBodyLine.y - pageStyles[lastPage].lineHeight - 10 : pageStyles[lastPage].safeTop;
      if (!lastBodyLine || startY - pageStyles[lastPage].safeBottom < 60) {
        pageIndex = Math.min(lastPage + 1, pageStyles.length - 1);
        if (pageIndex === lastPage) pageIndex = pageStyles.length;
        startY = pageStyles[Math.min(pageIndex, pageStyles.length - 1)].safeTop;
      }
      regions = [{
        label: "Questions",
        key: null,
        source: "fallback",
        slices: [{ pageIndex, startY, endY: pageStyles[Math.min(pageIndex, pageStyles.length - 1)].safeBottom }],
      }];
    }
  }
  if (regions.length === 0 && tier !== 3) {
    warnings.push("Detected section locations had no usable writing space; questions will continue on added pages.");
    tier = 3;
    const lastPage = pageStyles.length - 1;
    regions = [{
      label: "Questions",
      key: null,
      source: "fallback",
      slices: [{ pageIndex: lastPage + 1, startY: pageStyles[lastPage].pageHeight * 0.94, endY: pageStyles[lastPage].safeBottom }],
    }];
  }
  if (pageHasColoredBackground.some(Boolean)) warnings.push("A colored page background was detected; white body masks may be visible.");
  const giLine = lines.find((line) => line.pageIndex === 0 && /^general\s+instructions?\b|^instructions?\b/i.test(line.text));
  const generalInstructionsY = giLine ? giLine.y : undefined;
  const headerLines = lines.filter((line) => line.pageIndex === 0 && line.y + line.fontSize * 0.8 >= (generalInstructionsY ?? headerBottomY));
  const headerFields = findHeaderFields(headerLines.filter((line) => generalInstructionsY === undefined || line.y > generalInstructionsY));
  return {
    lines,
    bodyLines,
    pageStyles,
    regions,
    headings,
    headerBottomY,
    generalInstructionsY,
    pageBodyStarts,
    leftMargin,
    rightMargin,
    bodyFontSize,
    paperFont,
    pageNumbers,
    pageNumberLines,
    footerLines: new Set([...running.footer.values()].flat()),
    runningHeaderLines: new Set([...running.header.values()].flat()),
    headerLines,
    headerFields,
    hasColoredBackground: pageHasColoredBackground.some(Boolean),
    generalInstructionsText,
    tier,
    warnings,
  };
};

export const analyzeBlueprint = async (file: File) =>
  analyzeBlueprintBytes(await file.arrayBuffer());
