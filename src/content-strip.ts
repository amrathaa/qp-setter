import { PDFArray, PDFName, PDFRawStream, decodePDFRawStream, type PDFPage } from "pdf-lib";

type Matrix = [number, number, number, number, number, number];
type Token = { text: string; start: number; end: number; kind: "operand" | "operator" };
type Operation = { operator: string; operands: string[]; start: number; end: number };

const identity = (): Matrix => [1, 0, 0, 1, 0, 0];
const multiply = (m: Matrix, n: Matrix): Matrix => [
  m[0] * n[0] + m[1] * n[2],
  m[0] * n[1] + m[1] * n[3],
  m[2] * n[0] + m[3] * n[2],
  m[2] * n[1] + m[3] * n[3],
  m[4] * n[0] + m[5] * n[2] + n[4],
  m[4] * n[1] + m[5] * n[3] + n[5],
];

const isWhite = (code: number) => code === 0 || code === 9 || code === 10 || code === 12 || code === 13 || code === 32;
const isDelimiter = (char: string) => "()<>[]{}/%".includes(char);

// Splits a content stream into tokens, keeping strings, arrays and dictionaries intact as operands.
const tokenize = (source: string): Token[] | null => {
  const tokens: Token[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    if (isWhite(source.charCodeAt(index))) {
      index += 1;
      continue;
    }
    const start = index;
    if (char === "%") {
      while (index < source.length && source[index] !== "\n" && source[index] !== "\r") index += 1;
      continue;
    }
    if (char === "(") {
      let depth = 0;
      for (; index < source.length; index += 1) {
        const current = source[index];
        if (current === "\\") index += 1;
        else if (current === "(") depth += 1;
        else if (current === ")" && --depth === 0) break;
      }
      if (index >= source.length) return null;
      index += 1;
    } else if (char === "<" && source[index + 1] !== "<") {
      index = source.indexOf(">", index);
      if (index < 0) return null;
      index += 1;
    } else if (char === "[" || (char === "<" && source[index + 1] === "<")) {
      // Arrays and dictionaries: scan to the matching close, skipping strings inside.
      const open = char === "[" ? "[" : "<<";
      const close = char === "[" ? "]" : ">>";
      let depth = 0;
      while (index < source.length) {
        if (source[index] === "(") {
          let stringDepth = 0;
          for (; index < source.length; index += 1) {
            if (source[index] === "\\") index += 1;
            else if (source[index] === "(") stringDepth += 1;
            else if (source[index] === ")" && --stringDepth === 0) break;
          }
          index += 1;
          continue;
        }
        if (source.startsWith(open, index)) {
          depth += 1;
          index += open.length;
        } else if (source.startsWith(close, index)) {
          depth -= 1;
          index += close.length;
          if (depth === 0) break;
        } else index += 1;
      }
      if (depth !== 0) return null;
    } else if (char === "/") {
      index += 1;
      while (index < source.length && !isWhite(source.charCodeAt(index)) && !isDelimiter(source[index])) index += 1;
    } else {
      while (index < source.length && !isWhite(source.charCodeAt(index)) && !isDelimiter(source[index])) index += 1;
      if (index === start) index += 1;
      const word = source.slice(start, index);
      const isNumber = /^[+-]?(\d+\.?\d*|\.\d+)$/.test(word);
      const isKeyword = word === "true" || word === "false" || word === "null";
      tokens.push({ text: word, start, end: index, kind: isNumber || isKeyword ? "operand" : "operator" });
      continue;
    }
    tokens.push({ text: source.slice(start, index), start, end: index, kind: "operand" });
  }
  return tokens;
};

const toOperations = (tokens: Token[]): Operation[] | null => {
  const operations: Operation[] = [];
  let operands: Token[] = [];
  for (const token of tokens) {
    if (token.kind === "operand") {
      operands.push(token);
      continue;
    }
    // Inline images carry raw binary data that this parser cannot step over safely.
    if (token.text === "BI" || token.text === "ID") return null;
    operations.push({
      operator: token.text,
      operands: operands.map((operand) => operand.text),
      start: operands[0]?.start ?? token.start,
      end: token.end,
    });
    operands = [];
  }
  return operations;
};

const readStreams = (page: PDFPage) => {
  const contents = page.node.Contents();
  const entries = contents instanceof PDFArray
    ? contents.asArray().map((entry) => page.doc.context.lookup(entry))
    : [contents];
  const decoded: string[] = [];
  for (const entry of entries) {
    if (!(entry instanceof PDFRawStream)) return null;
    const bytes = decodePDFRawStream(entry).decode();
    let text = "";
    for (let index = 0; index < bytes.length; index += 1) text += String.fromCharCode(bytes[index]);
    decoded.push(text);
  }
  return decoded.join("\n");
};

