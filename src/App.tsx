import { useState } from "react";
import * as mammoth from "mammoth/mammoth.browser";
import * as pdfjsLib from "pdfjs-dist";
import { jsPDF } from "jspdf";
import { PDFDocument, StandardFonts, rgb, type PDFFont } from "pdf-lib";
import JSZip from "jszip";
import "./App.css";

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url,
).toString();

const steps = [
  { number: "01", label: "Textbook", detail: "Add your source" },
  { number: "02", label: "Pattern", detail: "Set the blueprint" },
  { number: "03", label: "Design", detail: "Match your institution" },
  { number: "04", label: "Difficulty", detail: "Tune the challenge" },
];
type PaperFont = "helvetica" | "times" | "courier";
type StyledLine = { text: string; bold: boolean };
type StyledText = { text: string; bold: boolean };
type PaperTheme = {
  titleFont: PaperFont;
  titleSize: number;
  headingFont: PaperFont;
  headingSize: number;
  bodyFont: PaperFont;
  bodySize: number;
  lineSpacingMm: number;
  sectionSpacingMm: number;
  borderStyle: "none" | "single" | "double";
  borderColor: string;
  logoDataUrl: string | null;
  marginMm: number;
};
const DEFAULT_THEME: PaperTheme = {
  titleFont: "helvetica",
  titleSize: 16,
  headingFont: "helvetica",
  headingSize: 11,
  bodyFont: "helvetica",
  bodySize: 10,
  lineSpacingMm: 5,
  sectionSpacingMm: 6,
  borderStyle: "none",
  borderColor: "#26312f",
  logoDataUrl: null,
  marginMm: 20,
};
type PaperTemplate = {
  logos: string[];
  schoolName: StyledText;
  examTitle: StyledText;
  className: string;
  subjectName: string;
  maxMarksLabel: string;
  generalInstructionsHeading: StyledText;
  generalInstructions: StyledText[];
  sections: Array<{ label: StyledText; instructions: StyledText }>;
};
const EMPTY_TEMPLATE: PaperTemplate = {
  logos: [],
  schoolName: { text: "", bold: false },
  examTitle: { text: "", bold: false },
  className: "",
  subjectName: "",
  maxMarksLabel: "Max Marks",
  generalInstructionsHeading: { text: "", bold: false },
  generalInstructions: [],
  sections: [],
};
const sectionPattern = /^(section|part)\s*[-–—]?\s*([A-Za-z0-9]+)\b[-:.]?\s*(.*)$/i;
const extractPaperTemplate = (lines: StyledLine[]): Partial<PaperTemplate> => {
  // These heuristics follow common Indian school question-paper conventions and may need adjustment per template; they are not a guaranteed-perfect parser.
  const result: Partial<PaperTemplate> = {};
  try {
    const nonEmptyLines = lines.filter((line) => line.text);
    if (nonEmptyLines[0]) result.schoolName = { text: nonEmptyLines[0].text, bold: nonEmptyLines[0].bold };
    const examLine = nonEmptyLines[1];
    if (examLine && !(/class\s*:/i.test(examLine.text) && /subject\s*:/i.test(examLine.text))) result.examTitle = { text: examLine.text, bold: examLine.bold };
    const combinedLine = lines.find((line) => /class\s*:/i.test(line.text) && /subject\s*:/i.test(line.text));
    if (combinedLine) {
      const classMatch = combinedLine.text.match(/class\s*:\s*([^:]+?)(?=\s*(?:subject\s*:|max\s*marks|$))/i);
      const subjectMatch = combinedLine.text.match(/subject\s*:\s*([^:]+?)(?=\s*(?:max\s*marks|$))/i);
      result.className = classMatch?.[1].trim() || "";
      result.subjectName = subjectMatch?.[1].trim() || "";
      const marksMatch = combinedLine.text.match(/(max\s*marks)\s*:?/i);
      result.maxMarksLabel = marksMatch ? marksMatch[1].replace(/\b\w/g, (letter) => letter.toUpperCase()) : "Max Marks";
    }
    const instructionIndex = lines.findIndex((line) => /general instructions/i.test(line.text));
    if (instructionIndex >= 0) result.generalInstructionsHeading = lines[instructionIndex];
    if (instructionIndex >= 0) {
      const instructionLines = lines.slice(instructionIndex + 1, instructionIndex + 11);
      const collected: StyledText[] = [];
      for (const line of instructionLines) {
        if (sectionPattern.test(line.text)) break;
        const match = line.text.match(/^\(?([ivxlc]+)\)\s*(.+)/i) || line.text.match(/^\d+[.)]\s+(.+)/);
        if (match) collected.push({ text: match[match.length - 1].trim(), bold: line.bold });
      }
      result.generalInstructions = collected;
    }
    result.sections = [];
    lines.forEach((line, index) => {
      const match = line.text.match(sectionPattern);
      if (!match) return;
      let instructions = match[3].trim();
      let bold = line.bold;
      const instructionLines: string[] = instructions ? [instructions] : [];
      for (const nextLine of lines.slice(index + 1, index + 3)) {
        if (!nextLine.text || /^\d+[.)]/.test(nextLine.text) || sectionPattern.test(nextLine.text)) break;
        instructionLines.push(nextLine.text);
        bold = bold || nextLine.bold;
      }
      result.sections?.push({ label: { text: `${match[1][0].toUpperCase()}${match[1].slice(1).toLowerCase()} ${match[2]}`, bold: line.bold }, instructions: { text: instructionLines.join(" "), bold } });
    });
  } catch {
    return result;
  }
  return result;
};
const mapFont = (name: string): PaperFont =>
  /times|serif|georgia/i.test(name)
    ? "times"
    : /courier|mono/i.test(name)
      ? "courier"
      : "helvetica";
