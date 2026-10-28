// A word matches a keyword word when it is the same or a close form of it ("cell"/"cells").
const sameWord = (word: string, key: string) => {
  const plain = word.toLowerCase().replace(/[^a-z0-9-]/g, "");
  return plain.length > 1 && (plain === key || (plain.startsWith(key) && plain.length - key.length <= 2) || (key.startsWith(plain) && key.length - plain.length <= 1));
};

/**
 * Which of `words` belong to a keyword or key phrase ("metal oxide"), so the answer key and the
 * review screen highlight the same words.
 */
export function keywordMask(words: string[], keywords: string[]): boolean[] {
  const phrases = keywords
    .map((keyword) => keyword.trim().toLowerCase().split(/\s+/).filter(Boolean))
    .filter((phrase) => phrase.length > 0);
  const mask = words.map(() => false);
  words.forEach((_, index) => {
    for (const phrase of phrases) {
      if (phrase.every((part, offset) => index + offset < words.length && sameWord(words[index + offset], part))) {
        phrase.forEach((_, offset) => { mask[index + offset] = true; });
      }
    }
  });
  return mask;
}
