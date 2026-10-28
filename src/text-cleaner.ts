/**
 * Reconstructs words broken by PDF font kerning or ligature separation.
 * Examples: "Secti on" -> "Section", "questi on" -> "question", "opti ons" -> "options".
 */
export function cleanBrokenKerningWords(text: string): string {
  if (!text) return text;

  let cleaned = text;

  // Specific common words broken by ti/fi/fl/tt ligatures in PDF exports
  cleaned = cleaned
    .replace(/\bSecti\s+ons?\b/gi, (m) => m.replace(/\s+/, ""))
    .replace(/\bquesti\s+ons?\b/gi, (m) => m.replace(/\s+/, ""))
    .replace(/\bopti\s+ons?\b/gi, (m) => m.replace(/\s+/, ""))
    .replace(/\breproducti\s+ons?\b/gi, (m) => m.replace(/\s+/, ""))
    .replace(/\bcreati\s+ons?\b/gi, (m) => m.replace(/\s+/, ""))
    .replace(/\bmulti\s+ples?\b/gi, (m) => m.replace(/\s+/, ""))
    .replace(/\bnoti\s+ces?\b/gi, (m) => m.replace(/\s+/, ""))
    .replace(/\bnoti\s+ced\b/gi, "noticed")
    .replace(/\bdras\s+ti\s+c\b/gi, "drastic")
    .replace(/\bdras\s+tic\b/gi, "drastic")
    .replace(/\bdrasti\s+c\b/gi, "drastic")
    .replace(/\bdifferen\s+ti\s+ated?\b/gi, "differentiated")
    .replace(/\bdifferen\s+tiated?\b/gi, "differentiated")
    .replace(/\bdifferenti\s+ated?\b/gi, "differentiated")
    .replace(/\bpropaga\s+ti\s+ons?\b/gi, (m) => m.replace(/\s+/g, ""))
    .replace(/\bpropagati\s+ons?\b/gi, (m) => m.replace(/\s+/, ""))
    .replace(/\bforma\s+ti\s+ons?\b/gi, (m) => m.replace(/\s+/g, ""))
    .replace(/\bformati\s+ons?\b/gi, (m) => m.replace(/\s+/, ""))
    .replace(/\bvaria\s+ti\s+ons?\b/gi, (m) => m.replace(/\s+/g, ""))
    .replace(/\bvariati\s+ons?\b/gi, (m) => m.replace(/\s+/, ""))
    .replace(/\bnutri\s+ti\s+ons?\b/gi, (m) => m.replace(/\s+/g, ""))
    .replace(/\bnutriti\s+ons?\b/gi, (m) => m.replace(/\s+/, ""))
    .replace(/\brespira\s+ti\s+ons?\b/gi, (m) => m.replace(/\s+/g, ""))
    .replace(/\brespirati\s+ons?\b/gi, (m) => m.replace(/\s+/, ""))
    .replace(/\bexcre\s+ti\s+ons?\b/gi, (m) => m.replace(/\s+/g, ""))
    .replace(/\bexcreti\s+ons?\b/gi, (m) => m.replace(/\s+/, ""))
    .replace(/\bpatt\s+erns?\b/gi, (m) => m.replace(/\s+/, ""))
    .replace(/\bAft\s+er\b/g, "After")
    .replace(/\baft\s+er\b/g, "after")
    .replace(/\bB\s+efore\b/g, "Before")
    .replace(/\bb\s+efore\b/g, "before")
    .replace(/\bs\s+ti\s+ll\b/gi, "still")
    .replace(/\binteres\s+ti\s+ng\b/gi, "interesting")
    .replace(/\bac\s+ti\s+vi\s+ty\b/gi, "activity")
    .replace(/\bac\s+tivi\s+ty\b/gi, "activity")
    .replace(/\bfunc\s+ti\s+ons?\b/gi, (m) => m.replace(/\s+/g, ""))
    .replace(/\bdirec\s+ti\s+ons?\b/gi, (m) => m.replace(/\s+/g, ""))
    .replace(/\breac\s+ti\s+ons?\b/gi, (m) => m.replace(/\s+/g, ""))
    .replace(/\baddi\s+ti\s+ons?\b/gi, (m) => m.replace(/\s+/g, ""))
    .replace(/\bsolu\s+ti\s+ons?\b/gi, (m) => m.replace(/\s+/g, ""))
    .replace(/\bcondi\s+ti\s+ons?\b/gi, (m) => m.replace(/\s+/g, ""))
    .replace(/\bposi\s+ti\s+ons?\b/gi, (m) => m.replace(/\s+/g, ""))
    .replace(/\bsepara\s+ti\s+ons?\b/gi, (m) => m.replace(/\s+/g, ""))
    .replace(/\bdefini\s+ti\s+ons?\b/gi, (m) => m.replace(/\s+/g, ""))
    .replace(/\bdescrip\s+ti\s+ons?\b/gi, (m) => m.replace(/\s+/g, ""))
    .replace(/\binstruc\s+ti\s+ons?\b/gi, (m) => m.replace(/\s+/g, ""))
    .replace(/\brela\s+ti\s+ons?\b/gi, (m) => m.replace(/\s+/g, ""))
    .replace(/\bapplica\s+ti\s+ons?\b/gi, (m) => m.replace(/\s+/g, ""))
    .replace(/\bcollec\s+ti\s+ons?\b/gi, (m) => m.replace(/\s+/g, ""))
    .replace(/\bequa\s+ti\s+ons?\b/gi, (m) => m.replace(/\s+/g, ""))
    .replace(/\bpopula\s+ti\s+ons?\b/gi, (m) => m.replace(/\s+/g, ""))
    .replace(/\borganisa\s+ti\s+ons?\b/gi, (m) => m.replace(/\s+/g, ""))
    .replace(/\borganiza\s+ti\s+ons?\b/gi, (m) => m.replace(/\s+/g, ""))
    .replace(/\bfer\s*ti\s*liza\s*ti\s*ons?\b/gi, (m) => m.replace(/\s+/g, ""));

  // Also replace ligature glyph artifacts (e.g. \u08B2, \uFB00-\uFB06)
  cleaned = cleaned
    .replace(/\uFB01/g, "fi")
    .replace(/\uFB02/g, "fl")
    .replace(/\uFB00/g, "ff")
    .replace(/\uFB03/g, "ffi")
    .replace(/\uFB04/g, "ffl")
    .replace(/\uFB05/g, "ft")
    .replace(/\u08A2|\u08B2/g, "ti");

  // Generalized regex for word-suffix separation: word ending in "ti" followed by space and "on/ons"
  cleaned = cleaned.replace(/\b([A-Za-z]{3,}ti)\s+(on|ons|ve|ng|al)\b/gi, "$1$2");
  cleaned = cleaned.replace(/\b([A-Za-z]{3,}[a-z])\s+(tion|tions|tive|tivities|tional)\b/gi, "$1$2");

  return cleaned;
}

