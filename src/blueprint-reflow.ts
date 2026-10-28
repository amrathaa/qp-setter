import fontkit from "@pdf-lib/fontkit";
import {
  PDFDocument,
  StandardFonts,
  rgb,
  type PDFFont,
  type PDFPage,
} from "pdf-lib";
import { mapPaperFont } from "./blueprint";
import type {
  BlueprintAnalysis,
  BlueprintFillResult,
  BlueprintHeaderField,
  BlueprintHeading,
  BlueprintInstructionLine,
  BlueprintPageNumber,
  BlueprintPageStyle,
  BlueprintReportRow,
  GeneratedQuestion,
  GeneratedSection,
} from "./blueprint";
import {
  cleanBrokenKerningWords,
  generatePatternGeneralInstructions,
  toRomanNumeral,
} from "./text-cleaner";

type PaperFonts = { regular: PDFFont; bold: PDFFont; hasGlyph: (codePoint: number) => boolean };
type FontAsset = { regular: string; bold: string };
type PlannedSegment = { text: string; xOffset: number; bold: boolean; align?: "left" | "center" | "right" };
type PlannedLine = { segments: PlannedSegment[]; fontSize: number; section: string };
type PagePlanLine = PlannedLine & { y: number };
type PagePlan = { sourcePageIndex: number; startY: number; cursorY: number; lines: PagePlanLine[]; report: BlueprintReportRow[] };

const fontAssets: Record<BlueprintAnalysis["paperFont"], FontAsset> = {
  carlito: { regular: "/fonts/LiberationSans-Regular.ttf", bold: "/fonts/LiberationSans-Bold.ttf" },
  liberationSans: { regular: "/fonts/LiberationSans-Regular.ttf", bold: "/fonts/LiberationSans-Bold.ttf" },
  liberationSerif: { regular: "/fonts/LiberationSerif-Regular.ttf", bold: "/fonts/LiberationSerif-Bold.ttf" },
};

const textReplacements: Record<string, string> = {
  "°": " deg", "²": "^2", "³": "^3", "¹": "^1", "₀": "0", "₁": "1", "₂": "2", "₃": "3",
  "μ": "mu", "µ": "u", "π": "pi", "θ": "theta", "α": "alpha", "β": "beta", "γ": "gamma", "Δ": "Delta", "δ": "delta",
  "λ": "lambda", "Ω": "Ohm", "ω": "omega", "×": "x", "÷": "/", "≤": "<=", "≥": ">=", "≠": "!=", "≈": "~",
  "−": "-", "–": "-", "—": "-", "→": "->", "←": "<-", "↔": "<->", "•": "-", "…": "...", "√": "sqrt", "∞": "infinity",
  "′": "'", "″": '"', "∠": "angle", "∑": "sum", "∫": "integral", "∝": "proportional to",
};

const fontFor = (fonts: PaperFonts, bold: boolean) => bold ? fonts.bold : fonts.regular;

const sanitizeText = (text: string, font: PDFFont, warnings: string[], hasGlyph: (codePoint: number) => boolean) => {
  let changed = false;
  const output = [...text].map((character) => {
    try {
      if (!hasGlyph(character.codePointAt(0) || 0)) throw new Error("Missing glyph.");
      font.encodeText(character);
      return character;
    } catch {
      changed = true;
      return textReplacements[character] || "?";
    }
  }).join("");
  if (changed && !warnings.includes("Some characters unsupported by the selected font were replaced with ASCII equivalents.")) {
    warnings.push("Some characters unsupported by the selected font were replaced with ASCII equivalents.");
  }
  return output;
};

const embedPaperFonts = async (
  document: PDFDocument,
  family: BlueprintAnalysis["paperFont"],
  warnings: string[],
): Promise<PaperFonts> => {
  document.registerFontkit(fontkit);
  const assets = fontAssets[family];
  try {
    const [regularResponse, boldResponse] = await Promise.all([
      fetch(assets.regular),
      fetch(assets.bold),
    ]);
    if (!regularResponse.ok || !boldResponse.ok) throw new Error("Font files are unavailable.");
    const [regularBytes, boldBytes] = await Promise.all([
      regularResponse.arrayBuffer(),
      boldResponse.arrayBuffer(),
    ]);
    const glyphFont = fontkit.create(new Uint8Array(regularBytes)) as unknown as { hasGlyphForCodePoint: (codePoint: number) => boolean };
    const regular = await document.embedFont(new Uint8Array(regularBytes), { subset: false });
    const bold = await document.embedFont(new Uint8Array(boldBytes), { subset: false });
    try {
      (regular as unknown as { embedder: { fontFeatures?: Record<string, boolean> } }).embedder.fontFeatures = {
        liga: false,
        dlig: false,
        rlig: false,
        calt: false,
      };
      (bold as unknown as { embedder: { fontFeatures?: Record<string, boolean> } }).embedder.fontFeatures = {
        liga: false,
        dlig: false,
        rlig: false,
        calt: false,
      };
    } catch {
      // ignore
    }
    return {
      regular,
      bold,
      hasGlyph: (codePoint) => glyphFont.hasGlyphForCodePoint(codePoint),
    };
  } catch {
    warnings.push("The blueprint font could not be embedded; Helvetica was used instead.");
    return {
      regular: await document.embedFont(StandardFonts.Helvetica),
      bold: await document.embedFont(StandardFonts.HelveticaBold),
      hasGlyph: () => true,
    };
  }
};