const textShowing = new Set(["Tj", "TJ", "'", '"']);
const positioning = new Set(["Td", "TD", "Tm", "T*"]);

/**
 * Removes the page's original text-drawing operations whose start point `shouldRemove` accepts,
 * so covered-up blueprint text no longer survives in the PDF's text layer.
 * Text is only removed where the text after it on the same line is positioned independently,
 * so nothing that stays visible can shift. Returns false and leaves the page untouched if its
 * content cannot be parsed safely.
 */
export function stripPageText(page: PDFPage, shouldRemove: (x: number, y: number) => boolean): boolean {
  try {
    const source = readStreams(page);
    if (source === null) return false;
    const tokens = tokenize(source);
    const operations = tokens && toOperations(tokens);
    if (!operations) return false;

    // Pass 1: where each text-showing operation starts on the page.
    const stack: Array<{ ctm: Matrix; leading: number }> = [];
    let ctm = identity();
    let leading = 0;
    let lineMatrix = identity();
    let textMatrix = identity();
    let block = 0;
    const blockOf = new Map<Operation, number>();
    const candidates = new Set<Operation>();
    const nextLine = () => {
      lineMatrix = multiply([1, 0, 0, 1, 0, -leading], lineMatrix);
      textMatrix = lineMatrix;
    };
    for (const operation of operations) {
      const numbers = operation.operands.map(Number);
      switch (operation.operator) {
        case "q": stack.push({ ctm, leading }); break;
        case "Q": ({ ctm, leading } = stack.pop() || { ctm: identity(), leading: 0 }); break;
        case "cm": if (numbers.length === 6) ctm = multiply(numbers as Matrix, ctm); break;
        case "BT": block += 1; lineMatrix = identity(); textMatrix = identity(); break;
        case "TL": leading = numbers[0] || 0; break;
        case "Tm": if (numbers.length === 6) { lineMatrix = numbers as Matrix; textMatrix = lineMatrix; } break;
        case "Td": case "TD":
          if (operation.operator === "TD") leading = -(numbers[1] || 0);
          lineMatrix = multiply([1, 0, 0, 1, numbers[0] || 0, numbers[1] || 0], lineMatrix);
          textMatrix = lineMatrix;
          break;
        case "T*": nextLine(); break;
        case "'": case '"': nextLine(); break;
      }
      if (textShowing.has(operation.operator)) {
        blockOf.set(operation, block);
        const origin = multiply(textMatrix, ctm);
        if (shouldRemove(origin[4], origin[5])) candidates.add(operation);
      }
    }
    if (!candidates.size) return true;

    // Pass 2 (backwards): drop a candidate only if no kept text later in its line depends on its advance.
    const removals: Array<{ operation: Operation; replacement: string }> = [];
    let keptTextAhead = false;
    let currentBlock = -1;
    for (let index = operations.length - 1; index >= 0; index -= 1) {
      const operation = operations[index];
      if (operation.operator === "ET" || operation.operator === "BT") keptTextAhead = false;
      if (positioning.has(operation.operator)) keptTextAhead = false;
      if (!textShowing.has(operation.operator)) continue;
      const thisBlock = blockOf.get(operation) ?? -1;
      if (thisBlock !== currentBlock) {
        currentBlock = thisBlock;
        keptTextAhead = false;
      }
      if (candidates.has(operation) && !keptTextAhead) {
        // ' and " also move to the next line, so that movement is kept.
        const replacement = operation.operator === "'"
          ? "T*"
          : operation.operator === '"'
            ? `${operation.operands[0]} Tw ${operation.operands[1]} Tc T*`
            : "";
        removals.push({ operation, replacement });
      } else {
        keptTextAhead = true;
      }
      // Text before a ' or " is on the previous line, so it never depends on what follows.
      if (operation.operator === "'" || operation.operator === '"') keptTextAhead = false;
    }
    if (!removals.length) return true;

    let output = source;
    for (const { operation, replacement } of removals.sort((a, b) => b.operation.start - a.operation.start)) {
      output = `${output.slice(0, operation.start)}${replacement}${output.slice(operation.end)}`;
    }
    const bytes = new Uint8Array(output.length);
    for (let index = 0; index < output.length; index += 1) bytes[index] = output.charCodeAt(index) & 0xff;
    const stream = page.doc.context.flateStream(bytes);
    page.node.set(PDFName.of("Contents"), page.doc.context.register(stream));
    return true;
  } catch {
    return false;
  }
}