type PdfTextItem = { str?: string; transform?: number[]; width?: number; height?: number; hasEOL?: boolean };

const mergeOverlappingText = (kept: string, incoming: string): string | null => {
  if (kept.includes(incoming)) return kept;
  if (incoming.includes(kept)) return incoming;
  for (let length = Math.min(kept.length, incoming.length) - 1; length >= 2; length -= 1) {
    if (kept.endsWith(incoming.slice(0, length))) return kept + incoming.slice(length);
  }
  return null;
};

/**
 * Collapses text drawn several times at almost the same spot (fake-bold headings in NCERT books
 * repeat "7.1 DO ORG", "7.1 DO ORGANISMS CREA", "ANISMS CREA", ... at sub-point offsets).
 */
export function mergeOverlappingPdfItems<T extends PdfTextItem>(items: T[]): T[] {
  const output: T[] = [];
  const seen = new Map<string, Array<{ x: number; y: number; size: number }>>();
  for (const item of items) {
    const str = item.str || "";
    if (str) {
      // Exact copies of an item at a sub-point offset, even when other items come in between.
      const [size = 10, , , , x = 0, y = 0] = item.transform || [];
      const positions = seen.get(str) || [];
      if (positions.some((position) => Math.abs(position.x - x) <= Math.abs(size) * 0.3 && Math.abs(position.y - y) <= Math.abs(size) * 0.3 && Math.abs(position.size - size) <= 0.5)) {
        continue;
      }
      seen.set(str, [...positions, { x, y, size }]);
    }
    let previousIndex = output.length - 1;
    while (previousIndex >= 0 && !output[previousIndex].str && !output[previousIndex].hasEOL) previousIndex -= 1;
    const previous = output[previousIndex];
    if (str && previous?.str) {
      const [size = 10, , , , x = 0, y = 0] = item.transform || [];
      const [previousSize = 10, , , , previousX = 0, previousY = 0] = previous.transform || [];
      const previousRight = previousX + (previous.width || 0);
      const overlaps = Math.abs(y - previousY) <= 2 &&
        Math.abs(Math.abs(size) - Math.abs(previousSize)) <= 0.5 &&
        x < previousRight - Math.abs(size) * 0.25 &&
        x >= previousX - Math.abs(size);
      const merged = overlaps ? mergeOverlappingText(previous.str, str) : null;
      if (merged !== null) {
        output[previousIndex] = {
          ...previous,
          str: merged,
          width: Math.max(previousRight, x + (item.width || 0)) - previousX,
          hasEOL: previous.hasEOL || item.hasEOL,
        };
        continue;
      }
    }
    output.push(item);
  }
  return output;
}