const extractThemeFromDocx = async (
  file: File,
): Promise<Partial<PaperTheme>> => {
  try {
    const zip = await JSZip.loadAsync(await file.arrayBuffer());
    const theme: Partial<PaperTheme> = {};
    const stylesXml = await zip.file("word/styles.xml")?.async("text");
    if (stylesXml) {
      const styles = new DOMParser().parseFromString(
        stylesXml,
        "application/xml",
      );
      const getStyle = (styleId: string) =>
        [...styles.getElementsByTagNameNS("*", "style")].find(
          (style) => style.getAttribute("styleId") === styleId || style.getAttribute("w:styleId") === styleId,
        ) || null;
      const titleStyle = getStyle("Title");
      const normalStyle = getStyle("Normal");
      const readFont = (style: Element | null) => {
        const font = style ? [...style.getElementsByTagNameNS("*", "rFonts")][0] : null;
        return font?.getAttribute("ascii") || font?.getAttribute("w:ascii") || font?.getAttribute("hAnsi") || font?.getAttribute("w:hAnsi");
      };
      const readSize = (style: Element | null) => {
        const size = style ? [...style.getElementsByTagNameNS("*", "sz")][0] : null;
        const value = size?.getAttribute("val") || size?.getAttribute("w:val");
        return value ? Number(value) / 2 : undefined;
      };
      const titleFont = readFont(titleStyle);
      const bodyFont = readFont(normalStyle);
      const titleSize = readSize(titleStyle);
      const bodySize = readSize(normalStyle);
      if (titleFont) theme.titleFont = mapFont(titleFont);
      if (bodyFont) theme.bodyFont = mapFont(bodyFont);
      if (titleSize) theme.titleSize = titleSize;
      if (bodySize) theme.bodySize = bodySize;
    }
    const documentXml = await zip.file("word/document.xml")?.async("text");
    if (documentXml) {
      const document = new DOMParser().parseFromString(
        documentXml,
        "application/xml",
      );
      const border = [...document.getElementsByTagNameNS("*", "pBdr")]
        .flatMap((item) => [...item.children])
        .find((item) => ["top", "bottom", "left", "right"].includes(item.localName));
      if (border) {
        theme.borderStyle = "single";
        const color = border.getAttribute("color") || border.getAttribute("w:color");
        if (color && /^[0-9a-f]{6}$/i.test(color))
          theme.borderColor = `#${color}`;
      }
    }
    const media = Object.keys(zip.files).find((path) =>
      /^word\/media\/[^/]+\.(png|jpe?g|gif)$/i.test(path),
    );
    if (media) {
      const entry = zip.file(media);
      if (entry) {
        const data = await entry.async("base64");
        const extension = media.split(".").pop()?.toLowerCase();
        theme.logoDataUrl = `data:image/${extension === "jpg" ? "jpeg" : extension};base64,${data}`;
      }
    }
    return theme;
  } catch {
    return {};
  }
};
const extractThemeFromPdf = async (
  file: File,
): Promise<Partial<PaperTheme>> => {
  try {
    const document = await pdfjsLib.getDocument({
      data: new Uint8Array(await file.arrayBuffer()),
    }).promise;
    const page = await document.getPage(1);
    const content = await page.getTextContent();
    const sizes = (content.items as Array<{ transform?: number[] }>)
      .map((item) => Math.abs(item.transform?.[0] || item.transform?.[3] || 0))
      .filter((size) => size > 0);
    if (sizes.length === 0) return {};
    const counts = new Map<number, number>();
    sizes.forEach((size) =>
      counts.set(
        Math.round(size * 10) / 10,
        (counts.get(Math.round(size * 10) / 10) || 0) + 1,
      ),
    );
    const bodySize = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const titleSize = Math.max(...sizes);
    // PDF logo extraction is out of scope here; embedded images require pdfjs operator-list processing.
    return { titleSize, bodySize };
  } catch {
    return {};
  }
};
const extractPdfLines = async (file: File): Promise<StyledLine[]> => {
  try {
    const document = await pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
    const lines: StyledLine[] = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const grouped = new Map<number, Array<{ x: number; text: string; bold: boolean }>>();
      for (const item of content.items as Array<{ str?: string; transform?: number[]; fontName?: string }>) {
        const text = (item.str || "").trim();
        if (!text) continue;
        const y = item.transform?.[5] || 0;
        const key = [...grouped.keys()].find((candidate) => Math.abs(candidate - y) <= 2) ?? y;
        const style = item.fontName ? content.styles[item.fontName] : undefined;
        const bold = /bold/i.test(style?.fontFamily || "");
        const row = grouped.get(key) || [];
        row.push({ x: item.transform?.[4] || 0, text, bold });
        grouped.set(key, row);
      }
      [...grouped.entries()].sort((a, b) => b[0] - a[0]).forEach(([, items]) => {
        items.sort((a, b) => a.x - b.x);
        const text = items.map((item) => item.text).join(" ").replace(/\s+/g, " ").trim();
        const totalCharacters = items.reduce((total, item) => total + item.text.length, 0);
        // PDF font metadata is inconsistent; majority-of-characters boldness is only a best-effort heuristic.
        const boldCharacters = items.filter((item) => item.bold).reduce((total, item) => total + item.text.length, 0);
        if (text) lines.push({ text, bold: boldCharacters > totalCharacters / 2 });
      });
    }
    return lines;
  } catch {
    return [];
  }
};
const extractDocxLines = async (file: File): Promise<StyledLine[]> => {
  try {
    const zip = await JSZip.loadAsync(await file.arrayBuffer());
    const xml = await zip.file("word/document.xml")?.async("text");
    if (!xml) return [];
    const document = new DOMParser().parseFromString(xml, "application/xml");
    return [...document.getElementsByTagNameNS("*", "p")].map((paragraph) => {
      const runs = [...paragraph.getElementsByTagNameNS("*", "r")].map((run) => {
        const text = [...run.getElementsByTagNameNS("*", "t")].map((node) => node.textContent || "").join("");
        const properties = [...run.getElementsByTagNameNS("*", "rPr")][0];
        const boldNode = properties && [...properties.getElementsByTagNameNS("*", "b")][0];
        const bold = Boolean(boldNode) && !["false", "0", "off"].includes(boldNode.getAttribute("val") || boldNode.getAttribute("w:val") || "true");
        return { text, bold };
      });
      const text = runs.map((run) => run.text).join("").replace(/\s+/g, " ").trim();
      const characters = runs.reduce((total, run) => total + run.text.length, 0);
      const boldCharacters = runs.filter((run) => run.bold).reduce((total, run) => total + run.text.length, 0);
      return { text, bold: characters > 0 && boldCharacters > characters / 2 };
    }).filter((line) => line.text);
  } catch {
    return [];
  }
};
const extractPdfLogos = async (file: File): Promise<string[]> => {
  try {
    const pdfDocument = await pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
    const page = await pdfDocument.getPage(1);
    const operatorList = await page.getOperatorList();
    const firstTextIndex = operatorList.fnArray.findIndex((fn) => fn === pdfjsLib.OPS.showText);
    const imageNames = operatorList.fnArray.map((fn, index) => fn === pdfjsLib.OPS.paintImageXObject && (firstTextIndex < 0 || index < firstTextIndex) ? operatorList.argsArray[index]?.[0] as string : null).filter((name): name is string => Boolean(name));
    const pageObjects = (page as unknown as { objs: { get: (name: string) => unknown } }).objs;
    const logos: string[] = [];
    for (const imageName of imageNames) {
      const image = pageObjects.get(imageName) as { width: number; height: number; data: Uint8Array; kind: number } | undefined;
      if (!image?.width || !image.height || !image.data) continue;
      const canvas = window.document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext("2d");
      if (!context) continue;
      const rgba = new Uint8ClampedArray(image.width * image.height * 4);
      for (let source = 0, target = 0; target < rgba.length; target += 4) {
        if (image.kind === pdfjsLib.ImageKind.RGBA_32BPP) { rgba.set(image.data.slice(source, source + 4), target); source += 4; }
        else if (image.kind !== pdfjsLib.ImageKind.RGB_24BPP) { rgba[target] = rgba[target + 1] = rgba[target + 2] = image.data[source++]; rgba[target + 3] = 255; }
        else { rgba[target] = image.data[source++]; rgba[target + 1] = image.data[source++]; rgba[target + 2] = image.data[source++]; rgba[target + 3] = 255; }
      }
      context.putImageData(new ImageData(rgba, image.width, image.height), 0, 0);
      logos.push(canvas.toDataURL("image/png"));
    }
    return logos;
  } catch {
    return [];
  }
};
const extractDocxLogo = async (file: File): Promise<string[]> => {
  if (!file.name.toLowerCase().endsWith(".docx")) return [];
  try {
    const zip = await JSZip.loadAsync(await file.arrayBuffer());
    const media = Object.keys(zip.files).filter((path) => /^word\/media\/[^/]+\.(png|jpe?g|gif)$/i.test(path)).slice(0, 2);
    return Promise.all(media.map(async (path) => {
      const data = await zip.file(path)!.async("base64");
      const extension = path.split(".").pop()?.toLowerCase();
      return `data:image/${extension === "jpg" ? "jpeg" : extension};base64,${data}`;
    }));
  } catch {
    return [];
  }
};

type BlueprintSection = {
  label: string;
  pageIndex: number;
  startY: number;
  endY: number;
};

type FooterAnchor = {
  pageIndex: number;
  x: number;
  y: number;
  fontSize: number;
};

type BlueprintLayout = {
  pageWidth: number;
  pageHeight: number;
  sections: BlueprintSection[];
  footerAnchors: FooterAnchor[];
  bodyFontSizeMedian: number;
};

type BlueprintPreviewPage = {
  pageIndex: number;
  src: string;
  boxes: Array<{ label: string; left: number; top: number; width: number; height: number }>;
};