const getNumberPrefix = (style: BlueprintPageStyle["numberingStyle"], number: number) => {
  if (style === "1)") return `${number})`;
  if (style === "Q1.") return `Q${number}.`;
  if (style === "Q.1") return `Q.${number}`;
  if (style === "(1)") return `(${number})`;
  return `${number}.`;
};

const cleanQuestionText = (text: string) =>
  text.replace(/^\s*(?:Q\s*\.?\s*\d+\.?|Q\.\s*\d+|\(\d+\)|\d+[.)])\s*/, "").trim();

const wrapText = (text: string, font: PDFFont, size: number, width: number) => {
  const lines: string[] = [];
  const appendWord = (word: string, current: string) => {
    const candidate = current ? `${current} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= width || !current) return { lines, current: candidate };
    lines.push(current);
    if (font.widthOfTextAtSize(word, size) <= width) return { lines, current: word };
    let fragment = "";
    for (const character of word) {
      if (fragment && font.widthOfTextAtSize(fragment + character, size) > width) {
        lines.push(fragment);
        fragment = character;
      } else fragment += character;
    }
    return { lines, current: fragment };
  };
  let current = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const result = appendWord(word, current);
    current = result.current;
  }
  if (current) lines.push(current);
  return lines.length ? lines : [""];
};

const rewriteQuestionRange = (text: string, first: number, last: number) => {
  if (!/question|\bq\s*\.?\s*no/i.test(text)) return text;
  const rangePattern = /\b\d+(\s*(?:to|[-–—])\s*)\d+\b/i;
  if (rangePattern.test(text)) {
    return text.replace(rangePattern, (_match, separator: string) =>
      first === last ? `${first}` : `${first}${separator}${last}`);
  }
  // Single question reference, e.g. "Q. No. 19 is case based question."
  return text.replace(/(\bq\s*\.?\s*no\.?\s*|\bquestion\s*(?:number|no\.?)\s*)(\d+)\b/i, (_match, label: string) =>
    first === last ? `${label}${first}` : `${label}${first} to ${last}`);
};

const nextHeadingLabel = (heading: BlueprintHeading) => {
  const match = heading.text.match(/\b([A-Za-z0-9]+)\b(?=\s*$)/);
  if (!match) return heading.text;
  const raw = match[1];
  const romanValues: Record<string, number> = { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7, VIII: 8, IX: 9, X: 10 };
  const romanNext: Record<number, string> = { 1: "II", 2: "III", 3: "IV", 4: "V", 5: "VI", 6: "VII", 7: "VIII", 8: "IX", 9: "X" };
  const upper = raw.toUpperCase();
  let next: string;
  if (romanValues[upper]) next = romanNext[romanValues[upper]] || String(romanValues[upper] + 1);
  else if (/^\d+$/.test(raw)) next = String(Number(raw) + 1);
  else if (/^[A-Z]$/.test(raw)) next = String.fromCharCode(raw.charCodeAt(0) + 1);
  else if (/^[a-z]$/.test(raw)) next = String.fromCharCode(raw.charCodeAt(0) + 1);
  else next = String.fromCharCode(65 + 1);
  return `${heading.text.slice(0, match.index)}${next}`;
};

const makeHeadingStyle = (analysis: BlueprintAnalysis, index: number): BlueprintHeading => {
  const existing = analysis.headings[index];
  if (existing) {
    const cleanedText = cleanBrokenKerningWords(existing.text).replace(/^secti\s*on\s*/i, "Section ");
    return {
      ...existing,
      text: cleanedText,
    };
  }
  const previous = analysis.headings[analysis.headings.length - 1];
  if (previous) {
    let generated = previous;
    for (let extraIndex = analysis.headings.length; extraIndex <= index; extraIndex += 1) {
      const text = cleanBrokenKerningWords(nextHeadingLabel(generated)).replace(/^secti\s*on\s*/i, "Section ");
      const key = text.match(/\b([A-Za-z0-9]+)\s*$/)?.[1] || null;
      generated = { ...generated, text, key, instructions: generated.instructions.map((instruction) => ({ ...instruction })) };
    }
    return generated;
  }
  return {
    text: `Section ${String.fromCharCode(65 + index)}`,
    key: null,
    fontSize: analysis.bodyFontSize + 1,
    bold: true,
    align: "center",
    x: analysis.leftMargin,
    gapAbove: 14,
    gapBelowHeading: 6,
    instructions: [],
  };
};

// The paper always follows the pattern; this only points out sections where the blueprint expected other marks.
const notePatternMarksDifferences = (
  analysis: BlueprintAnalysis,
  sections: GeneratedSection[],
  warnings: string[],
) => {
  const text = analysis.generalInstructionsText;
  sections.forEach((section, index) => {
    const marks = section.questions[0]?.marks;
    const key = makeHeadingStyle(analysis, index).text.match(/([A-Za-z0-9]+)\s*$/)?.[1];
    if (!marks || !key) return;
    const blocks = text.matchAll(new RegExp(`section\\s*[-–—]?\\s*${key}\\b([^]*?)(?=section\\s*[-–—]?\\s*[A-Z0-9]\\b|$)`, "gi"));
    for (const block of blocks) {
      const stated = block[1].match(/carrying\s+(\d+)\s*marks?/i);
      if (!stated) continue;
      if (Number(stated[1]) !== marks) {
        warnings.push(`Your blueprint's Section ${key} is set up for ${stated[1]}-mark questions, but your pattern gives ${marks} marks each. The paper follows your pattern; change it in Step 2 if you meant to match the blueprint.`);
      }
      break;
    }
  });
};