/**
 * Drops page furniture such as "Reprint 2026-27" or "Science 114" that sits at the same
 * position on most pages of a textbook.
 */
export function stripRepeatedPageItems<T extends PdfTextItem>(pages: T[][]): T[][] {
  if (pages.length < 3) return pages;
  const keyOf = (item: T) => {
    const text = (item.str || "").replace(/\d+/g, "#").replace(/\s+/g, " ").trim().toLowerCase();
    const y = Math.round((item.transform?.[5] || 0) / 4);
    return text ? `${text}@${y}` : "";
  };
  const pageCounts = new Map<string, number>();
  for (const page of pages) {
    for (const key of new Set(page.map(keyOf).filter(Boolean))) pageCounts.set(key, (pageCounts.get(key) || 0) + 1);
  }
  const threshold = Math.max(3, Math.ceil(pages.length * 0.4));
  return pages.map((page) => page.filter((item) => {
    const key = keyOf(item);
    return !key || (pageCounts.get(key) || 0) < threshold;
  }));
}

/**
 * Extracts readable text from every page of a PDF, cleaning duplicated headings and page stamps.
 */
export function joinPdfPages(pages: PdfTextItem[][]): string {
  return stripRepeatedPageItems(pages.map((items) => mergeOverlappingPdfItems(items)))
    .map((items) => joinPdfTextItems(items))
    .join("\n")
    .replace(/\bReprint\s+\d{4}\s*-\s*\d{2,4}\b/gi, "");
}

/**
 * Intelligently joins PDF.js text items using bounding coordinates instead of blind spaces.
 */
export function joinPdfTextItems(
  items: Array<{ str?: string; transform?: number[]; width?: number; height?: number; hasEOL?: boolean }>,
): string {
  let result = "";

  for (let i = 0; i < items.length; i += 1) {
    const current = items[i];
    const str = current.str || "";
    if (!str && !current.hasEOL) continue;

    result += str;

    if (current.hasEOL) {
      result += "\n";
      continue;
    }

    const next = items[i + 1];
    if (!next || !next.str) continue;

    // If current ends with whitespace or next starts with whitespace, no extra space needed
    if (/\s$/.test(str) || /^\s/.test(next.str)) continue;

    const currentTransform = current.transform || [];
    const nextTransform = next.transform || [];
    const currentX = currentTransform[4] || 0;
    const currentY = currentTransform[5] || 0;
    const currentWidth = current.width || 0;
    const nextX = nextTransform[4] || 0;
    const nextY = nextTransform[5] || 0;

    // Check if on different lines
    const yDiff = Math.abs(currentY - nextY);
    if (yDiff > 4) {
      result += " ";
      continue;
    }

    // Gap between current item right edge and next item left edge
    const gap = nextX - (currentX + currentWidth);
    const fontSize = currentTransform[0] ? Math.abs(currentTransform[0]) : (current.height || 10);

    // Only add a space if the horizontal gap is significantly larger than normal kerning
    if (gap > fontSize * 0.18) {
      result += " ";
    }
  }

  return cleanBrokenKerningWords(result.replace(/[ \t]+\n/g, "\n"));
}