const detectBlueprintLayout = async (file: File): Promise<BlueprintLayout> => {
  // This is intentionally heuristic because messy scans or inconsistent spacing can shift text lines significantly.
  try {
    const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
    const linesByPage: Array<Array<{ pageIndex: number; text: string; x: number; y: number; fontSize: number }>> = [];
    const footerAnchors: FooterAnchor[] = [];
    const sections: BlueprintSection[] = [];

    for (let pageIndex = 0; pageIndex < pdf.numPages; pageIndex += 1) {
      const page = await pdf.getPage(pageIndex + 1);
      const viewport = page.getViewport({ scale: 1 });
      const textContent = await page.getTextContent();
      const grouped = new Map<number, Array<{ x: number; text: string; fontSize: number }>>();

      for (const item of textContent.items as Array<{ str?: string; transform?: number[]; fontSize?: number }>) {
        const text = (item.str || "").trim();
        if (!text) continue;
        const y = item.transform?.[5] ?? 0;
        const key = [...grouped.keys()].find((candidate) => Math.abs(candidate - y) <= 2) ?? y;
        const fontSize = Number(item.fontSize || item.transform?.[0] || 10);
        const row = grouped.get(key) || [];
        row.push({ x: item.transform?.[4] || 0, text, fontSize });
        grouped.set(key, row);
      }

      const pageLines = [...grouped.entries()]
        .sort((a, b) => b[0] - a[0])
        .map(([, items]) => {
          items.sort((a, b) => a.x - b.x);
          const text = items.map((item) => item.text).join(" ").replace(/\s+/g, " ").trim();
          const fontSize = items.reduce((total, item) => total + item.fontSize, 0) / Math.max(items.length, 1);
          return { pageIndex, text, x: items[0]?.x || 0, y: items[0] ? Number(items[0].x) : 0, fontSize };
        })
        .filter((line) => line.text.length > 0);

      linesByPage.push(
        pageLines.map((line) => ({
          pageIndex,
          text: line.text,
          x: line.x,
          y: line.y,
          fontSize: line.fontSize,
        })),
      );

      const pageFooterCandidates = pageLines.filter((line) => /page/i.test(line.text) || /\d+\s*of\s*\d+/i.test(line.text));
      const footerLine = pageFooterCandidates.sort((a, b) => a.y - b.y)[0];
      if (footerLine) {
        footerAnchors.push({
          pageIndex,
          x: footerLine.x,
          y: footerLine.y,
          fontSize: footerLine.fontSize,
        });
      }

      const bodySizes = pageLines
        .filter((line) => !/^(section|part)\s*[-–—]?\s*[A-Za-z0-9]+/i.test(line.text))
        .map((line) => line.fontSize)
        .filter((fontSize) => fontSize > 0)
        .sort((a, b) => a - b);
      const medianBodyFontSize = bodySizes[Math.floor(bodySizes.length / 2)] || 10;

      const headingLines = pageLines.filter((line) => /^(section|part)\s*[-–—]?\s*[A-Za-z0-9]+/i.test(line.text));
      headingLines.forEach((heading, index) => {
        const nextHeading = headingLines[index + 1];
        const footerForPage = footerAnchors.find((anchor) => anchor.pageIndex === pageIndex);
        const endY = nextHeading
          ? nextHeading.y - nextHeading.fontSize * 0.6
          : footerForPage
            ? footerForPage.y - 40
            : viewport.height - 56;
        const startY = heading.y - heading.fontSize * 0.6;
        const normalizedStart = Math.min(startY, endY);
        const normalizedEnd = Math.max(startY, endY);
        if (normalizedEnd - normalizedStart > 8) {
          sections.push({
            label: heading.text.replace(/\s+/g, " ").trim(),
            pageIndex,
            startY: normalizedStart,
            endY: normalizedEnd,
          });
        }
      });
      if (sections.length === 0 && medianBodyFontSize > 0) {
        const fallbackEndY = footerLine ? footerLine.y - 42 : viewport.height - 56;
        sections.push({ label: `Section ${pageIndex + 1}`, pageIndex, startY: 80, endY: fallbackEndY });
      }
    }

    const allFontSizes = linesByPage.flat().map((line) => line.fontSize).filter((fontSize) => fontSize > 0).sort((a, b) => a - b);
    const page0 = await pdf.getPage(1);
    const viewport = page0.getViewport({ scale: 1 });

    return {
      pageWidth: viewport.width,
      pageHeight: viewport.height,
      sections,
      footerAnchors,
      bodyFontSizeMedian: allFontSizes[Math.floor(allFontSizes.length / 2)] || 12,
    };
  } catch {
    return {
      pageWidth: 595,
      pageHeight: 842,
      sections: [],
      footerAnchors: [],
      bodyFontSizeMedian: 12,
    };
  }
};

const renderBlueprintPreview = async (file: File, layout: BlueprintLayout): Promise<BlueprintPreviewPage[]> => {
  const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const previewPages: BlueprintPreviewPage[] = [];

  for (let pageIndex = 0; pageIndex < Math.min(pdf.numPages, 2); pageIndex += 1) {
    const page = await pdf.getPage(pageIndex + 1);
    const viewport = page.getViewport({ scale: 1.2 });
    const canvas = document.createElement("canvas");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const context = canvas.getContext("2d");
    if (!context) continue;
    await page.render({ canvas, canvasContext: context, viewport }).promise;

    const boxes = layout.sections
      .filter((section) => section.pageIndex === pageIndex)
      .map((section) => {
        const yMin = Math.min(section.startY, section.endY);
        const yMax = Math.max(section.startY, section.endY);
        const leftPercent = 0;
        const top = ((layout.pageHeight - yMax) / layout.pageHeight) * canvas.height;
        const height = ((yMax - yMin) / layout.pageHeight) * canvas.height;
        const width = (layout.pageWidth / layout.pageWidth) * canvas.width;

        return {
          label: section.label,
          left: leftPercent,
          top,
          width,
          height,
        };
      });

    previewPages.push({
      pageIndex,
      src: canvas.toDataURL("image/png"),
      boxes,
    });
  }

  return previewPages;
};

const clampQuestionLines = (text: string, maxChars = 90) => {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [text];
  const chunks: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= maxChars) {
      current = candidate;
    } else {
      if (current) chunks.push(current);
      current = word;
    }
  }
  if (current) chunks.push(current);
  return chunks.length > 0 ? chunks : [text];
};

const fillBlueprintPdf = async (
  file: File,
  layout: BlueprintLayout,
  generatedSections: Array<{ label: string; questions: Array<{ text: string; marks: number }> }>,
): Promise<Uint8Array> => {
  const pdfDoc = await PDFDocument.load(await file.arrayBuffer());
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const pageHeight = layout.pageHeight;
  const pageWidth = layout.pageWidth;
  const contentFontSize = layout.bodyFontSizeMedian || 11;
  const addContinuationPage = () => pdfDoc.addPage([pageWidth, pageHeight]);

  for (const generatedSection of generatedSections) {
    const matchingLayoutSection = layout.sections.find((section) => section.label.toLowerCase() === generatedSection.label.toLowerCase());
    if (!matchingLayoutSection) continue;

    const freeStartY = matchingLayoutSection.startY;
    const freeEndY = matchingLayoutSection.endY;
    const page = pdfDoc.getPage(Math.min(matchingLayoutSection.pageIndex, pdfDoc.getPageCount() - 1));

    let currentY = freeStartY + 8;
    if (currentY > freeEndY - 6) {
      addContinuationPage();
      currentY = pageHeight - 56;
    }

    for (const question of generatedSection.questions) {
      const wrapped = clampQuestionLines(question.text, 90);
      const block = [question.text, ...wrapped.slice(1)];

      for (const line of block) {
        const lineHeight = contentFontSize * 1.4;
        if (currentY < freeEndY - 8) {
          page.drawText(line, {
            x: 52,
            y: currentY,
            size: contentFontSize,
            font,
            color: rgb(0, 0, 0),
          });
          currentY -= lineHeight;
        } else {
          addContinuationPage();
          currentY = pageHeight - 56;
          page.drawText(line, {
            x: 52,
            y: currentY,
            size: contentFontSize,
            font,
            color: rgb(0, 0, 0),
          });
          currentY -= lineHeight;
        }
      }
    }
  }

  return pdfDoc.save();
};

const renumberPages = async (
  pdfDoc: PDFDocument,
  layout: BlueprintLayout,
  font: PDFFont,
) => {
  const totalPages = pdfDoc.getPageCount();
  for (let pageIndex = 0; pageIndex < totalPages; pageIndex += 1) {
    const page = pdfDoc.getPage(pageIndex);
    const anchor = layout.footerAnchors.find((footer) => footer.pageIndex === pageIndex);
    if (anchor) {
      const coverWidth = anchor.fontSize * 6;
      const coverHeight = anchor.fontSize * 1.5;
      page.drawRectangle({
        x: anchor.x - 8,
        y: anchor.y - 6,
        width: coverWidth,
        height: coverHeight,
        color: rgb(1, 1, 1),
      });
      page.drawText(`Page ${pageIndex + 1} of ${totalPages}`, {
        x: anchor.x,
        y: anchor.y,
        size: anchor.fontSize,
        font,
        color: rgb(0, 0, 0),
      });
    } else {
      const pageText = `Page ${pageIndex + 1} of ${totalPages}`;
      const textWidth = font.widthOfTextAtSize(pageText, layout.bodyFontSizeMedian || 11);
      const x = (page.getWidth() - textWidth) / 2;
      const y = 30;
      page.drawText(pageText, {
        x,
        y,
        size: layout.bodyFontSizeMedian || 11,
        font,
        color: rgb(0, 0, 0),
      });
    }
  }
};