const makeQuestionLines = (
  question: GeneratedQuestion,
  number: number,
  section: string,
  width: number,
  analysis: BlueprintAnalysis,
  fonts: PaperFonts,
  warnings: string[],
): PlannedLine[] => {
  const output: PlannedLine[] = [];
  const size = analysis.bodyFontSize;
  const regular = fonts.regular;
  const prefix = sanitizeText(`${getNumberPrefix(analysis.pageStyles[0].numberingStyle, number)} `, regular, warnings, fonts.hasGlyph);
  const prefixWidth = regular.widthOfTextAtSize(prefix, size) + size * 0.45;
  const stem = sanitizeText(cleanBrokenKerningWords(cleanQuestionText(question.text)), regular, warnings, fonts.hasGlyph);
  const stemLines = wrapText(stem, regular, size, Math.max(24, width - prefixWidth));
  stemLines.forEach((line, index) => {
    const segments: PlannedSegment[] = [];
    if (index === 0) segments.push({ text: prefix, xOffset: 0, bold: false });
    segments.push({ text: line, xOffset: prefixWidth, bold: false });
    output.push({ segments, fontSize: size, section });
  });

  const appendOptions = (options: string[]) => {
    if (!options.length) return;
    const cleanOpts = options.map((opt) => cleanBrokenKerningWords(opt));
    const short = cleanOpts.every((option) => option.length < 35);
    if (short) {
      // Two columns, both indented under the question text like the long-option layout.
      const columnWidth = (width - prefixWidth) / 2;
      const wrapped = cleanOpts.map((option) => wrapText(sanitizeText(option, regular, warnings, fonts.hasGlyph), regular, size, Math.max(24, columnWidth - 24)));
      for (let index = 0; index < wrapped.length; index += 2) {
        const rows = Math.max(wrapped[index].length, wrapped[index + 1]?.length || 0);
        for (let row = 0; row < rows; row += 1) {
          const segments: PlannedSegment[] = [];
          for (const optionIndex of [index, index + 1]) {
            const line = wrapped[optionIndex]?.[row];
            if (line === undefined) continue;
            const labelOffset = prefixWidth + (optionIndex % 2) * columnWidth;
            if (row === 0) segments.push({ text: `${String.fromCharCode(97 + optionIndex)})`, xOffset: labelOffset, bold: false });
            segments.push({ text: line, xOffset: labelOffset + 20, bold: false });
          }
          output.push({ segments, fontSize: size, section });
        }
      }
    } else {
      cleanOpts.forEach((option, index) => {
        const lines = wrapText(sanitizeText(option, regular, warnings, fonts.hasGlyph), regular, size, Math.max(24, width - prefixWidth - 22));
        lines.forEach((line, lineIndex) => {
          const segments: PlannedSegment[] = [];
          if (lineIndex === 0) segments.push({ text: `${String.fromCharCode(97 + index)})`, xOffset: prefixWidth, bold: false });
          segments.push({ text: line, xOffset: prefixWidth + 20, bold: false });
          output.push({ segments, fontSize: size, section });
        });
      });
    }
  };
  appendOptions(question.options || []);
  const rawAlt = typeof question.alternative === "string" ? question.alternative : question.alternative?.text;
  const alternativeText = rawAlt ? cleanBrokenKerningWords(rawAlt) : undefined;
  const alternativeOptions = typeof question.alternative === "string" ? [] : question.alternative?.options || [];
  if (alternativeText) {
    output.push({ segments: [{ text: "OR", xOffset: 0, bold: true, align: "center" }], fontSize: size, section });
    const lines = wrapText(sanitizeText(alternativeText, regular, warnings, fonts.hasGlyph), regular, size, Math.max(24, width - prefixWidth));
    lines.forEach((line) => output.push({ segments: [{ text: line, xOffset: prefixWidth, bold: false }], fontSize: size, section }));
    appendOptions(alternativeOptions);
  }
  if (analysis.pageStyles[0].showMarksRight && question.marks !== undefined && output.length) {
    const marks = analysis.pageStyles[0].marksStyle === "round"
      ? `(${question.marks})`
      : analysis.pageStyles[0].marksStyle === "marks"
        ? `${question.marks} Marks`
        : `[${question.marks}]`;
    output[0].segments.push({ text: sanitizeText(marks, regular, warnings, fonts.hasGlyph), xOffset: width, bold: false, align: "right" });
  }
  return output;
};