const NUM_WORDS: Record<number, string> = {
  1: "ONE",
  2: "TWO",
  3: "THREE",
  4: "FOUR",
  5: "FIVE",
  6: "SIX",
  7: "SEVEN",
  8: "EIGHT",
  9: "NINE",
  10: "TEN",
};

export const toRomanNumeral = (num: number): string => {
  const roman: Array<[number, string]> = [
    [10, "x"],
    [9, "ix"],
    [8, "viii"],
    [7, "vii"],
    [6, "vi"],
    [5, "v"],
    [4, "iv"],
    [3, "iii"],
    [2, "ii"],
    [1, "i"],
  ];
  let res = "";
  let rem = num;
  for (const [v, r] of roman) {
    while (rem >= v) {
      res += r;
      rem -= v;
    }
  }
  return res || "i";
};

/**
 * Generates official CBSE-style General Instructions dynamically matching the exact pattern.
 */
export function generatePatternGeneralInstructions(
  sections: Array<{ label: string; questions: Array<{ marks?: number; kind?: string }> }>,
): string[] {
  const totalQuestions = sections.reduce((sum, s) => sum + s.questions.length, 0);
  const numSections = sections.length;
  const sectionWord = NUM_WORDS[numSections] || String(numSections);
  const sectionLetters = sections.map((s, i) => {
    const match = s.label.match(/\b([A-Za-z0-9]+)\b(?=\s*$)/);
    return match ? match[1] : String.fromCharCode(65 + i);
  });

  let sectionListStr = "";
  if (sectionLetters.length <= 2) {
    sectionListStr = `Section ${sectionLetters.join(" and ")}`;
  } else {
    sectionListStr = `Section ${sectionLetters.slice(0, -1).join(", ")} and ${sectionLetters[sectionLetters.length - 1]}`;
  }

  const instructions: string[] = [
    `This question paper consists of ${totalQuestions} questions. All questions are compulsory.`,
    `Question paper is divided into ${sectionWord} sections viz. ${sectionListStr}.`,
  ];

  let currentQNum = 1;
  for (let i = 0; i < sections.length; i += 1) {
    const sec = sections[i];
    const qCount = sec.questions.length;
    if (qCount === 0) continue;
    const startQ = currentQNum;
    const endQ = currentQNum + qCount - 1;
    const marks = sec.questions[0]?.marks || 1;
    const sLabel = sec.label.replace(/^section\s+/i, "Section ");

    let questionTypeDesc = "questions";
    if (marks === 1) questionTypeDesc = "Multiple Choice (MCQs) / Objective questions";
    else if (marks === 2) questionTypeDesc = "Very Short Answer type questions";
    else if (marks === 3) questionTypeDesc = "Short Answer type questions";
    else if (marks >= 4) questionTypeDesc = "Long Answer type questions";
    if (sec.questions.every((question) => question.kind === "case")) {
      questionTypeDesc = "source/case-based units of assessment";
    }

    const rangeStr = startQ === endQ ? `question number ${startQ} is` : `question numbers ${startQ} to ${endQ} are`;
    instructions.push(
      `In ${sLabel}, ${rangeStr} ${questionTypeDesc} carrying ${marks} mark${marks === 1 ? "" : "s"} each.`,
    );

    currentQNum += qCount;
  }

  instructions.push("There is no overall choice. However, internal choices have been provided in some questions.");
  instructions.push("Use of calculators is strictly prohibited unless specifically permitted.");

  return instructions;
}
