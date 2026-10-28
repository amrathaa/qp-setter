/**
 * Finds a textbook's section headings ("7.2.1 Fission") to offer as topics.
 */
export const findTopics = (text: string): string[] => {
  const lines = text
    .split(/\r?\n/)
    .map((line) =>
      line
        .replace(/\s*\.\s*/g, ".")
        .replace(/\s+/g, " ")
        .trim(),
    )
    // Two headings printed on one line ("3.1 PHYSICAL PROPERTIES 3.1.1 Metals") become two lines.
    .flatMap((line) => (/^\d+\.\d+/.test(line) ? line.split(/\s(?=\d+\.\d+(?:\.\d+)*\s+[A-Z])/) : [line]))
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
        next && current.length >= 3 && current.length <= 7 &&
        next.length >= 3 && next.length <= 8 &&
        /^[A-Z]+$/.test(current) && /^[A-Z]+$/.test(next) && repeats
      ) {
        mergedWords.push(`${current}${next}`);
        index += 1;
      } else mergedWords.push(current);
    }
    words = mergedWords;
    let changed = true;
    while (changed) {
      changed = false;
      for (let index = 0; index < words.length - 1; index += 1) {
        for (
          let blockLength = Math.min(12, Math.floor((words.length - index) / 2));
          blockLength >= 2;
          blockLength -= 1
        ) {
          const first = words.slice(index, index + blockLength).join(" ").toLowerCase();
          const second = words.slice(index + blockLength, index + blockLength * 2).join(" ").toLowerCase();
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
      if (cleanedWords.length === 0 || word.toLowerCase() !== cleanedWords[cleanedWords.length - 1].toLowerCase())
        cleanedWords.push(word);
    }
    return cleanedWords.join(" ").slice(0, 200).trim();
  };
  // A heading that wraps ("3.4.5 Extracting Metals towards the Top of the" / "Activity Series")
  // continues on the next line when it ends on a small word or the next line closes a question.
  const continuation = (label: string, next: string | undefined) =>
    !!next && next.length <= 60 && !/^\d/.test(next) && /^[A-Z]/.test(next) && !/[.?!]$/.test(label) &&
    (/\b(the|of|and|or|in|on|to|for|with|a|an|by|from|into|towards)$/i.test(label) ||
      (/^(how|what|why|when|where|which|do|does|is|are|can)\b/i.test(label) && /\?$/.test(next)));

  const parseHeadings = (allowUndotted: boolean) => lines.flatMap((line, index) => {
    const match = line.match(/^(?:chapter\s+)?(\d+(?:\.\d+)*)(?:[.)])?\s+(.+)$/i);
    if (
      !match ||
      // Table rows and activity steps ("1 Saliva", "6 Coffee") use plain numbers; section headings are dotted.
      (!allowUndotted && !match[1].includes(".")) ||
      (chapterNumbers.size > 0 && !chapterNumbers.has(match[1].split(".")[0])) ||
      excludedLabel.test(match[2]) ||
      excludedLabel.test(line.slice(0, match.index || 0))
    ) return [];
    const marker = match[1];
    let label = cleanHeading(match[2]);
    if (continuation(label, lines[index + 1])) label = `${label} ${lines[index + 1]}`;
    if (
      // Headings start with a capital or a term like "pH" ("3.10 mL of a solution..." is a measurement).
      !/^([A-Z]|[a-z][A-Z])/.test(label) || /^(mL|mg|kg|cm|mm|km|kJ|mA|mV|kW|g|L|K)\b/.test(label) ||
      /[.!]$/.test(label) || label.split(" ").length > 30 ||
      // Exercise questions ("1. What is...") are not headings, but "2.1.2 How do Acids..." is.
      (/^(what|which|how|why|when|where|define|state|explain|describe|give|list|identify)\b/i.test(label) && /^\d+[.)]\s/.test(line))
    ) return [];
    return [`${marker} ${label}`];
  });
  const dotted = parseHeadings(false);
  const numberedHeadings = dotted.length ? dotted : parseHeadings(true);
  if (numberedHeadings.length > 0)
    return [...new Map(numberedHeadings.map((heading) => [heading.split(" ")[0], heading])).values()]
      .sort((first, second) => {
        const firstNumbers = first.split(" ")[0].split(".").map(Number);
        const secondNumbers = second.split(" ")[0].split(".").map(Number);
        for (let index = 0; index < Math.max(firstNumbers.length, secondNumbers.length); index += 1) {
          const difference = (firstNumbers[index] || 0) - (secondNumbers[index] || 0);
          if (difference !== 0) return difference;
        }
        return 0;
      })
      .slice(0, 40);
  const minorWords = new Set(["a", "an", "the", "of", "in", "on", "to", "and", "or", "for", "is", "are", "with"]);
  const isTitleCase = (line: string) => line.split(" ").every(
    (word) => minorWords.has(word.toLowerCase()) || /^[A-Z][A-Za-z'()-]*$/.test(word),
  );
  const fallbackHeadings: string[] = [];
  for (const line of lines) {
    const wordCount = line.split(" ").length;
    if (
      wordCount < 2 || wordCount > 12 || /[.!?,;:]$/.test(line) || /\d/.test(line) ||
      excludedLabel.test(line) || /\b(chapter|section|unit|lesson)\b/i.test(line)
    ) continue;
    if (!(/[A-Z]/.test(line) && line === line.toUpperCase()) && !isTitleCase(line)) continue;
    const heading = cleanHeading(line);
    if (!fallbackHeadings.some((item) => item.toLowerCase() === heading.toLowerCase()))
      fallbackHeadings.push(heading);
    if (fallbackHeadings.length === 30) break;
  }
  return fallbackHeadings;
};