function App() {
  const [activeStep, setActiveStep] = useState(0);
  const [patternMode, setPatternMode] = useState<"manual" | "upload">("manual");
  const [selectedTopics, setSelectedTopics] = useState<string[]>([]);
  const [extractedTopics, setExtractedTopics] = useState<string[]>([]);
  const [generated, setGenerated] = useState(false);
  const [fileName, setFileName] = useState("");
  const [fileCount, setFileCount] = useState(0);
  const [textbookFiles, setTextbookFiles] = useState<File[]>([]);
  const [designFileName, setDesignFileName] = useState("");
  const [designFiles, setDesignFiles] = useState<File[]>([]);
  const [blueprintLayout, setBlueprintLayout] = useState<BlueprintLayout | null>(null);
  const [blueprintPreview, setBlueprintPreview] = useState<BlueprintPreviewPage[]>([]);
  const [paperTheme, setPaperTheme] = useState<PaperTheme>(DEFAULT_THEME);
  const [paperTemplate, setPaperTemplate] = useState<PaperTemplate>(EMPTY_TEMPLATE);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const [textbookText, setTextbookText] = useState("");
  const [difficulty, setDifficulty] = useState("Moderate");
  const [activeNav, setActiveNav] = useState("New paper");
  const [patternSections, setPatternSections] = useState([
    { count: 10, marks: 1 },
    { count: 5, marks: 2 },
    { count: 4, marks: 3 },
    { count: 2, marks: 5 },
  ]);
  const [duration, setDuration] = useState(90);

  const getTopicMarker = (topic: string) => {
    const marker = topic.split(/\s+/, 1)[0];
    return /^\d+(?:\.\d+)*$/.test(marker) ? marker : null;
  };
  const isDescendant = (parent: string, child: string) => {
    const parentMarker = getTopicMarker(parent);
    const childMarker = getTopicMarker(child);
    return (
      parentMarker !== null &&
      childMarker !== null &&
      childMarker.startsWith(`${parentMarker}.`)
    );
  };
  const getDescendants = (topic: string) =>
    extractedTopics.filter((candidate) => isDescendant(topic, candidate));
  const toggleTopic = (topic: string) =>
    setSelectedTopics((current) => {
      const relatedTopics = [topic, ...getDescendants(topic)];
      const isFullySelected = relatedTopics.every((item) =>
        current.includes(item),
      );
      if (isFullySelected)
        return current.filter((item) => !relatedTopics.includes(item));
      return [
        ...current,
        ...relatedTopics.filter((item) => !current.includes(item)),
      ];
    });
  const extractPdfText = async (file: File) => {
    const document = await pdfjsLib.getDocument({
      data: new Uint8Array(await file.arrayBuffer()),
    }).promise;
    const pages: string[] = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      pages.push(
        (content.items as Array<{ str?: string; hasEOL?: boolean }>)
          .map((item) => `${item.str || ""}${item.hasEOL ? "\n" : " "}`)
          .join("")
          .replace(/[ \t]+\n/g, "\n"),
      );
    }
    return pages.join("\n");
  };
  const extractDocumentText = async (file: File) => {
    if (file.name.toLowerCase().endsWith(".pdf")) return extractPdfText(file);
    const result = await mammoth.extractRawText({
      arrayBuffer: await file.arrayBuffer(),
    });
    return result.value;
  };
  const findTopics = (text: string) => {
    const lines = text
      .split(/\r?\n/)
      .map((line) =>
        line
          .replace(/\s*\.\s*/g, ".")
          .replace(/\s+/g, " ")
          .trim(),
      )
      .filter((line) => line.length >= 3);
    const excludedLabel =
      /^(figure|fig\.?|activity|table|question|exercise|example|page)\b/i;
    const chapterNumbers = new Set(
      lines.flatMap((line) => {
        const match = line.match(/^chapter\s+(\d+)\b|^(\d+)\s+chapter\b/i);
        return match ? [match[1] || match[2]] : [];
      }),
    );
    const cleanHeading = (value: string) => {
      let words = value.replace(/\s+/g, " ").trim().split(" ");
      // Repeated split fragments are merged only when the same fragment pair repeats.
      const mergedWords: string[] = [];
      for (let index = 0; index < words.length; index += 1) {
        const current = words[index];
        const next = words[index + 1];
        const pair = `${current} ${next}`.toLowerCase();
        const repeats = words.slice(index + 2).some(
          (_, offset) =>
            words
              .slice(index + 2 + offset, index + 4 + offset)
              .join(" ")
              .toLowerCase() === pair,
        );
        if (
          next &&
          current.length >= 3 &&
          current.length <= 7 &&
          next.length >= 3 &&
          next.length <= 8 &&
          /^[A-Z]+$/.test(current) &&
          /^[A-Z]+$/.test(next) &&
          repeats
        ) {
          mergedWords.push(`${current}${next}`);
          index += 1;
        } else mergedWords.push(current);
      }
      words = mergedWords;
      // PDF text layers can repeat a whole heading; remove any adjacent matching token block.
      let changed = true;
      while (changed) {
        changed = false;
        for (let index = 0; index < words.length - 1; index += 1) {
          for (
            let blockLength = Math.min(
              12,
              Math.floor((words.length - index) / 2),
            );
            blockLength >= 2;
            blockLength -= 1
          ) {
            const first = words
              .slice(index, index + blockLength)
              .join(" ")
              .toLowerCase();
            const second = words
              .slice(index + blockLength, index + blockLength * 2)
              .join(" ")
              .toLowerCase();
            if (first === second) {
              words.splice(index + blockLength, blockLength);
              changed = true;
              break;
            }
          }
          if (changed) break;
        }
      }
      const cleanedWords: string[] = [];
      for (const word of words) {
        if (
          cleanedWords.length === 0 ||
          word.toLowerCase() !==
            cleanedWords[cleanedWords.length - 1].toLowerCase()
        )
          cleanedWords.push(word);
      }
      return cleanedWords.join(" ").slice(0, 200).trim();
    };
    const numberedHeadings = lines.flatMap((line) => {
      const match = line.match(
        /^(?:chapter\s+)?(\d+(?:\.\d+)*)(?:[.)])?\s+(.+)$/i,
      );
      if (
        !match ||
        (chapterNumbers.size > 0 &&
          !chapterNumbers.has(match[1].split(".")[0])) ||
        excludedLabel.test(match[2]) ||
        excludedLabel.test(line.slice(0, match.index || 0))
      )
        return [];
      const marker = match[1];
      const label = cleanHeading(match[2]);
      // Sentence-ending punctuation is rejected below; this intentionally trades away question-style headings.
      if (
        !/^[A-Za-z]/.test(label) ||
        /[.!?]$/.test(label) ||
        label.split(" ").length > 30 ||
        (/^(what|which|how|why|when|where|define|state|explain|describe|give|list|identify)\b/i.test(
          label,
        ) &&
          /^[0-9]+[.)]/.test(line))
      )
        return [];
      return [`${marker} ${label}`];
    });
    if (numberedHeadings.length > 0)
      return [
        ...new Map(
          numberedHeadings.map((heading) => [heading.split(" ")[0], heading]),
        ).values(),
      ]
        .sort((first, second) => {
          const firstNumbers = first.split(" ")[0].split(".").map(Number);
          const secondNumbers = second.split(" ")[0].split(".").map(Number);
          for (
            let index = 0;
            index < Math.max(firstNumbers.length, secondNumbers.length);
            index += 1
          ) {
            const difference =
              (firstNumbers[index] || 0) - (secondNumbers[index] || 0);
            if (difference !== 0) return difference;
          }
          return 0;
        })
        .slice(0, 40);
    const minorWords = new Set([
      "a",
      "an",
      "the",
      "of",
      "in",
      "on",
      "to",
      "and",
      "or",
      "for",
      "is",
      "are",
      "with",
    ]);
    const isTitleCase = (line: string) =>
      line
        .split(" ")
        .every(
          (word) =>
            minorWords.has(word.toLowerCase()) ||
            /^[A-Z][A-Za-z'()-]*$/.test(word),
        );
    const fallbackHeadings: string[] = [];
    for (const line of lines) {
      const wordCount = line.split(" ").length;
      if (
        wordCount < 2 ||
        wordCount > 12 ||
        /[.!?,;:]$/.test(line) ||
        /\d/.test(line) ||
        excludedLabel.test(line) ||
        /\b(chapter|section|unit|lesson)\b/i.test(line)
      )
        continue;
      if (
        !(/[A-Z]/.test(line) && line === line.toUpperCase()) &&
        !isTitleCase(line)
      )
        continue;
      const heading = cleanHeading(line);
      if (
        !fallbackHeadings.some(
          (item) => item.toLowerCase() === heading.toLowerCase(),
        )
      )
        fallbackHeadings.push(heading);
      if (fallbackHeadings.length === 30) break;
    }
    return fallbackHeadings;
  };
  const analyzeTextbook = async (files: File[]) => {
    const selectedFiles = files;
    const firstFile = selectedFiles[0];
    if (!firstFile) return;
    setFileName(firstFile.name);
    setFileCount(selectedFiles.length);
    setUploadError("");
    setIsAnalyzing(true);
    try {
      const extractedTexts = await Promise.all(
        selectedFiles.map((file) => extractDocumentText(file)),
      );
      setTextbookText(extractedTexts.join("\n"));
      const detectedTopics = [
        ...new Set(extractedTexts.flatMap((text) => findTopics(text))),
      ];
      if (detectedTopics.length === 0)
        throw new Error("No headings or topics were found in this document.");
      setExtractedTopics(detectedTopics);
      setSelectedTopics(detectedTopics);
    } catch (error) {
      setExtractedTopics([]);
      setSelectedTopics([]);
      setUploadError(
        error instanceof Error ? error.message : "This file could not be read.",
      );
    } finally {
      setIsAnalyzing(false);
    }
  };
  const addTextbooks = (files: File[]) => {
    const combinedFiles = [...textbookFiles, ...files].filter(
      (file, index, allFiles) =>
        allFiles.findIndex(
          (candidate) =>
            candidate.name === file.name && candidate.size === file.size,
        ) === index,
    );
    setTextbookFiles(combinedFiles);
    void analyzeTextbook(combinedFiles);
  };
  const handleFile = (event: React.ChangeEvent<HTMLInputElement>) => {
    if (event.target.files?.length)
      addTextbooks(Array.from(event.target.files));
    event.target.value = "";
  };
  const handleDrop = (event: React.DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    if (event.dataTransfer.files?.length)
      addTextbooks(Array.from(event.dataTransfer.files));
  };
  const nextStep = () =>
    setActiveStep((current) => Math.min(current + 1, steps.length - 1));
  const totalMarks = patternSections.reduce(
    (total, section) => total + section.count * section.marks,
    0,
  );
  const updatePatternSection = (
    index: number,
    field: "count" | "marks",
    value: number,
  ) =>
    setPatternSections((current) =>
      current.map((section, sectionIndex) =>
        sectionIndex === index
          ? { ...section, [field]: Math.max(0, value) }
          : section,
      ),
    );
  const addPatternSection = () =>
    setPatternSections((current) => [...current, { count: 1, marks: 1 }]);
  const handleDesignFiles = async (files: File[]) => {
    const file = files[0];
    if (!file) return;
    setDesignFiles(files);
    setDesignFileName(
      files.length === 1 ? file.name : `${files.length} files selected`,
    );

    try {
      if (file.name.toLowerCase().endsWith(".pdf")) {
        const detectedLayout = await detectBlueprintLayout(file);
        setBlueprintLayout(detectedLayout);
        setBlueprintPreview(await renderBlueprintPreview(file, detectedLayout));
      } else {
        setBlueprintLayout(null);
        setBlueprintPreview([]);
      }

      const [detectedTheme, , lines, logos] = await Promise.all([
        file.name.toLowerCase().endsWith(".docx")
          ? extractThemeFromDocx(file)
          : file.name.toLowerCase().endsWith(".pdf")
            ? extractThemeFromPdf(file)
            : Promise.resolve({} as Partial<PaperTheme>),
        extractDocumentText(file),
        file.name.toLowerCase().endsWith(".docx") ? extractDocxLines(file) : extractPdfLines(file),
        file.name.toLowerCase().endsWith(".docx") ? extractDocxLogo(file) : extractPdfLogos(file),
      ]);
      setPaperTheme({ ...DEFAULT_THEME, ...detectedTheme });
      setPaperTemplate({ ...EMPTY_TEMPLATE, ...extractPaperTemplate(lines), logos });
    } catch {
      setPaperTheme(DEFAULT_THEME);
      setPaperTemplate(EMPTY_TEMPLATE);
      setBlueprintLayout(null);
      setBlueprintPreview([]);
    }
  };

  const updateBlueprintSection = (
    sectionLabel: string,
    field: "startY" | "endY",
    value: number,
  ) => {
    setBlueprintLayout((current) => {
      if (!current) return current;
      return {
        ...current,
        sections: current.sections.map((section) =>
          section.label === sectionLabel
            ? {
                ...section,
                [field]: Math.max(0, value),
              }
            : section,
        ),
      };
    });
  };

  const generatePdf = async () => {
    if (blueprintLayout && designFiles[0] && designFiles[0].name.toLowerCase().endsWith(".pdf")) {
      const generatedQuestionSections = patternSections.map((section, index) => {
        const questionList = Array.from({ length: section.count }, (_, questionIndex) => {
          const topic = selectedTopics[(questionIndex + index) % Math.max(1, selectedTopics.length || 1)] || "the selected topic";
          const questionText = `${questionIndex + 1}. ${makeQuestion(topic, questionIndex, section.marks)}`;
          return { text: questionText, marks: section.marks };
        });
        return {
          label: `Section ${String.fromCharCode(65 + index)}`,
          questions: questionList,
        };
      });

      const filledBytes = await fillBlueprintPdf(designFiles[0], blueprintLayout, generatedQuestionSections);
      const pdfDoc = await PDFDocument.load(filledBytes);
      const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
      await renumberPages(pdfDoc, blueprintLayout, font);
      const finalBytes = await pdfDoc.save();
      const pdfBuffer = new Uint8Array(finalBytes).buffer;
      const blob = new Blob([pdfBuffer], { type: "application/pdf" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "qp-setter-blueprint.pdf";
      anchor.click();
      URL.revokeObjectURL(url);
      setGenerated(true);
      return;
    }

    const pdf = new jsPDF();
    const pageWidth = pdf.internal.pageSize.getWidth();
    const margin = paperTheme.marginMm;
    const contentWidth = pageWidth - margin * 2;
    const pageHeight = pdf.internal.pageSize.getHeight();
    const borderColor = paperTheme.borderColor.replace("#", "");
    const drawBorder = () => {
      if (paperTheme.borderStyle === "none") return;
      pdf.setDrawColor(
        parseInt(borderColor.slice(0, 2), 16),
        parseInt(borderColor.slice(2, 4), 16),
        parseInt(borderColor.slice(4, 6), 16),
      );
      pdf.rect(
        margin,
        margin,
        contentWidth,
        pageHeight - margin * 2,
      );
      if (paperTheme.borderStyle === "double")
        pdf.rect(
          margin + 2,
          margin + 2,
          contentWidth - 4,
          pageHeight - margin * 2 - 4,
        );
    };
    drawBorder();
    let titleY = margin + 4;
    paperTemplate.logos.slice(0, 2).forEach((logo, index) => {
      const logoX = index === 0 ? 15 : pageWidth - 40;
      pdf.addImage(logo, "PNG", logoX, 10, 25, 25);
    });
    pdf.setFont("helvetica", paperTemplate.schoolName.bold ? "bold" : "normal");
    pdf.setFontSize(paperTheme.titleSize);
    pdf.text(paperTemplate.schoolName.text || "QUESTION PAPER", pageWidth / 2, titleY, { align: "center" });
    pdf.setFont("helvetica", paperTemplate.examTitle.bold ? "bold" : "normal");
    pdf.setFontSize(paperTheme.headingSize);
    pdf.text(paperTemplate.examTitle.text || (paperTemplate.schoolName.text ? "" : "QP Setter"), pageWidth / 2, titleY + 8, { align: "center" });
    pdf.setFont(paperTheme.bodyFont, "normal");
    pdf.setFontSize(paperTheme.bodySize);
    const hasTemplateContent = Boolean(paperTemplate.schoolName.text || paperTemplate.examTitle.text || paperTemplate.className || paperTemplate.subjectName || paperTemplate.generalInstructions.length || paperTemplate.sections.length);
    const metaY = titleY + 24;
    pdf.text(`Class: ${paperTemplate.className || ""}`, margin, metaY, { align: "left" });
    pdf.text(`Subject: ${paperTemplate.subjectName || (hasTemplateContent ? "" : fileName || "Selected textbook")}`, pageWidth / 2, metaY, { align: "center" });
    pdf.text(`${paperTemplate.maxMarksLabel}: ${totalMarks}`, pageWidth - margin, metaY, { align: "right" });
    const headerBottom = titleY + 40;
    pdf.line(margin, headerBottom, pageWidth - margin, headerBottom);
    let yPosition = headerBottom + 14;
    if (paperTemplate.generalInstructions.length > 0) {
      pdf.setFont("helvetica", paperTemplate.generalInstructionsHeading.bold ? "bold" : "normal");
      pdf.setFontSize(paperTheme.headingSize);
      pdf.text(paperTemplate.generalInstructionsHeading.text || "General Instructions", margin, yPosition);
      pdf.setFont(paperTheme.bodyFont, "normal");
      pdf.setFontSize(paperTheme.bodySize);
      yPosition += paperTheme.lineSpacingMm;
      paperTemplate.generalInstructions.forEach((instruction, index) => {
        pdf.setFont("helvetica", instruction.bold ? "bold" : "normal");
        pdf.text(`${index + 1}. ${instruction.text}`, margin + 3, yPosition);
        pdf.setFont(paperTheme.bodyFont, "normal");
        yPosition += paperTheme.lineSpacingMm;
      });
      yPosition += paperTheme.sectionSpacingMm;
    }
    const questionTopics =
      selectedTopics.length > 0
        ? selectedTopics
        : ["the selected textbook topics"];
    const sourceSentences = textbookText
      .split(/(?<=[.!?])\s+/)
      .map((sentence) => sentence.replace(/\s+/g, " ").trim())
      .filter(
        (sentence) =>
          sentence.length >= 35 &&
          sentence.length <= 220 &&
          !/^(activity|figure|table|question|exercise|page)\b/i.test(sentence),
      );
    const getSourceSentence = (topic: string, questionIndex: number) => {
      const topicWords = topic
        .toLowerCase()
        .replace(/^\d+(?:\.\d+)*\s+/, "")
        .split(/\s+/)
        .filter((word) => word.length > 3);
      const matchingSentences = sourceSentences.filter((sentence) =>
        topicWords.some((word) => sentence.toLowerCase().includes(word)),
      );
      return (
        (matchingSentences.length > 0 ? matchingSentences : sourceSentences)[
          questionIndex %
            Math.max(1, matchingSentences.length || sourceSentences.length)
        ] || `the key concepts in ${topic}`
      );
    };
    const makeQuestion = (
      topic: string,
      questionIndex: number,
      marks: number,
    ) => {
      const sentence = getSourceSentence(topic, questionIndex)
        .replace(
          /\b(chapter|section|unit|lesson)\s+\d+(?:\.\d+)*/gi,
          "the lesson",
        )
        .replace(/\b\d+(?:\.\d+)+\b/g, "")
        .replace(/\s+/g, " ")
        .trim();
      if (difficulty === "Easy")
        return `Define the term described below and state one important characteristic: ${sentence}`;
      if (difficulty === "Advanced")
        return `Analyse the following statement and give reasons to support your answer: ${sentence}`;
      if (difficulty === "Application")
        return `A student observes the situation described below. Explain what happens and why: ${sentence}`;
      if (marks === 1)
        return `State one important fact based on the following: ${sentence}`;
      if (marks === 2) return `Explain the following observation: ${sentence}`;
      if (marks === 3)
        return `Explain the following concept and give a suitable example: ${sentence}`;
      return `Explain the following in detail. Include the relevant principles, reasons, and an appropriate example: ${sentence}`;
    };
    let questionNumber = 1;
    patternSections.forEach((section, index) => {
      const templateSection = paperTemplate.sections[index];
      pdf.setFont("helvetica", templateSection?.label.bold ? "bold" : "normal");
      pdf.setFontSize(paperTheme.headingSize);
      pdf.text(`${templateSection?.label.text || `Section ${String.fromCharCode(65 + index)}`} (${section.count} x ${section.marks} = ${section.count * section.marks} marks)`, margin, yPosition);
      if (templateSection?.instructions.text) {
        pdf.setFont("helvetica", templateSection.instructions.bold ? "bold" : "normal");
        pdf.text(templateSection.instructions.text, margin, yPosition + paperTheme.lineSpacingMm);
        yPosition += paperTheme.lineSpacingMm;
      }
      pdf.setFont(paperTheme.bodyFont, "normal");
      pdf.setFontSize(paperTheme.bodySize);
      yPosition += paperTheme.lineSpacingMm + 4;
      for (let question = 0; question < section.count; question += 1) {
        const topic =
          questionTopics[(questionNumber - 1) % questionTopics.length];
        const questionText = `${questionNumber}. ${makeQuestion(topic, questionNumber - 1, section.marks)}`;
        const lines = pdf.splitTextToSize(questionText, contentWidth - 10);
        pdf.text(lines, margin + 5, yPosition);
        yPosition += Math.max(8, lines.length * paperTheme.lineSpacingMm) + 4;
        questionNumber += 1;
        if (yPosition > pageHeight - margin - 2) {
          pdf.addPage();
          drawBorder();
          yPosition = margin;
        }
      }
      yPosition += paperTheme.sectionSpacingMm;
    });
    if (textbookText.length === 0) {
      pdf.setFontSize(8);
      pdf.text("Generated from selected textbook topics.", margin, pageHeight - 7);
    }
    pdf.save("qp-setter-question-paper.pdf");
    setGenerated(true);
  };

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">Q</span>
          <span>QP Setter</span>
        </div>
        <div className="workspace-label">WORKSPACE</div>
        <nav>
          <button
            className={`nav-item ${activeNav === "New paper" ? "active" : ""}`}
            onClick={() => setActiveNav("New paper")}
          >
            <span className="nav-icon">＋</span>New paper
          </button>
          <button
            className={`nav-item ${activeNav === "Question bank" ? "active" : ""}`}
            onClick={() => setActiveNav("Question bank")}
          >
            <span className="nav-icon">▦</span>Question bank{" "}
            <span className="count">248</span>
          </button>
          <button
            className={`nav-item ${activeNav === "Recent papers" ? "active" : ""}`}
            onClick={() => setActiveNav("Recent papers")}
          >
            <span className="nav-icon">◷</span>Recent papers
          </button>
        </nav>
        <div className="sidebar-bottom">
          <div className="bank-note">
            <span className="spark">✦</span>
            <div>
              <strong>Your bank is growing</strong>
              <small>248 unique questions saved</small>
            </div>
          </div>
          <button className="profile">
            <span className="avatar">AS</span>
            <span>
              <strong>Arjun Sharma</strong>
              <small>Science department</small>
            </span>
            <span className="dots">···</span>
          </button>
        </div>
      </aside>
      <main className="main-content">
        <header className="topbar">
          <div className="crumb">
            Workspace <span>/</span> <strong>New question paper</strong>
          </div>
          <button className="help">
            ? <span>Help center</span>
          </button>
        </header>
        <div className="content-wrap">
          <section className="page-intro">
            <div>
              <p className="eyebrow">
                NEW PAPER <span className="line" />
              </p>
              <h1>
                {activeStep === 0 ? (
                  <>
                    Start with your
                    <br />
                    <em>textbook.</em>
                  </>
                ) : (
                  <>
                    Build a paper
                    <br />
                    <em>that feels familiar.</em>
                  </>
                )}
              </h1>
              <p className="intro-copy">
                {activeStep === 0
                  ? "Upload your source material and choose the chapters and topics you want to use."
                  : "Bring your textbook, pattern, and institution's voice together. We'll handle the heavy lifting."}
              </p>
            </div>
            <div className="progress-block">
              <span>SETUP PROGRESS</span>
              <strong>
                {activeStep + 1} <small>/ 4</small>
              </strong>
              <div className="progress-bar">
                <i style={{ width: `${((activeStep + 1) / 4) * 100}%` }} />
              </div>
            </div>
          </section>
          <div className="stepper">
            {steps.map((step, index) => (
              <button
                key={step.number}
                className={`step ${activeStep === index ? "selected" : ""} ${index < activeStep ? "complete" : ""}`}
                onClick={() => setActiveStep(index)}
              >
                <span className="step-number">
                  {index < activeStep ? "✓" : step.number}
                </span>
                <span>
                  <strong>{step.label}</strong>
                  <small>{step.detail}</small>
                </span>
              </button>
            ))}
          </div>
          {activeStep === 0 && (
            <section className="single-panel">
              <div className="builder-card">
                <div className="card-heading">
                  <div>
                    <span className="section-index">01</span>
                    <h2>Start with your textbook</h2>
                    <p>We'll map the chapters and topics for you.</p>
                  </div>
                  <span className="status-pill">Required</span>
                </div>
                <label
                  className="upload-zone"
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={handleDrop}
                >
                  <input
                    type="file"
                    accept=".pdf,.doc,.docx"
                    multiple
                    onChange={handleFile}
                  />
                  <span className="upload-icon">{isAnalyzing ? "…" : "↑"}</span>
                  <span>
                    <strong>
                      {isAnalyzing
                        ? "Analyzing your textbooks…"
                        : fileName
                          ? `${fileCount} file${fileCount === 1 ? "" : "s"} selected`
                          : "Drop your textbooks here"}
                    </strong>
                    <small>
                      {isAnalyzing
                        ? "Finding chapters, topics, and subtopics"
                        : fileName
                          ? `${fileName} · upload complete`
                          : "PDF or Word documents · select multiple files · max 50 MB each"}
                    </small>
                  </span>
                  <span className="browse">Browse files</span>
                </label>
                {uploadError && <p className="upload-error">{uploadError}</p>}
                {fileName && !uploadError ? (
                  <>
                    <div className="source-preview">
                      <div className="book-icon">▤</div>
                      <div>
                        <strong>{fileName}</strong>
                        <small>
                          {isAnalyzing
                            ? "Reading document structure…"
                            : `${fileCount} textbook${fileCount === 1 ? "" : "s"} uploaded successfully`}
                        </small>
                      </div>
                      <span className="check">{isAnalyzing ? "…" : "✓"}</span>
                    </div>
                    <div className="topic-header">
                      <div>
                        <h3>
                          {isAnalyzing
                            ? "Extracting topics…"
                            : "Choose what to include"}
                        </h3>
                        <p>
                          {selectedTopics.length} of {extractedTopics.length}{" "}
                          topics selected
                        </p>
                      </div>
                      <button
                        onClick={() =>
                          setSelectedTopics(
                            selectedTopics.length === extractedTopics.length
                              ? []
                              : extractedTopics,
                          )
                        }
                      >
                        {selectedTopics.length === extractedTopics.length
                          ? "Clear all"
                          : "Select all"}
                      </button>
                    </div>
                    <div className="topic-list">
                      {extractedTopics.map((topic) => {
                        const depth = topic.split(" ")[0].split(".").length - 1;
                        const descendants = getDescendants(topic);
                        const selectedDescendants = descendants.filter(
                          (candidate) => selectedTopics.includes(candidate),
                        ).length;
                        const isParent = descendants.length > 0;
                        const isChecked =
                          selectedTopics.includes(topic) &&
                          (!isParent ||
                            selectedDescendants === descendants.length);
                        const isIndeterminate =
                          isParent &&
                          !isChecked &&
                          (selectedTopics.includes(topic) ||
                            selectedDescendants > 0);
                        return (
                          <label
                            key={topic}
                            className={`topic-row ${depth > 0 ? `subtopic depth-${depth}` : ""}`}
                          >
                            <input
                              type="checkbox"
                              checked={isChecked}
                              ref={(element) => {
                                if (element)
                                  element.indeterminate = isIndeterminate;
                              }}
                              onChange={() => toggleTopic(topic)}
                            />
                            <span
                              className={`fake-check ${isIndeterminate ? "indeterminate" : ""}`}
                              style={
                                isIndeterminate
                                  ? {
                                      background: "#d99552",
                                      borderColor: "#d99552",
                                      color: "white",
                                      fontSize: "12px",
                                    }
                                  : undefined
                              }
                            >
                              {isIndeterminate ? "−" : "✓"}
                            </span>
                            {topic}
                            <span className="topic-chevron">›</span>
                          </label>
                        );
                      })}
                    </div>
                  </>
                ) : (
                  <div className="empty-source">
                    <span>01</span>
                    <p>
                      {uploadError ||
                        "Your textbook chapters and topics will appear here after upload."}
                    </p>
                  </div>
                )}
                <div className="panel-actions">
                  <span>Step 1 of 4</span>
                  <button className="next-button" onClick={nextStep}>
                    Continue to pattern <span>→</span>
                  </button>
                </div>
              </div>
            </section>
          )}
          {activeStep === 1 && (
            <section className="single-panel">
              <div className="mini-card pattern-card large-card">
                <div className="mini-title">
                  <span className="section-index">02</span>
                  <div>
                    <h2>Question pattern</h2>
                    <p>Set the marks and duration for this institution.</p>
                  </div>
                </div>
                <div className="segmented">
                  <button
                    className={patternMode === "manual" ? "on" : ""}
                    onClick={() => setPatternMode("manual")}
                  >
                    Manual setup
                  </button>
                  <button
                    className={patternMode === "upload" ? "on" : ""}
                    onClick={() => setPatternMode("upload")}
                  >
                    Upload pattern
                  </button>
                </div>
                {patternMode === "manual" ? (
                  <div className="pattern-builder">
                    <div className="pattern-labels">
                      <span>Questions</span>
                      <span>Marks each</span>
                    </div>
                    {patternSections.map((section, index) => (
                      <div className="pattern-row" key={index}>
                        <input
                          aria-label={`Section ${index + 1} questions`}
                          type="number"
                          min="0"
                          value={section.count}
                          onChange={(event) =>
                            updatePatternSection(
                              index,
                              "count",
                              Number(event.target.value),
                            )
                          }
                        />
                        <span>questions ×</span>
                        <input
                          aria-label={`Section ${index + 1} marks`}
                          type="number"
                          min="1"
                          value={section.marks}
                          onChange={(event) =>
                            updatePatternSection(
                              index,
                              "marks",
                              Number(event.target.value),
                            )
                          }
                        />
                        <span>marks</span>
                      </div>
                    ))}
                    <button className="add-section" onClick={addPatternSection}>
                      ＋ Add mark section
                    </button>
                    <label className="duration-field">
                      Exam duration (minutes)
                      <input
                        type="number"
                        min="1"
                        value={duration}
                        onChange={(event) =>
                          setDuration(Math.max(1, Number(event.target.value)))
                        }
                      />
                    </label>
                  </div>
                ) : (
                  <label className="compact-upload">
                    <input type="file" accept=".pdf,.doc,.docx" multiple />
                    <span>＋</span> Upload one or more pattern files
                  </label>
                )}
                <div className="total-row">
                  <span>
                    Total marks <strong>{totalMarks}</strong>
                  </span>
                  <span>
                    Duration <strong>{duration} min</strong>
                  </span>
                </div>
                <div className="panel-actions">
                  <button
                    className="back-button"
                    onClick={() => setActiveStep(0)}
                  >
                    ← Back
                  </button>
                  <button className="next-button" onClick={nextStep}>
                    Continue to design <span>→</span>
                  </button>
                </div>
              </div>
            </section>
          )}
          {activeStep === 2 && (
            <section className="single-panel">
              <div className="mini-card large-card">
                <div className="mini-title">
                  <span className="section-index">03</span>
                  <div>
                    <h2>Match your design</h2>
                    <p>Make it look like your institution.</p>
                  </div>
                  <span className="optional">Optional</span>
                </div>
                <label className="design-upload">
                  <input
                    type="file"
                    accept=".pdf,.doc,.docx"
                    multiple
                    onChange={(event) => void handleDesignFiles(Array.from(event.target.files || []))}
                  />
                  <span className="doc-icon">▤</span>
                  <span>
                    <strong>
                      {designFileName || "Upload previous papers"}
                    </strong>
                    <small>
                      {designFileName
                        ? "Ready to analyze layout"
                        : "PDF or Word · select multiple reference papers"}
                    </small>
                  </span>
                  <button type="button" aria-label="Upload previous paper">
                    ＋
                  </button>
                </label>
                {designFiles.length > 0 && blueprintLayout && (
                  <div className="blueprint-preview-block">
                    <div className="blueprint-preview">
                      {blueprintPreview.map((page) => (
                        <div key={page.pageIndex} className="blueprint-page-preview">
                          <img src={page.src} alt={`Blueprint page ${page.pageIndex + 1}`} />
                          {page.boxes.map((box, boxIndex) => (
                            <div
                              key={`${box.label}-${boxIndex}`}
                              className="blueprint-box"
                              style={{
                                left: `${box.left}%`,
                                top: `${box.top}px`,
                                width: `${Math.max(box.width, 10)}px`,
                                height: `${Math.max(box.height, 10)}px`,
                              }}
                              title={box.label}
                            />
                          ))}
                        </div>
                      ))}
                    </div>
                    <div className="blueprint-adjustments">
                      {blueprintLayout.sections.map((section, index) => (
                        <div key={`${section.label}-${index}`} className="blueprint-adjustment-row">
                          <strong>{section.label}</strong>
                          <label>
                            Start Y
                            <input type="number" value={Math.round(section.startY)} onChange={(event) => updateBlueprintSection(section.label, "startY", Number(event.target.value))} />
                          </label>
                          <label>
                            End Y
                            <input type="number" value={Math.round(section.endY)} onChange={(event) => updateBlueprintSection(section.label, "endY", Number(event.target.value))} />
                          </label>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {designFiles.length > 0 && (
                  <div className="theme-preview">
                    <strong>Detected style</strong>
                    <div className="theme-controls">
                      <label>Title font<select value={paperTheme.titleFont} onChange={(event) => setPaperTheme((prev) => ({ ...prev, titleFont: event.target.value as PaperFont }))}><option value="helvetica">Helvetica</option><option value="times">Times</option><option value="courier">Courier</option></select></label>
                      <label>Body font<select value={paperTheme.bodyFont} onChange={(event) => setPaperTheme((prev) => ({ ...prev, bodyFont: event.target.value as PaperFont }))}><option value="helvetica">Helvetica</option><option value="times">Times</option><option value="courier">Courier</option></select></label>
                      <label>Title size<input type="number" min="6" max="48" value={paperTheme.titleSize} onChange={(event) => setPaperTheme((prev) => ({ ...prev, titleSize: Number(event.target.value) }))} /></label>
                      <label>Body size<input type="number" min="6" max="24" value={paperTheme.bodySize} onChange={(event) => setPaperTheme((prev) => ({ ...prev, bodySize: Number(event.target.value) }))} /></label>
                    </div>
                    {paperTheme.logoDataUrl && <div className="logo-preview"><img src={paperTheme.logoDataUrl} alt="Detected logo" /><button type="button" onClick={() => setPaperTheme((prev) => ({ ...prev, logoDataUrl: null }))}>Remove logo</button></div>}
                    {paperTemplate.logos.length > 0 && <div className="logo-preview">{paperTemplate.logos.map((logo, index) => <div key={logo}><img src={logo} alt={`Detected logo ${index + 1}`} /><button type="button" onClick={() => setPaperTemplate((prev) => ({ ...prev, logos: prev.logos.filter((_, logoIndex) => logoIndex !== index) }))}>Remove logo {index + 1}</button></div>)}</div>}
                    <small>We've matched what we could detect — adjust anything that doesn't look right before generating.</small>
                  </div>
                )}
                {designFiles.length > 0 && (
                  <div className="template-preview">
                    <strong>Reference paper content</strong>
                    <div className="template-fields">
                      {([['schoolName', 'School name'], ['examTitle', 'Exam title']] as const).map(([field, label]) => (
                        <label key={field}>{label}<input value={paperTemplate[field].text} placeholder="Not detected — enter manually" onChange={(event) => setPaperTemplate((prev) => ({ ...prev, [field]: { ...prev[field], text: event.target.value } }))} /><span><input type="checkbox" checked={paperTemplate[field].bold} onChange={(event) => setPaperTemplate((prev) => ({ ...prev, [field]: { ...prev[field], bold: event.target.checked } }))} /> Bold</span></label>
                      ))}
                      {([['className', 'Class'], ['subjectName', 'Subject'], ['maxMarksLabel', 'Max marks label']] as const).map(([field, label]) => (
                        <label key={field}>{label}<input value={paperTemplate[field]} placeholder="Not detected — enter manually" onChange={(event) => setPaperTemplate((prev) => ({ ...prev, [field]: event.target.value }))} /></label>
                      ))}
                    </div>
                    <label className="template-instructions">General instructions heading<input value={paperTemplate.generalInstructionsHeading.text} placeholder="General Instructions" onChange={(event) => setPaperTemplate((prev) => ({ ...prev, generalInstructionsHeading: { ...prev.generalInstructionsHeading, text: event.target.value } }))} /><span><input type="checkbox" checked={paperTemplate.generalInstructionsHeading.bold} onChange={(event) => setPaperTemplate((prev) => ({ ...prev, generalInstructionsHeading: { ...prev.generalInstructionsHeading, bold: event.target.checked } }))} /> Bold</span><textarea rows={4} value={paperTemplate.generalInstructions.map((line) => line.text).join('\n')} placeholder="Not detected — enter one instruction per line" onChange={(event) => setPaperTemplate((prev) => ({ ...prev, generalInstructions: event.target.value.split(/\r?\n/).map((line, index) => ({ text: line.trim(), bold: prev.generalInstructions[index]?.bold || false })).filter((line) => line.text) }))} /></label>
                    <div className="instruction-bolds">{paperTemplate.generalInstructions.map((line, index) => <label key={`${line.text}-${index}`}><input type="checkbox" checked={line.bold} onChange={(event) => setPaperTemplate((prev) => ({ ...prev, generalInstructions: prev.generalInstructions.map((item, itemIndex) => itemIndex === index ? { ...item, bold: event.target.checked } : item) }))} /> Bold instruction {index + 1}</label>)}</div>
                    <div className="template-sections">
                      <span>Sections</span>
                      {paperTemplate.sections.map((section, index) => (
                        <div className="template-section-row" key={`${section.label}-${index}`}>
                          <input value={section.label.text} placeholder="Section A" onChange={(event) => setPaperTemplate((prev) => ({ ...prev, sections: prev.sections.map((item, itemIndex) => itemIndex === index ? { ...item, label: { ...item.label, text: event.target.value } } : item) }))} />
                          <input value={section.instructions.text} placeholder="Section instructions" onChange={(event) => setPaperTemplate((prev) => ({ ...prev, sections: prev.sections.map((item, itemIndex) => itemIndex === index ? { ...item, instructions: { ...item.instructions, text: event.target.value } } : item) }))} />
                          <label><input type="checkbox" checked={section.label.bold} onChange={(event) => setPaperTemplate((prev) => ({ ...prev, sections: prev.sections.map((item, itemIndex) => itemIndex === index ? { ...item, label: { ...item.label, bold: event.target.checked } } : item) }))} /> Bold label</label><label><input type="checkbox" checked={section.instructions.bold} onChange={(event) => setPaperTemplate((prev) => ({ ...prev, sections: prev.sections.map((item, itemIndex) => itemIndex === index ? { ...item, instructions: { ...item.instructions, bold: event.target.checked } } : item) }))} /> Bold instructions</label><button type="button" aria-label={`Remove ${section.label.text}`} onClick={() => setPaperTemplate((prev) => ({ ...prev, sections: prev.sections.filter((_, itemIndex) => itemIndex !== index) }))}>×</button>
                        </div>
                      ))}
                      <button type="button" className="add-section" onClick={() => setPaperTemplate((prev) => ({ ...prev, sections: [...prev.sections, { label: { text: '', bold: false }, instructions: { text: '', bold: false } }] }))}>＋ Add section</button>
                    </div>
                  </div>
                )}
                <div className="panel-actions">
                  <button
                    className="back-button"
                    onClick={() => setActiveStep(1)}
                  >
                    ← Back
                  </button>
                  <button className="next-button" onClick={nextStep}>
                    Continue to difficulty <span>→</span>
                  </button>
                </div>
              </div>
            </section>
          )}
          {activeStep === 3 && (
            <section className="single-panel">
              <div className="mini-card large-card difficulty-card">
                <div className="mini-title">
                  <span className="section-index">04</span>
                  <div>
                    <h2>Set the difficulty</h2>
                    <p>Choose the level of challenge.</p>
                  </div>
                </div>
                <div className="difficulty-options">
                  {["Easy", "Moderate", "Advanced", "Application"].map(
                    (level) => (
                      <button
                        key={level}
                        className={`difficulty ${level.toLowerCase()} ${difficulty === level ? "active-diff" : ""}`}
                        onClick={() => setDifficulty(level)}
                      >
                        <i />
                        {level}
                      </button>
                    ),
                  )}
                </div>
                <div className="panel-actions">
                  <button
                    className="back-button"
                    onClick={() => setActiveStep(2)}
                  >
                    ← Back
                  </button>
                  <button
                    className={`generate ${generated ? "done" : ""}`}
                    onClick={generatePdf}
                  >
                    {generated
                      ? "Download PDF again"
                      : "Generate question paper"}{" "}
                    <span>→</span>
                  </button>
                </div>
              </div>
            </section>
          )}
          {generated && (
            <div className="generated-note">
              <span>✦</span>
              <strong>Your paper is ready for review.</strong> We found 21
              questions across {selectedTopics.length} selected topics. You can
              edit any section before exporting.
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

export default App;