const instructionTextFor = (
  heading: BlueprintHeading,
  section: GeneratedSection,
  firstQuestionNumber: number,
  analysis: BlueprintAnalysis,
): BlueprintInstructionLine[] => {
  const lastQuestionNumber = firstQuestionNumber + section.questions.length - 1;
  if (heading.instructions.length) {
    return heading.instructions.map((instruction) => ({
      ...instruction,
      text: cleanBrokenKerningWords(rewriteQuestionRange(instruction.text, firstQuestionNumber, lastQuestionNumber)),
    }));
  }
  const marks = section.questions[0]?.marks ?? 1;
  return [{
    text: `${section.questions.length} questions of ${marks} mark${marks === 1 ? "" : "s"} each`,
    fontSize: analysis.bodyFontSize,
    bold: false,
    x: analysis.leftMargin,
    gap: 0,
  }];
};

const instructionMarkerPattern = /^\s*(\(\s*[ivxlc]+\s*\)|[ivxlc]+[.)]|\(\s*\d+\s*\)|\d+[.)])\s+/i;

// Reads the blueprint's own General Instructions block so the regenerated list keeps its look.
const blueprintInstructionStyle = (analysis: BlueprintAnalysis) => {
  const giY = analysis.generalInstructionsY;
  const giLine = giY === undefined
    ? undefined
    : analysis.lines.find((line) => line.pageIndex === 0 && line.y === giY);
  const blockLines = giY === undefined
    ? []
    : analysis.lines
      .filter((line) => line.pageIndex === 0 && line.y < giY && line.y > analysis.headerBottomY)
      .sort((a, b) => b.y - a.y);
  const firstNumbered = blockLines.findIndex((line) => instructionMarkerPattern.test(line.text));
  const preamble = (firstNumbered === -1 ? [] : blockLines.slice(0, firstNumbered)).map((line) => cleanBrokenKerningWords(line.text));
  const numberedLines = blockLines.filter((line) => instructionMarkerPattern.test(line.text));
  const sample = numberedLines[0]?.text.match(instructionMarkerPattern)?.[1].replace(/\s+/g, "") || "(i)";
  const upper = /[IVX]/.test(sample);
  const marker = (index: number) => {
    const roman = upper ? toRomanNumeral(index).toUpperCase() : toRomanNumeral(index);
    if (/^\([ivxlc]+\)$/i.test(sample)) return `(${roman})`;
    if (/^[ivxlc]+[.)]$/i.test(sample)) return `${roman}${sample.slice(-1)}`;
    if (/^\(\d+\)$/.test(sample)) return `(${index})`;
    if (/^\d+[.)]$/.test(sample)) return `${index}${sample.slice(-1)}`;
    return `(${roman})`;
  };
  const bodySource = numberedLines.length ? numberedLines : blockLines;
  const sizes = bodySource.map((line) => line.fontSize).sort((a, b) => a - b);
  const bodySize = sizes.length ? sizes[Math.floor(sizes.length / 2)] : 8.5;
  return {
    headingText: giLine ? cleanBrokenKerningWords(giLine.text) : "General Instructions:",
    headingSize: giLine?.fontSize ?? 10,
    headingBold: giLine?.bold ?? true,
    headingOffset: giLine ? Math.max(0, giLine.x - analysis.leftMargin) : 0,
    bodySize,
    bodyOffset: bodySource[0] ? Math.max(0, bodySource[0].x - analysis.leftMargin) : 0,
    preamble: giLine ? preamble : ["Read the following instructions carefully and strictly follow them:"],
    marker,
  };
};

const addWarningOnce = (warnings: string[], warning: string) => {
  if (!warnings.includes(warning)) warnings.push(warning);
};

const addToPlan = (plan: PagePlan, line: PlannedLine) => {
  plan.lines.push({ ...line, y: plan.cursorY });
  plan.cursorY -= line.fontSize * 1.3;
};

