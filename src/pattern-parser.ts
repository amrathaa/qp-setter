import { joinPdfTextItems } from "./text-cleaner";

export interface ParsedPatternResult {
  sections: Array<{ count: number; marks: number; label?: string }>;
  duration?: number;
  totalMarks?: number;
  rawText: string;
}

/**
 * Extracts plain text from an uploaded pattern file (PDF, DOCX, TXT, JSON).
 */
export async function extractTextFromPatternFile(file: File): Promise<string> {
  const name = file.name.toLowerCase();
  if (name.endsWith(".pdf")) {
    const { pdfjsLib } = await import("./blueprint");
    const doc = await pdfjsLib.getDocument({
      data: new Uint8Array(await file.arrayBuffer()),
    }).promise;
    const pages: string[] = [];
    for (let i = 1; i <= doc.numPages; i += 1) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      pages.push(joinPdfTextItems(content.items as any));
    }
    return pages.join("\n");
  }

  if (name.endsWith(".docx")) {
    const mammoth = await import("mammoth/mammoth.browser");
    const result = await mammoth.extractRawText({
      arrayBuffer: await file.arrayBuffer(),
    });
    return result.value;
  }

  // Plain text or json
  return await file.text();
}

/**
 * Parses raw text to extract exam duration, total marks, and sections with counts and marks.
 */
export function parsePatternText(text: string): ParsedPatternResult {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const sections: Array<{ count: number; marks: number; label?: string }> = [];

  // 1. Detect duration
  let duration: number | undefined;
  const durationMatch = text.match(
    /(?:time|duration)\s*(?:allowed|duration)?\s*[:=-]?\s*(\d+(?:\.\d+)?)\s*(hours?|hrs?|minutes?|mins?)/i,
  );
  if (durationMatch) {
    const val = parseFloat(durationMatch[1]);
    const unit = durationMatch[2].toLowerCase();
    if (unit.startsWith("h")) {
      duration = Math.round(val * 60);
    } else {
      duration = Math.round(val);
    }
  }

  // 2. Detect total marks
  let totalMarks: number | undefined;
  const marksMatch = text.match(/(?:max(?:imum)?\s*marks?|total\s*marks?)\s*[:=-]?\s*(\d+)/i);
  if (marksMatch) {
    totalMarks = parseInt(marksMatch[1], 10);
  }

  // 3. Detect sections and patterns
  for (const line of lines) {
    // E.g. "Section A: 10 questions of 1 mark each" or "Part I: 5 x 2 marks = 10"
    const sectionMatch = line.match(
      /(?:section|part|group)\s*([A-Za-z0-9]+)[^:\n]*[:–—]?\s*(?:.*?)(\d+)\s*(?:questions?|qs?|items?)\s*(?:of|x|\*|carrying|@)?\s*(\d+)\s*marks?/i,
    );
    if (sectionMatch) {
      const label = `Section ${sectionMatch[1].toUpperCase()}`;
      const count = parseInt(sectionMatch[2], 10);
      const marks = parseInt(sectionMatch[3], 10);
      if (count > 0 && marks > 0) {
        sections.push({ count, marks, label });
        continue;
      }
    }

    // E.g. "10 x 1 mark = 10 marks" or "Q1 to Q10 - 1 Mark each"
    const rangeMatch = line.match(
      /(?:Q\.?\s*No\.?|Questions?)\s*(\d+)\s*(?:to|[-–—])\s*(\d+)\s*(?:carry|carrying|are\s*of|@)?\s*(\d+)\s*marks?/i,
    );
    if (rangeMatch) {
      const start = parseInt(rangeMatch[1], 10);
      const end = parseInt(rangeMatch[2], 10);
      const marks = parseInt(rangeMatch[3], 10);
      const count = Math.max(1, end - start + 1);
      const label = `Section ${String.fromCharCode(65 + sections.length)}`;
      sections.push({ count, marks, label });
      continue;
    }

    // E.g. "10 questions x 1 mark" or "5 questions * 2 marks"
    const simpleMatch = line.match(
      /(\d+)\s*(?:questions?|qs?)\s*(?:x|\*|of)\s*(\d+)\s*marks?/i,
    );
    if (simpleMatch) {
      const count = parseInt(simpleMatch[1], 10);
      const marks = parseInt(simpleMatch[2], 10);
      const label = `Section ${String.fromCharCode(65 + sections.length)}`;
      sections.push({ count, marks, label });
      continue;
    }
  }

  // Fallback: If no sections matched regex, try structured JSON
  if (sections.length === 0) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed.sections)) {
        for (const s of parsed.sections) {
          if (typeof s.count === "number" && typeof s.marks === "number") {
            sections.push({
              count: s.count,
              marks: s.marks,
              label: s.label || `Section ${String.fromCharCode(65 + sections.length)}`,
            });
          }
        }
      }
    } catch {
      // not JSON
    }
  }

  // No fallback pattern: an empty result lets the caller tell the user nothing was recognised.
  return {
    sections,
    duration,
    totalMarks,
    rawText: text,
  };
}