const reflowPlans = (
  analysis: BlueprintAnalysis,
  sections: GeneratedSection[],
  fonts: PaperFonts,
  warnings: string[],
): PagePlan[] => {
  const sourcePageCount = analysis.pageStyles.length;
  const makePage = (index: number): PagePlan => {
    const sourcePageIndex = Math.min(index, sourcePageCount - 1);
    const pageStyle = analysis.pageStyles[sourcePageIndex];
    const startY = index === 0
      ? (analysis.generalInstructionsY ?? analysis.headerBottomY)
      : pageStyle.safeTop;
    return { sourcePageIndex, startY, cursorY: startY, lines: [], report: [] };
  };
  const fallbackSlice = analysis.tier === 3 ? analysis.regions[0]?.slices[0] : undefined;
  const firstFlowPage = fallbackSlice ? Math.min(fallbackSlice.pageIndex, sourcePageCount) : 0;
  const plans = Array.from({ length: firstFlowPage + 1 }, (_, index) => makePage(index));
  if (fallbackSlice) {
    plans[plans.length - 1].startY = fallbackSlice.startY;
    plans[plans.length - 1].cursorY = fallbackSlice.startY;
  }
  const current = () => plans[plans.length - 1];
  const pageStyle = () => analysis.pageStyles[current().sourcePageIndex];
  const nextPage = () => {
    plans.push(makePage(plans.length));
  };
  let nextQuestion = 1;

  // Render pattern-matching General Instructions on Page 1 if blueprint has instructions area
  if (analysis.generalInstructionsY || analysis.headerBottomY) {
    const p1 = plans[0];
    const giList = generatePatternGeneralInstructions(sections);
    const giWidth = analysis.pageStyles[0].pageWidth - analysis.leftMargin - analysis.rightMargin;
    const giStyle = blueprintInstructionStyle(analysis);

    addToPlan(p1, {
      segments: [{ text: giStyle.headingText, xOffset: giStyle.headingOffset, bold: giStyle.headingBold, align: "left" }],
      fontSize: giStyle.headingSize,
      section: "Header",
    });
    p1.cursorY -= 2;
    for (const preamble of giStyle.preamble) {
      for (const lineText of wrapText(preamble, fonts.regular, giStyle.bodySize, giWidth - giStyle.bodyOffset)) {
        addToPlan(p1, {
          segments: [{ text: lineText, xOffset: giStyle.bodyOffset, bold: false, align: "left" }],
          fontSize: giStyle.bodySize,
          section: "Header",
        });
      }
    }
    if (giStyle.preamble.length) p1.cursorY -= 2;

    for (let i = 0; i < giList.length; i += 1) {
      const fullText = `${giStyle.marker(i + 1)} ${giList[i]}`;
      const wrapped = wrapText(fullText, fonts.regular, giStyle.bodySize, giWidth - giStyle.bodyOffset);
      for (const lineText of wrapped) {
        addToPlan(p1, {
          segments: [{ text: lineText, xOffset: giStyle.bodyOffset, bold: false, align: "left" }],
          fontSize: giStyle.bodySize,
          section: "Header",
        });
      }
    }
    p1.cursorY -= 10;
  }

  for (let sectionIndex = 0; sectionIndex < sections.length; sectionIndex += 1) {
    const section = sections[sectionIndex];
    const heading = makeHeadingStyle(analysis, sectionIndex);
    const sectionLabel = heading.text;
    const width = pageStyle().pageWidth - analysis.leftMargin - analysis.rightMargin;
    const instructions = instructionTextFor(heading, section, nextQuestion, analysis);
    const questionLines = section.questions.length
      ? makeQuestionLines(section.questions[0], nextQuestion, sectionLabel, width, analysis, fonts, warnings)
      : [];
    const preludeHeight = heading.fontSize * 1.3 + heading.gapBelowHeading +
      instructions.reduce((sum, instruction) => sum + instruction.fontSize * 1.3 + instruction.gap, 0);
    const firstQuestionHeight = questionLines.reduce((sum, line) => sum + line.fontSize * 1.3, 0) + analysis.bodyFontSize * 0.4;
    const isPageTop = current().lines.length === 0;
    const gapAbove = isPageTop ? 0 : heading.gapAbove;
    if (current().cursorY - gapAbove - preludeHeight - firstQuestionHeight < pageStyle().footerTop + 12) {
      nextPage();
    }
    const finalGapAbove = current().lines.length === 0 ? 0 : gapAbove;
    current().cursorY -= finalGapAbove;
    const headingFontSize = heading.fontSize;
    const headingText = sanitizeText(sectionLabel, fontFor(fonts, heading.bold), warnings, fonts.hasGlyph);
    addToPlan(current(), {
      segments: [{ text: headingText, xOffset: heading.align === "left" ? 0 : 0, bold: heading.bold, align: heading.align }],
      fontSize: headingFontSize,
      section: sectionLabel,
    });
    current().cursorY -= heading.gapBelowHeading;
    if (instructions.length) {
      for (const instruction of instructions) {
        current().cursorY -= instruction.gap;
        addToPlan(current(), {
          segments: [{ text: instruction.text, xOffset: Math.max(0, instruction.x - analysis.leftMargin), bold: instruction.bold }],
          fontSize: instruction.fontSize,
          section: sectionLabel,
        });
      }
    }
    nextQuestion += section.questions.length;

    for (let questionIndex = 0; questionIndex < section.questions.length; questionIndex += 1) {
      const questionNumber = nextQuestion - section.questions.length + questionIndex;
      const groups = makeQuestionLines(
        section.questions[questionIndex],
        questionNumber,
        sectionLabel,
        pageStyle().pageWidth - analysis.leftMargin - analysis.rightMargin,
        analysis,
        fonts,
        warnings,
      );
      const height = groups.reduce((sum, line) => sum + line.fontSize * 1.3, 0) + analysis.bodyFontSize * 0.4;
      const pageCapacity = current().startY - (pageStyle().footerTop + 12);
      if (height <= pageCapacity && current().cursorY - height < pageStyle().footerTop + 12) nextPage();
      if (height > pageCapacity) {
        addWarningOnce(warnings, `${sectionLabel} contains a question taller than one page; it was split across pages.`);
      }
      const questionPages = new Map<number, { startY: number; endY: number }>();
      for (const line of groups) {
        if (current().cursorY - line.fontSize * 1.3 < pageStyle().footerTop + 12 && current().lines.length > 0) nextPage();
        const planPageIndex = plans.length - 1;
        const startY = current().cursorY;
        const pageEntry = questionPages.get(planPageIndex);
        if (pageEntry) pageEntry.endY = startY - line.fontSize * 1.3;
        else questionPages.set(planPageIndex, { startY, endY: startY - line.fontSize * 1.3 });
        addToPlan(current(), line);
      }
      current().cursorY -= analysis.bodyFontSize * 0.4;
      for (const [planPageIndex, pageEntry] of questionPages) {
        const row = plans[planPageIndex].report.find((candidate) => candidate.section === sectionLabel);
        if (row) {
          row.startY = Math.max(row.startY, pageEntry.startY);
          row.endY = Math.min(row.endY, pageEntry.endY);
          row.questionsDrawn += 1;
        } else {
          plans[planPageIndex].report.push({ section: sectionLabel, page: planPageIndex + 1, startY: pageEntry.startY, endY: pageEntry.endY, questionsDrawn: 1 });
        }
      }
    }
  }
  return plans;
};

const coverOldBody = (page: PDFPage, analysis: BlueprintAnalysis, outputPageIndex: number) => {
  const sourcePageIndex = Math.min(outputPageIndex, analysis.pageStyles.length - 1);
  const style = analysis.pageStyles[sourcePageIndex];
  const page0Cutoff = analysis.generalInstructionsY ? analysis.generalInstructionsY + 18 : analysis.headerBottomY + 4;
  const isKeptRunningLine = (line: BlueprintAnalysis["lines"][number]) =>
    analysis.footerLines.has(line) || !!analysis.runningHeaderLines?.has(line);
  const sourceLines = analysis.lines.filter((line) => line.pageIndex === sourcePageIndex);
  const footerTexts = sourceLines.filter((line) => analysis.footerLines.has(line) || analysis.pageNumberLines.has(line));
  const headerTexts = sourceLines.filter((line) => analysis.runningHeaderLines?.has(line));

  // 1. Wipe the entire body content area with a solid white rectangle when page background is standard white
  if (!analysis.hasColoredBackground) {
    // Stop just above the running footer's glyphs and just below the running header's descenders.
    const topLimit = outputPageIndex === 0
      ? page0Cutoff
      : headerTexts.length
        ? Math.min(...headerTexts.map((line) => line.y - line.fontSize * 0.3)) - 1
        : (style.headerBottom > 0 ? style.headerBottom : style.pageHeight - 20);
    const bottomLimit = footerTexts.length
      ? Math.max(...footerTexts.map((line) => line.y + line.fontSize)) + 1
      : style.footerTop > 0 ? style.footerTop : 20;

    if (topLimit > bottomLimit) {
      page.drawRectangle({
        x: 0,
        y: bottomLimit,
        width: style.pageWidth,
        height: topLimit - bottomLimit,
        color: rgb(1, 1, 1),
        borderWidth: 0,
      });
    }
  }

  // 2. Line-specific masking for precision coverage of detected body lines and descenders
  for (const line of sourceLines) {
    // Page numbers are masked precisely in step 3, so footer text sharing their line survives.
    if (analysis.pageNumberLines.has(line) || isKeptRunningLine(line)) continue;
    const shouldCover = sourcePageIndex === 0
      ? line.y + line.fontSize * 0.8 < page0Cutoff
      : true;
    if (!shouldCover) continue;
    const x = Math.max(0, line.x - 4);
    const y = Math.max(0, line.y - 4);
    const width = Math.min(style.pageWidth - x, Math.max(2, line.xRight - line.x) + 8);
    const height = Math.min(style.pageHeight - y, Math.max(line.fontSize, 4) + 8);
    page.drawRectangle({ x, y, width, height, color: rgb(1, 1, 1), borderWidth: 0 });
  }

  // 3. Explicitly mask the blueprint's original page number location
  const pageTemplate = analysis.pageNumbers[sourcePageIndex] || analysis.pageNumbers[0];
  if (pageTemplate) {
    const pX = Math.max(0, pageTemplate.x - 6);
    const pY = Math.max(0, pageTemplate.y - 6);
    const pWidth = Math.min(style.pageWidth - pX, pageTemplate.width + 12);
    const pHeight = Math.min(style.pageHeight - pY, Math.max(pageTemplate.height, pageTemplate.fontSize * 1.5) + 12);
    page.drawRectangle({ x: pX, y: pY, width: pWidth, height: pHeight, color: rgb(1, 1, 1), borderWidth: 0 });
  }
};

const drawPlannedLine = (
  page: PDFPage,
  line: PagePlanLine,
  pageStyle: BlueprintPageStyle,
  analysis: BlueprintAnalysis,
  fonts: PaperFonts,
  warnings: string[],
) => {
  for (const segment of line.segments) {
    const font = fontFor(fonts, segment.bold);
    const text = sanitizeText(segment.text, font, warnings, fonts.hasGlyph);
    const textWidth = font.widthOfTextAtSize(text, line.fontSize);
    const x = segment.align === "center"
      ? (pageStyle.pageWidth - textWidth) / 2
      : segment.align === "right"
        ? pageStyle.pageWidth - analysis.rightMargin - textWidth
        : analysis.leftMargin + segment.xOffset;
    page.drawText(text, { x: Math.max(0, Math.min(x, pageStyle.pageWidth - textWidth)), y: line.y - line.fontSize, size: line.fontSize, font, color: rgb(0, 0, 0) });
  }
};

// Header-field fonts follow the header's own typeface (often Calibri) rather than the body font.
const headerFieldFontAssets: Record<BlueprintAnalysis["paperFont"], FontAsset> = {
  ...fontAssets,
  carlito: { regular: "/fonts/Carlito-Regular.ttf", bold: "/fonts/Carlito-Bold.ttf" },
};

const embedHeaderFieldFont = async (document: PDFDocument, field: BlueprintHeaderField, fallback: PaperFonts) => {
  const asset = headerFieldFontAssets[mapPaperFont(field.fontName)];
  try {
    const response = await fetch(field.bold ? asset.bold : asset.regular);
    if (!response.ok) throw new Error("Font file is unavailable.");
    return await document.embedFont(new Uint8Array(await response.arrayBuffer()), { subset: false });
  } catch {
    return fontFor(fallback, field.bold);
  }
};

const redrawHeaderFields = async (
  document: PDFDocument,
  analysis: BlueprintAnalysis,
  sections: GeneratedSection[],
  fonts: PaperFonts,
  warnings: string[],
) => {
  const totalMarks = sections.reduce(
    (sum, section) => sum + section.questions.reduce((sectionSum, question) => sectionSum + (question.marks || 0), 0),
    0,
  );
  for (const field of analysis.headerFields) {
    if (field.kind !== "marks" || totalMarks <= 0 || field.value === totalMarks) continue;
    const page = document.getPage(field.pageIndex);
    const style = analysis.pageStyles[field.pageIndex];
    const font = await embedHeaderFieldFont(document, field, fonts);
    const text = sanitizeText(
      /^\s*\d+\s*$/.test(field.text)
        ? String(totalMarks)
        : field.text.replace(/(\d+)(?!.*\d)/, String(totalMarks)),
      font,
      warnings,
      () => true,
    );
    const textWidth = font.widthOfTextAtSize(text, field.fontSize);
    // Fields on the right of the header (e.g. "Max Marks: 40") stay flush with their right edge.
    const rightAligned = field.xRight > style.pageWidth * 0.6;
    const x = rightAligned ? field.xRight - textWidth : field.x;
    page.drawRectangle({
      x: Math.min(field.x, x) - 1,
      y: field.y - field.fontSize * 0.3,
      width: Math.max(field.xRight, x + textWidth) - Math.min(field.x, x) + 2,
      height: field.fontSize * 1.25,
      color: rgb(1, 1, 1),
      borderWidth: 0,
    });
    page.drawText(text, { x, y: field.y, size: field.fontSize, font, color: rgb(0, 0, 0) });
  }
};

const formatPageNumber = (template: BlueprintPageNumber, page: number, total: number) => {
  const pageWord = template.sampleText.match(/^\s*([A-Za-z]+)/)?.[1] || "Page";
  if (template.pattern === "page-of") return `${pageWord} ${page} of ${total}`;
  if (template.pattern === "of") return `${page} of ${total}`;
  if (template.pattern === "slash") return `${page}/${total}`;
  if (template.pattern === "wrapped") return `- ${page} -`;
  return `${page}`;
};

const drawPageNumbers = (
  document: PDFDocument,
  analysis: BlueprintAnalysis,
  fonts: PaperFonts,
  warnings: string[],
  totalPages: number,
) => {
  const template = analysis.pageNumbers.find((number): number is BlueprintPageNumber => number !== null);
  for (let pageIndex = 0; pageIndex < totalPages; pageIndex += 1) {
    const sourceIndex = Math.min(pageIndex, analysis.pageStyles.length - 1);
    const pageTemplate = analysis.pageNumbers[sourceIndex] || template;
    const style = analysis.pageStyles[sourceIndex];
    const numberTemplate: BlueprintPageNumber = pageTemplate || {
      sampleText: "Page 1 of 1", fontName: "", x: 0, y: style.footerTop,
      width: 0, height: analysis.bodyFontSize * 1.2, align: "right",
      fontSize: analysis.bodyFontSize, bold: false, pattern: "page-of",
    };
    const text = sanitizeText(formatPageNumber(numberTemplate, pageIndex + 1, totalPages), fontFor(fonts, numberTemplate.bold), warnings, fonts.hasGlyph);
    const font = fontFor(fonts, numberTemplate.bold);
    const textWidth = font.widthOfTextAtSize(text, numberTemplate.fontSize);
    const x = numberTemplate.align === "center"
      ? (style.pageWidth - textWidth) / 2
      : numberTemplate.align === "right"
        ? style.pageWidth - analysis.rightMargin - textWidth
        : analysis.leftMargin;
    document.getPage(pageIndex).drawText(text, { x, y: numberTemplate.y, size: numberTemplate.fontSize, font, color: rgb(0, 0, 0) });
  }
};

const drawDebug = (document: PDFDocument, plans: PagePlan[], analysis: BlueprintAnalysis) => {
  for (const [pageIndex, plan] of plans.entries()) {
    const style = analysis.pageStyles[plan.sourcePageIndex];
    const page = document.getPage(pageIndex);
    page.drawLine({ start: { x: analysis.leftMargin, y: style.footerTop }, end: { x: analysis.leftMargin, y: style.pageHeight }, color: rgb(1, 0, 0), thickness: 0.5 });
    page.drawLine({ start: { x: style.pageWidth - analysis.rightMargin, y: style.footerTop }, end: { x: style.pageWidth - analysis.rightMargin, y: style.pageHeight }, color: rgb(1, 0, 0), thickness: 0.5 });
    const labels = [...new Set(plan.lines.map((line) => line.section))];
    for (const label of labels) {
      const lines = plan.lines.filter((line) => line.section === label);
      if (!lines.length) continue;
      const top = Math.max(...lines.map((line) => line.y));
      const bottom = Math.min(...lines.map((line) => line.y - line.fontSize)) - analysis.bodyFontSize * 0.3;
      page.drawRectangle({ x: analysis.leftMargin, y: bottom, width: style.pageWidth - analysis.leftMargin - analysis.rightMargin, height: top - bottom, borderColor: rgb(1, 0, 0), borderWidth: 0.5 });
    }
  }
};

export const fillBlueprintPdf = async (
  input: Uint8Array | ArrayBuffer,
  analysis: BlueprintAnalysis,
  generatedSections: GeneratedSection[],
  debug = false,
): Promise<BlueprintFillResult> => {
  const sourceBytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const warnings = [...analysis.warnings];
  try {
    const sourceDocument = await PDFDocument.load(sourceBytes);
    const document = await PDFDocument.load(sourceBytes);
    const fonts = await embedPaperFonts(document, analysis.paperFont, warnings);
    notePatternMarksDifferences(analysis, generatedSections, warnings);
    const plans = reflowPlans(analysis, generatedSections, fonts, warnings);
    const finalPageCount = Math.max(1, plans.length);
    while (document.getPageCount() > finalPageCount) document.removePage(document.getPageCount() - 1);
    while (document.getPageCount() < finalPageCount) {
      const [lastPage] = await document.copyPages(sourceDocument, [sourceDocument.getPageCount() - 1]);
      document.addPage(lastPage);
    }
    for (let pageIndex = 0; pageIndex < finalPageCount; pageIndex += 1) {
      coverOldBody(document.getPage(pageIndex), analysis, pageIndex);
    }
    for (const [pageIndex, plan] of plans.entries()) {
      const style = analysis.pageStyles[plan.sourcePageIndex];
      const page = document.getPage(pageIndex);
      for (const line of plan.lines) drawPlannedLine(page, line, style, analysis, fonts, warnings);
    }
    await redrawHeaderFields(document, analysis, generatedSections, fonts, warnings);
    drawPageNumbers(document, analysis, fonts, warnings, finalPageCount);
    if (debug) drawDebug(document, plans, analysis);
    const report = plans.flatMap((plan, pageIndex) => plan.report.map((row) => ({ ...row, page: pageIndex + 1 })));
    return { bytes: await document.save(), warnings, report };
  } catch {
    addWarningOnce(warnings, "We couldn't reflow this blueprint safely. The original PDF was left unchanged.");
    return { bytes: sourceBytes, warnings, report: [] };
  }
};