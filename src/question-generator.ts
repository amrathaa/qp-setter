import type { GeneratedQuestion, GeneratedSection } from "./blueprint";
import { cleanBrokenKerningWords } from "./text-cleaner";
import { findTopics, headingContinues } from "./topic-finder";

export interface QuestionGeneratorOptions {
  textbookText: string;
  selectedTopics: string[];
  difficulty: "Easy" | "Moderate" | "Advanced" | "Application" | string;
  patternSections: Array<{ count: number; marks: number; label?: string; caseBased?: boolean; mcq?: boolean }>;
}

/** CBSE's source/case-based items carry 4 marks, so 4-mark sections default to case-based. */
export const isCaseBasedSection = (section: { marks: number; caseBased?: boolean }) =>
  section.caseBased ?? section.marks === 4;

/** 1-mark sections default to four-option MCQs; the teacher can turn that off, or on for any other section. */
export const isMcqSection = (section: { marks: number; caseBased?: boolean; mcq?: boolean }) =>
  !isCaseBasedSection(section) && (section.mcq ?? section.marks === 1);

// Sentences that only make sense inside the textbook's own narration ("Let us...", "Can you think...").
const narrationPattern = /\([a-d]\)|^(it|this|these|that|those|they|he|she|we|let|can|think|but|and|or|so|now|here|on the other hand|however|such|therefore|thus|hence|similarly|also|compare|observe|take|find|look|draw|discuss|try|note|see|place|collect|consider|imagine|arrange|for this|make sure|ensure|never|always|do not|now|add|put|mix|pour|heat|dip|stir|repeat|record|cover|balance|name|state|give|write|explain|define|list|identify|describe|mention|what|which|why|how)\b|\bto think of\b|\b(we|us|our|you|your|let's)\b|\b(classroom|next chapter|previous chapter|class\s+(?:ix|viii|x)|activity|activities|figure|fig\.)|\b(chapter|section|table)\s+\d|\b(following sections?|explained in detail|table above)\b/i;

// Chemical equations lose their subscripts in PDF text ("CaCO s Ca(HCO aq3 3( ) )"), so they are left out.
const garbledEquation = (sentence: string) => {
  if (/→|←|⇌|\(\s*\)|\((?:aq|s|l|g)\)/.test(sentence)) return true;
  const tokens = sentence.split(/\s+/);
  // Short English words ("in", "it", "to") are not formula fragments.
  const fragment = (token: string) => /^[A-Za-z0-9()+–-]{1,2}$/.test(token) && !/^(a|an|as|at|be|by|do|he|if|in|is|it|no|of|on|or|so|to|up|us|we)$/i.test(token);
  return tokens.filter(fragment).length / tokens.length > 0.25;
};

/**
 * Extracts clean sentences from raw textbook text for question drafting.
 */
export function extractCleanSentences(text: string): string[] {
  // These are quoted inside questions, so very long sentences are left to the model answers.
  const sentences = extractTextbookSentences(text).filter((sentence) => sentence.length <= 220);
  // Prefer self-contained factual statements; fall back to everything if a chapter is too short.
  const factual = sentences.filter((sentence) => /\.$/.test(sentence) && !narrationPattern.test(sentence));
  return factual.length >= 10 ? factual : sentences;
}

/**
 * All readable sentences in textbook order (used to cut out case-study passages).
 * Question boxes, exercises, activity steps, captions and headings are left out.
 */
export function extractTextbookSentences(text: string): string[] {
  return readTextbook(text).sections.flatMap((section) => section.sentences);
}

type TextbookSection = { marker: string; sentences: string[] };

const headingLine = /^\s*(\d+(?:\s?\.\s?\d+)+)\s+([A-Z][A-Za-z].*)$/;
// "n" is how NCERT's bullet glyph comes out of the PDF.
const bulletLine = /^\s*[n•▪●◦]\s+\S/;
const captionLine = /^\s*(?:figure|fig\.?|table)\s*\d/i;
// Numbered questions ("2. Why do ionic compounds...", "(ii) Show the formation...") are not chapter content.
const promptLine = /^\s*(?:\d{1,2}[.)]\s+|\(\s?[ivx]+\s?\)\s*)(?:\(?[a-z]\)\s*)?(?:what|which|how|why|when|where|who|give|explain|define|state|name|list|describe|write|differentiate|distinguish|compare|suggest|account|draw|show|identify|mention|can|do|does|is|are|an?|the)\b/i;
const boxHeader = (line: string) => {
  const letters = line.replace(/[\s?]/g, "").toUpperCase();
  return letters === "QUESTIONS" ? "questions" : /^EXERCISES?$/.test(letters) ? "exercises" : letters === "WHATYOUHAVELEARNT" ? "summary" : null;
};

const textbookCache = new Map<string, { sections: TextbookSection[] }>();

/**
 * Splits a textbook into its numbered sections ("3.4.2 Enrichment of Ores" up to the next heading),
 * each with its readable sentences.
 */
function readTextbook(text: string): { sections: TextbookSection[] } {
  const cached = textbookCache.get(text);
  if (cached) return cached;
  const markers = new Set(findTopics(text).map((topic) => topic.split(" ")[0]).filter((marker) => marker.includes(".")));
  const chapters = new Set([...markers].map((marker) => marker.split(".")[0]));
  const lines = text
    .split(/\r?\n/)
    // Two headings printed on one line ("3.1 PHYSICAL PROPERTIES 3.1.1 Metals") become two lines.
    .flatMap((line) => (headingLine.test(line) ? line.split(/\s(?=\d+\.\d+(?:\.\d+)*\s+[A-Z])/) : [line]));

  const sections: Array<{ marker: string; lines: string[] }> = [{ marker: "", lines: [] }];
  let skipping: "questions" | "exercises" | "summary" | null = null;
  let skipped = 0;
  let inItem = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const heading = line.match(headingLine);
    const marker = heading?.[1].replace(/\s/g, "");
    // Known topics, plus deeper headings of the same chapter that the topic list left out.
    if (heading && marker && (markers.has(marker) || (chapters.has(marker.split(".")[0]) && marker.split(".").length <= 4))) {
      sections.push({ marker, lines: [] });
      skipping = null;
      inItem = false;
      if (headingContinues(heading[2].trim(), lines[index + 1]?.trim())) index += 1;
      continue;
    }
    const box = boxHeader(line);
    if (box) {
      skipping = box;
      skipped = 0;
      continue;
    }
    // A question box runs to the next heading, or a little way when prose resumes in the same section.
    if (skipping === "questions" && (skipped += 1) > 25) skipping = null;
    const current = sections[sections.length - 1].lines;
    // Text either side of a removed line must not be read as one sentence.
    const drop = () => {
      if (current[current.length - 1] !== sentenceBreak) current.push(sentenceBreak);
    };
    if (skipping) {
      drop();
      continue;
    }
    const trimmed = line.trim();
    const tokens = trimmed.split(/\s+/);
    const ends = (value?: string) => !value?.trim() || /[.!?:]$/.test(value.trim());
    if (
      // Equations ("Metal + Water → Metal oxide + Hydrogen") and the pieces of formulas ("Na Na + e").
      /[→←⇌⎯]/.test(line) || (tokens.length >= 2 && tokens.filter((token) => /^[A-Za-z0-9()+–-]{1,2}$/.test(token)).length / tokens.length > 0.5) ||
      // A box or figure title ("Iron pillar at Delhi") stands alone between finished sentences.
      (!!trimmed && tokens.length <= 7 && !ends(trimmed) && ends(lines[index - 1]) && /^\s*[A-Z]/.test(lines[index + 1] || ""))
    ) {
      drop();
      continue;
    }
    if (bulletLine.test(line) || promptLine.test(line) || captionLine.test(line)) {
      inItem = true;
      drop();
      continue;
    }
    // Wrapped lines of a bullet, question or caption start in lower case.
    if (inItem && /^\s*[a-z(]/.test(line)) continue;
    inItem = false;
    // Table columns ("K", "Na", "Reduction using carbon") are runs of three or more very short lines;
    // a narrow side box ("physicist Meghnad Saha") has short lines too, but not that many in a row.
    const short = (offset: number) => {
      const value = lines[index + offset]?.trim();
      return !!value && value.split(/\s+/).length <= 3 && !/[.!?:,]$/.test(value);
    };
    if (short(0) && ((short(-1) && short(1)) || (short(1) && short(2)) || (short(-1) && short(-2)))) {
      drop();
      continue;
    }
    current.push(line);
  }

  const result = {
    sections: sections.map((section) => ({ marker: section.marker, sentences: splitSentences(section.lines.join("\n")) })),
  };
  if (textbookCache.size > 6) textbookCache.clear();
  textbookCache.set(text, result);
  return result;
}

const sentenceBreak = "§";

function splitSentences(text: string): string[] {
  return text
    .replace(/([A-Za-z])-\s+([a-z])/g, "$1-$2")
    .split(/(?<=[.!?])\s+|\s*§\s*/)
    .map((sentence) => cleanBrokenKerningWords(sentence.replace(/\s+/g, " ").trim()))
    .filter(
      (sentence) =>
        sentence.length >= 35 &&
        sentence.length <= 320 &&
        !/^(activity|figure|fig\.?|table|question|exercise|page|chapter)\b/i.test(sentence) &&
        !/\bReprint\s+\d{4}/i.test(sentence) &&
        !garbledEquation(sentence) &&
        /^[A-Z]/.test(sentence) &&
        /[a-zA-Z]{3,}/.test(sentence),
    );
}

const minorTitleWords = new Set(["a", "an", "the", "of", "in", "on", "to", "and", "or", "for", "by", "with", "at"]);

/**
 * Clean a topic name by stripping leading numbers and markers ("7.3 SEXUAL REPRODUCTION" -> "Sexual Reproduction").
 */
export function cleanTopicName(topic: string): string {
  const name = topic.replace(/^\d+(?:\.\d+)*\s*(?:\([a-z]\)\s*)?/i, "").replace(/[.:]$/, "").trim();
  if (/[a-z]/.test(name)) return name;
  return name
    .toLowerCase()
    .split(" ")
    .map((word, index) => (index > 0 && minorTitleWords.has(word) ? word : word.charAt(0).toUpperCase() + word.slice(1)))
    .join(" ")
    .replace(/\bDna\b/g, "DNA");
}

/**
 * A heading phrased as a question ("3.2.2 What happens when Metals react with Water?") in sentence
 * case, so it can be asked directly; null for ordinary headings. Terms like "pH" or "DNA" keep their capitals.
 */
export const askedHeading = (topicRaw: string): string | null => {
  const heading = cleanTopicName(topicRaw);
  if (!/\?$/.test(heading)) return null;
  return heading
    .split(" ")
    .map((word, index) => {
      if (index === 0) return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
      return /[A-Z]/.test(word.slice(1)) ? word : word.toLowerCase();
    })
    .join(" ");
};

// Topics are dropped mid-sentence ("Explain the importance of variation"), so a leading article is lower-cased.
const topicForSentence = (topicRaw: string) =>
  (cleanTopicName(topicRaw) || "the key concept")
    // "Understanding the Chemical Properties of..." / "More About Salts" read as their subject.
    .replace(/^(understanding|introduction to|more about|about)\s+(the\s+)?/i, "")
    .replace(/^(The|A|An)\s/, (article) => article.toLowerCase());

const commonWords = new Set(`activity activities chapter figure similarly table contains provides includes requires involves produces becomes remains appears occurs depends consists forms gives takes shows uses aboutabove after again against almost along already also although always among another answer anything around because become becomes been before being below between beyond both called cannot cases certain change changes common could different does doing done during each early either enough especially even every example fact first following form found from further given great happen happens having however important instance into itself known large larger later least less level like likely little made main make makes making many might more most much must namely nature necessary need needs never number often only other others otherwise over part particular parts place possible present process processes produce produced rather really reason result same seen several shall should show shown similar simple since single small some something sometimes specific still such take taken than that their them themselves then there therefore these they thing things think this those though three through thus time together turn under until upon used useful using usually various very what when where whether which while whole whose will with within without would years`.split(/\s+/));

type KeyTerm = { term: string; proper: boolean; score: number };
const vocabularyCache = new WeakMap<string[], Map<string, KeyTerm>>();

// Builds the chapter's key terms (Hydra, Plasmodium, fission, chromosomes, ...) used as blanks and distractors.
function keyTermVocabulary(sentences: string[]): Map<string, KeyTerm> {
  const cached = vocabularyCache.get(sentences);
  if (cached) return cached;
  const counts = new Map<string, { count: number; properCount: number; surface: string }>();
  const allWords = new Set(sentences.flatMap((sentence) => (sentence.toLowerCase().match(/[a-z]+/g) || [])));
  // "develops"/"grows" are verbs when the chapter also uses "developed"/"growing".
  const looksLikeVerb = (key: string) => {
    if (!/[^s]s$/.test(key)) return false;
    const base = key.slice(0, -1);
    return [`${base}ed`, `${base}ing`, `${base.replace(/e$/, "")}ing`, `${base}d`].some((form) => allWords.has(form));
  };
  for (const sentence of sentences) {
    const words = sentence.match(/[A-Za-z][A-Za-z-]*[A-Za-z]/g) || [];
    words.forEach((word, index) => {
      const key = word.toLowerCase();
      if (key.length < 5 || commonWords.has(key) || /-$/.test(key)) return;
      const entry = counts.get(key) || { count: 0, properCount: 0, surface: word };
      entry.count += 1;
      if (index > 0 && /^[A-Z]/.test(word)) {
        entry.properCount += 1;
        entry.surface = word;
      }
      counts.set(key, entry);
    });
  }
  const vocabulary = new Map<string, KeyTerm>();
  for (const [key, entry] of counts) {
    // Proper names are single capitalised words (Hydra, Plasmodium), not "DNA-copying".
    const proper = entry.properCount > 0 && entry.properCount === entry.count && /^[A-Z][a-z]+$/.test(entry.surface);
    // Technical terms recur a few times; very frequent words are usually generic.
    if (entry.count > 25 || (!proper && entry.count < 2)) continue;
    // Blanks and options should be nouns; skip adverb/verb/adjective-looking words.
    if (!proper && (/(?:ly|ed|ing|ive|ous|ful|able|ible|ent|ant|ise|ize|ate|al|ic|ar|ian|ens)$/.test(key) || looksLikeVerb(key))) continue;
    const score = (proper ? 3 : 0) + (key.length >= 8 ? 1 : 0) +
      (/(?:tion|sis|ism|ule|ome|cell|gen|ploid|ium|cyte|phyll|ospore)s?$/.test(key) ? 1.5 : 0) +
      Math.min(entry.count, 6) * 0.2 - (entry.count > 12 ? 1.5 : 0);
    vocabulary.set(key, { term: proper ? entry.surface : key, proper, score });
  }
  vocabularyCache.set(sentences, vocabulary);
  return vocabulary;
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * For textbooks too short for fill-in-the-blank MCQs: "Which statement is about <topic>?", with the correct
 * statement from the topic's own section and the others from other sections that share no key words with the
 * topic or the correct statement, so none of them can also be right. Without the topic's section it gives up.
 */
function buildStatementMcq(
  topic: string,
  sourceSentence: string,
  ownSentences: string[],
  allSentences: string[],
  seed: number,
  usedSentences: Set<string>,
) {
  if (ownSentences.length === 0) return null;
  const readable = (sentence: string) => sentence.length >= 25 && sentence.length <= 200;
  const topicWords = [...contentWords(topic)];
  const mentionsTopic = (sentence: string) => topicWords.some((word) => contentWords(sentence).has(word));
  const own = new Set(ownSentences);
  const correct = [sourceSentence, ...ownSentences, ...allSentences.filter(mentionsTopic)]
    .find((sentence) => sentence && readable(sentence) && (own.has(sentence) || mentionsTopic(sentence)) && !usedSentences.has(sentence));
  if (!correct) return null;
  const correctWords = contentWords(correct);
  const others = allSentences.filter((sentence) =>
    readable(sentence) &&
    sentence !== correct &&
    !own.has(sentence) &&
    !mentionsTopic(sentence) &&
    ![...contentWords(sentence)].some((word) => correctWords.has(word)));
  if (others.length < 3) return null;
  const distractors: string[] = [];
  for (let offset = 0; offset < others.length && distractors.length < 3; offset += 1) {
    const candidate = others[(seed * 3 + offset) % others.length];
    if (!distractors.includes(candidate)) distractors.push(candidate);
  }
  const options = [correct, ...distractors];
  const shift = seed % 4;
  return { answer: correct, options: [...options.slice(shift), ...options.slice(0, shift)] };
}

/**
 * Turns a textbook sentence into a fill-in-the-blank MCQ whose options are all chapter key terms.
 */
function buildClozeMcq(sentence: string, allSentences: string[], seed: number) {
  const vocabulary = keyTermVocabulary(allSentences);
  const words = sentence.match(/[A-Za-z][A-Za-z-]*[A-Za-z]/g) || [];
  const stemOf = (word: string) => word.toLowerCase().slice(0, 5);
  // A term that appears twice in the sentence (or as a variant) would give the answer away.
  const answer = words
    .filter((word) => words.filter((other) => stemOf(other) === stemOf(word)).length === 1)
    .map((word) => vocabulary.get(word.toLowerCase()))
    .filter((entry): entry is KeyTerm => !!entry)
    .sort((a, b) => b.score - a.score)[0];
  if (!answer || answer.score < 1) return null;

  const sentenceWords = new Set(words.map((word) => word.toLowerCase()));
  const isPlural = (word: string) => /[^s]s$/.test(word.toLowerCase());
  // "cells" and "germ-cells" could both fit the blank, so terms containing one another are not offered together.
  const overlaps = (a: string, b: string) => {
    const [x, y] = [a.toLowerCase(), b.toLowerCase()];
    return x.includes(y) || y.includes(x);
  };
  const pool = [...vocabulary.values()]
    .filter((entry) =>
      entry.proper === answer.proper &&
      (entry.proper || isPlural(entry.term) === isPlural(answer.term)) &&
      !sentenceWords.has(entry.term.toLowerCase()) &&
      stemOf(entry.term) !== stemOf(answer.term) &&
      !overlaps(entry.term, answer.term) &&
      entry.score >= 1)
    .sort((a, b) => b.score - a.score || a.term.localeCompare(b.term));
  const distractors: string[] = [];
  for (let offset = 0; offset < pool.length && distractors.length < 3; offset += 1) {
    const candidate = pool[(seed * 5 + offset) % pool.length].term;
    if (!distractors.some((term) => stemOf(term) === stemOf(candidate) || overlaps(term, candidate))) distractors.push(candidate);
  }
  if (distractors.length < 3) return null;

  const blankPattern = new RegExp(`\\b${escapeRegExp(answer.term)}\\b`, "i");
  const blankAtStart = sentence.search(blankPattern) === 0;
  const stem = sentence.replace(blankPattern, "________");
  const display = (term: string) => (blankAtStart ? term.charAt(0).toUpperCase() + term.slice(1) : term);
  const options = [answer.term, ...distractors].map(display);
  const shift = seed % 4;
  return { stem, answer: display(answer.term), options: [...options.slice(shift), ...options.slice(0, shift)] };
}

/**
 * Generates an individual question given a topic, sentence, marks, and difficulty.
 * Written questions carry the textbook sentence they were built from as their marking point.
 */
export function generateSingleQuestion(
  topicRaw: string,
  sourceSentenceRaw: string,
  marks: number,
  difficulty: string,
  questionIndex: number,
  allSentences: string[],
  usedSentences: Set<string> = new Set(),
  // The full textbook text, so topic-level answers can come from the topic's own section.
  textbookText = "",
  mcq = marks === 1,
): GeneratedQuestion {
  const question = draftQuestion(
    topicRaw, sourceSentenceRaw, marks, difficulty, questionIndex, allSentences, usedSentences, mcq,
    mcq ? (topicSectionSentences(textbookText, topicRaw).length ? topicSectionSentences(textbookText, topicRaw) : headingSectionSentences(textbookText, topicRaw)) : [],
  );
  if (question.options) return question;
  // Written questions get a model answer taken from the textbook, with its key terms.
  const source = sourceSentenceRaw.trim();
  const model = textbookModelAnswer(textbookText, marks, source, topicRaw, allSentences) ||
    (source ? buildModelAnswer(allSentences, marks, source, topicRaw) : null) ||
    buildModelAnswer(allSentences, marks, "", topicRaw);
  const withAnswer: GeneratedQuestion = model
    ? { ...question, answer: model.answer, answerKeywords: model.keywords }
    : question;
  if (question.alternative && question.alternativeAnswer) {
    const altModel = textbookModelAnswer(textbookText, marks, question.alternativeAnswer, undefined, allSentences) ||
      buildModelAnswer(allSentences, marks, question.alternativeAnswer);
    if (altModel) return { ...withAnswer, alternativeAnswer: altModel.answer, alternativeKeywords: altModel.keywords };
  }
  return withAnswer;
}

/** How many textbook sentences a full-marks answer usually needs. */
const answerLength = (marks: number) => (marks <= 2 ? 2 : marks === 3 ? 3 : marks === 4 ? 4 : 5);

/**
 * A model answer made of textbook sentences: the question's source sentence and the sentences
 * that follow it on the same idea, or (with no source) the chapter's sentences about the topic.
 * Returns the key terms a marker should look for alongside it.
 */
export function buildModelAnswer(
  allSentences: string[],
  marks: number,
  anchor: string,
  topicRaw?: string,
  // Restricts the answer to these sentences (a case-based passage); defaults to the whole chapter.
  pool: string[] = allSentences,
): { answer: string; keywords: string[] } | null {
  const vocabulary = keyTermVocabulary(allSentences);
  const termsOf = (sentence: string) =>
    new Set((sentence.match(/[A-Za-z][A-Za-z-]*[A-Za-z]/g) || [])
      .map((word) => word.toLowerCase())
      .filter((word) => (vocabulary.get(word)?.score || 0) >= 1));
  const wanted = answerLength(marks);
  // Words found all over the chapter ("organisms", "reproduction") say nothing about what a sentence is about.
  const lowerChapter = allSentences.map((sentence) => sentence.toLowerCase());
  const specific = (word: string) => lowerChapter.filter((sentence) => sentence.includes(word)).length <= 8;
  // Only the topic's most distinctive word decides what is "about the topic"; a shorter answer beats an off-topic one.
  const keyWord = topicRaw ? topicKeyWord(topicRaw, pool) : undefined;
  const aboutTopic = (sentence: string) => !!keyWord && sentence.toLowerCase().includes(keyWord);
  const picked: string[] = [];
  const start = anchor ? pool.indexOf(anchor) : -1;
  if (start >= 0) {
    // The anchor and the sentences right after it that stay on its subject: they must share one of
    // its specific terms (not a general word like "organisms"), and one off-topic sentence ends the run.
    const anchorTerms = new Set([...termsOf(anchor)].filter((term) => (vocabulary.get(term)?.score || 0) >= 2 && specific(term)));
    picked.push(anchor);
    let misses = 0;
    for (let index = start + 1; index < pool.length && picked.length < wanted && misses < 2; index += 1) {
      const sentence = pool[index];
      const shares = [...termsOf(sentence)].some((term) => anchorTerms.has(term)) || aboutTopic(sentence);
      if (shares) picked.push(sentence);
      else misses += 1;
    }
  } else if (anchor) {
    picked.push(anchor);
  }
  // Top up from anywhere in the chapter that discusses the topic.
  if (keyWord) {
    for (const sentence of pool) {
      if (picked.length >= wanted) break;
      if (!picked.includes(sentence) && aboutTopic(sentence)) picked.push(sentence);
    }
  }
  if (!picked.length) return null;
  // Keep the textbook's order so the answer reads as a paragraph.
  picked.sort((a, b) => pool.indexOf(a) - pool.indexOf(b));

  return { answer: picked.join(" "), keywords: answerKeywordsFor(picked, marks, allSentences, keyWord) };
}

// Words that are nouns but say nothing a marker could look for.
const genericAnswerWords = new Set(("basis towards example examples property properties amount amounts method methods type types kind kinds manner order ways steps step category categories presence absence thing things means purpose purposes reaction reactions element elements compound compounds substance substances temperature solution solutions india " +
  "indicate indicates suggest suggests represent represents satisfy satisfies assign assigns remove removes approach difficult simplifies section sections painful smaller larger world conditions generate").split(" "));

/**
 * The key terms a marker looks for in an answer, in the order they appear: technical terms and
 * two-word phrases ("metal oxide", "reactivity series") that are specific to this part of the chapter.
 */
function answerKeywordsFor(picked: string[], marks: number, allSentences: string[], keyWord?: string): string[] {
  const vocabulary = keyTermVocabulary(allSentences);
  const lowerChapter = allSentences.map((sentence) => sentence.toLowerCase());
  const frequency = (term: string) => lowerChapter.filter((sentence) => sentence.includes(term)).length;
  // Words used all over the chapter ("metals" in a chapter on metals) don't help a marker.
  const chapterWide = (term: string) => frequency(term) > Math.max(8, lowerChapter.length * 0.08);
  const usable = (word: string) => {
    const key = word.toLowerCase();
    return key.length >= 3 && !commonWords.has(key) && !genericAnswerWords.has(key) && !minorTitleWords.has(key) &&
      !/^(are|was|were|has|had|its|their|which|also|very|such|then|than|not|can|may|all|any|one|two)$/.test(key);
  };
  const words = picked.join(" ").match(/[A-Za-z][A-Za-z0-9-]*[A-Za-z0-9]/g) || [];
  const candidates = new Map<string, { term: string; score: number; first: number }>();
  const consider = (term: string, score: number, position: number) => {
    const key = term.toLowerCase();
    const existing = candidates.get(key);
    if (!existing || existing.score < score) candidates.set(key, { term, score, first: existing?.first ?? position });
  };
  words.forEach((word, index) => {
    const key = word.toLowerCase();
    const entry = vocabulary.get(key);
    // Acronyms and symbols such as DNA or ATP.
    if (/^[A-Z]{2,5}$/.test(word) && !/^[IVX]+$/.test(word)) consider(word, 2, index);
    // Chemical formulas such as HgS, NaCl or Al2O3.
    else if (/^(?:[A-Z][a-z]?\d*){2,}$/.test(word) && /[a-z\d]/.test(word)) consider(word, 2.5, index);
    // A name the chapter mentions once ("Latin") is incidental, not something to mark for.
    else if (entry && entry.score >= 1 && usable(word) && !chapterWide(key) && !(entry.proper && frequency(key) < 2)) {
      consider(entry.term, entry.score + (frequency(key) <= 3 ? 1 : 0), index);
    }
    // A long word found only here and in one or two other places ("cinnabar", "electrolytic") is a term to look for.
    // Words ending in a lone "s" here are mostly verbs ("assigns"), so they are left out.
    else if (!entry && key.length >= 7 && word === key && usable(word) && frequency(key) <= 2 &&
      !/(?:ly|ed|ing|ive|ous|ful|able|ible|ment|ness|[^su]s)$/.test(key)) {
      consider(word, 1.6, index);
    }
    // A two-word phrase the chapter uses more than once, such as "metal oxide" or "hydrogen gas".
    const next = words[index + 1];
    // ("sodium react" is the start of a clause, not a phrase.)
    if (next && usable(word) && usable(next) && !/(?:ly|ed)$/.test(key) &&
      !/^(?:react|form|give|make|show|use|produce|cause|occur|become|contain|help|keep|get|take|need)s?$/i.test(next)) {
      const phrase = `${key} ${next.toLowerCase()}`;
      const count = frequency(phrase);
      if (count >= 2 && !chapterWide(phrase)) {
        const parts = [vocabulary.get(key)?.score || 0, vocabulary.get(next.toLowerCase())?.score || 0];
        if (parts.some((score) => score >= 1)) consider(phrase, 2.5 + (parts[0] + parts[1]) * 0.5, index);
      }
    }
  });
  const ranked = [...candidates.values()].sort((a, b) => b.score - a.score || a.first - b.first);
  const chosen: typeof ranked = [];
  for (const candidate of ranked) {
    if (chosen.length >= Math.min(8, 2 + marks)) break;
    const key = candidate.term.toLowerCase();
    // A word already covered by a chosen phrase or by its plural ("electron"/"electrons") adds nothing.
    const singular = (value: string) => value.replace(/(?:es|s)$/, "");
    const overlaps = chosen.some((other) => {
      const otherWords = other.term.toLowerCase().split(" ").map(singular);
      const words = key.split(" ").map(singular);
      return words.every((word) => otherWords.includes(word)) || otherWords.every((word) => words.includes(word));
    });
    if (!overlaps) chosen.push(candidate);
  }
  // The topic's own word counts when the answer uses it and it is specific enough to look for.
  if (keyWord && usable(keyWord) && !chapterWide(keyWord) && !chosen.some((c) => c.term.toLowerCase().includes(keyWord))) {
    const position = words.findIndex((word) => word.toLowerCase().startsWith(keyWord));
    if (position >= 0) chosen.push({ term: keyWord, score: 0, first: position });
  }
  const keywords = chosen.sort((a, b) => a.first - b.first).map((c) => c.term);
  // With no chapter key terms in the answer, fall back to its longest content words.
  if (!keywords.length) {
    keywords.push(...[...new Set(words.filter((word) => word.length >= 6 && usable(word) && !/(ed|ing|ly)$/.test(word)))]
      .sort((a, b) => b.length - a.length)
      .slice(0, 3));
  }
  return keywords;
}

// Lines a textbook prints as tasks or questions ("Differentiate between...") are not answers.
const promptSentence = /^(differentiate|distinguish|suggest|account for|predict|justify|illustrate|classify|explain|define|state|give|write|name|list|describe|why|what|how|which)\b|\b(following sections?|explained in detail|given in fig|shown in fig)\b/i;
// Leftovers of formulas whose layout was lost ("HNO3, SO2– 4 in H2SO4").
const formulaHeavy = (sentence: string) => {
  const tokens = sentence.split(/\s+/);
  return tokens.filter((token) => (/\d/.test(token) && /[A-Z]/.test(token)) || /^[–-]$/.test(token)).length / tokens.length > 0.25;
};
const answerSentenceOk = (sentence: string) => passageSentenceOk(sentence) && !promptSentence.test(sentence) && !formulaHeavy(sentence);
const continuationSentence = /^(but|and|or|so|also|however|thus|hence|therefore|this|these|that|those|it|its|they|their|such|here|then)\b/i;

// Content words (singular) used to tell whether a sentence carries on the same idea.
const contentWords = (text: string) => new Set((text.toLowerCase().match(/[a-z][a-z-]{3,}/g) || [])
  .filter((word) => !commonWords.has(word) && !genericAnswerWords.has(word))
  .map((word) => word.replace(/(?:es|s)$/, "")));

const spreadCache = new WeakMap<string[], Map<string, number>>();
// How many of the chapter's sentences use each content word.
function chapterWordSpread(sentences: string[]): Map<string, number> {
  const cached = spreadCache.get(sentences);
  if (cached) return cached;
  const spread = new Map<string, number>();
  for (const sentence of sentences) for (const word of contentWords(sentence)) spread.set(word, (spread.get(word) || 0) + 1);
  spreadCache.set(sentences, spread);
  return spread;
}

/**
 * Adds sentences from `pool` either side of position `start` (or only after it) while they stay on the
 * idea of what is picked so far: each must share a content word with it. A box printed inside the
 * section ("Nettle is a herbaceous plant...") shares none, so the answer skips it; two misses in a row end a run.
 */
function gatherRelated(
  pool: string[],
  start: number,
  picked: string[],
  wanted: number,
  seed: Set<string>,
  // Words found all over the chapter ("acid" in a chapter on acids) don't show two sentences share an idea.
  chapterWide: (word: string) => boolean,
  directions = [1, -1],
) {
  const linking = (text: string) => new Set([...contentWords(text)].filter((word) => !chapterWide(word)));
  const words = new Set([...seed, ...picked.flatMap((sentence) => [...linking(sentence)])]);
  for (const step of directions) {
    let misses = 0;
    for (let index = start + step; index >= 0 && index < pool.length && picked.length < wanted && misses < 2; index += step) {
      const sentence = pool[index];
      if (picked.includes(sentence)) continue;
      const own = linking(sentence);
      if ([...own].some((word) => words.has(word))) {
        picked.push(sentence);
        own.forEach((word) => words.add(word));
        misses = 0;
      } else misses += 1;
    }
  }
}

/**
 * A model answer taken from the textbook section that holds the question's statement: the statement
 * and the sentences after it in that section (or before it, near a section's end). With no statement,
 * the opening sentences of the topic's own section ("3.2.2 What happens when Metals react with Water?"
 * -> "Metals react with water and produce a metal oxide and hydrogen gas..."). Returns null when the
 * textbook has no numbered sections to work from.
 */
export function textbookModelAnswer(
  textbookText: string,
  marks: number,
  anchor: string,
  topicRaw: string | undefined,
  allSentences: string[],
): { answer: string; keywords: string[] } | null {
  if (!textbookText) return null;
  const wanted = answerLength(marks);
  const { sections } = readTextbook(textbookText);
  const order = sections.flatMap((section) => section.sentences);
  // A textbook without numbered sections is read as one section, finding a topic by its distinctive word.
  const headed = sections.some((section) => section.marker);
  const topicMention = !headed && topicRaw ? topicKeyWord(topicRaw, order) : undefined;
  const topicSentences = (topicRaw
    ? headed ? topicSectionSentences(textbookText, topicRaw) : topicMention ? order.filter((sentence) => sentence.toLowerCase().includes(topicMention)) : []
    : []).filter(answerSentenceOk);
  const spread = chapterWordSpread(allSentences);
  const chapterWide = (word: string) => (spread.get(word) || 0) > Math.max(8, allSentences.length * 0.08);
  const topicWords = topicRaw ? contentWords(cleanTopicName(topicRaw)) : new Set<string>();
  const picked: string[] = [];
  if (anchor) {
    const home = sections.find((section) => section.sentences.includes(anchor));
    if (!home || (!home.marker && headed)) return null;
    // The statement's own sub-section first: the sentences after it, then those before it.
    const pool = home.sentences.filter((sentence) => sentence === anchor || answerSentenceOk(sentence));
    picked.push(anchor);
    gatherRelated(pool, pool.indexOf(anchor), picked, wanted, topicWords, chapterWide);
    // A long answer can run on into the rest of the topic's section.
    const at = topicSentences.indexOf(anchor);
    if (picked.length < wanted && at >= 0) gatherRelated(topicSentences, at, picked, wanted, topicWords, chapterWide);
    // An answer still far too short for its marks may also link through the chapter's common words.
    if (picked.length <= Math.floor(wanted / 2)) gatherRelated(pool, pool.indexOf(anchor), picked, wanted, topicWords, () => false);
  } else {
    // A topic answer opens on a statement that stands alone, not "But..." or "They...".
    const start = topicSentences.findIndex((sentence) => !continuationSentence.test(sentence));
    if (start < 0) return null;
    picked.push(topicSentences[start]);
    gatherRelated(topicSentences, start, picked, wanted, topicWords, chapterWide, [1]);
    if (picked.length <= Math.floor(wanted / 2)) gatherRelated(topicSentences, start, picked, wanted, topicWords, () => false, [1]);
  }
  // Keep the textbook's order so the answer reads as a paragraph.
  picked.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  const keyWord = topicRaw ? topicKeyWord(topicRaw, picked) : undefined;
  return { answer: picked.join(" "), keywords: answerKeywordsFor(picked, marks, allSentences, keyWord) };
}

/**
 * The sentences printed under a numbered heading and its sub-headings ("3.4" takes in 3.4.1-3.4.6).
 */
export function topicSectionSentences(textbookText: string, topicRaw: string): string[] {
  const marker = topicRaw.trim().match(/^(\d+(?:\.\d+)+)\s/)?.[1];
  if (!marker || !textbookText) return [];
  return readTextbook(textbookText).sections
    .filter((section) => section.marker === marker || section.marker.startsWith(`${marker}.`))
    .flatMap((section) => section.sentences);
}

const looksLikeHeading = (line: string) => line.length > 0 && line.length <= 60 && /^[A-Z0-9]/.test(line) && !/[.?!:,;]$/.test(line);

/**
 * The sentences under an unnumbered heading ("Photosynthesis" on a line of its own), up to the next heading.
 */
function headingSectionSentences(textbookText: string, topicRaw: string): string[] {
  const heading = cleanTopicName(topicRaw).toLowerCase();
  const lines = textbookText.split(/\r?\n/).map((line) => line.trim());
  const start = lines.findIndex((line) => cleanTopicName(line).toLowerCase() === heading);
  if (start < 0) return [];
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (looksLikeHeading(line)) break;
    body.push(line);
  }
  return extractCleanSentences(body.join("\n"));
}

function draftQuestion(
  topicRaw: string,
  sourceSentenceRaw: string,
  marks: number,
  difficulty: string,
  questionIndex: number,
  allSentences: string[],
  usedSentences: Set<string> = new Set(),
  mcq = marks === 1,
  // Sentences under the topic's own heading, for MCQs that pick the statement about the topic.
  ownSentences: string[] = [],
): GeneratedQuestion {
  const topic = topicForSentence(topicRaw);
  const sentence = sourceSentenceRaw
    .replace(/\b(chapter|section|unit|lesson)\s+\d+(?:\.\d+)*/gi, "the lesson")
    .replace(/\b\d+(?:\.\d+)+\b/g, "")
    .replace(/\s+/g, " ")
    .trim() || `The characteristic properties of ${topic}`;

  // MCQ sections get four-option questions, as the Section A instruction ("select one of the four options") requires.
  if (mcq) {
    const topicWords = topic.toLowerCase().split(/\s+/).filter((word) => word.length > 3);
    const related = allSentences.filter((candidate) => topicWords.some((word) => candidate.toLowerCase().includes(word)));
    const ordered = [sourceSentenceRaw, ...related, ...allSentences];
    const start = ordered.length > 1 ? questionIndex % ordered.length : 0;
    let cloze: ReturnType<typeof buildClozeMcq> = null;
    for (let offset = 0; offset < ordered.length && !cloze; offset += 1) {
      const candidate = offset === 0 ? sourceSentenceRaw : ordered[(start + offset) % ordered.length];
      if (offset > 0 && usedSentences.has(candidate)) continue;
      cloze = buildClozeMcq(candidate, allSentences, questionIndex);
      if (cloze) usedSentences.add(candidate);
    }
    if (cloze) {
      const lead = difficulty === "Easy"
        ? "Fill in the blank:"
        : difficulty === "Advanced"
          ? "Identify the term that correctly completes the statement:"
          : difficulty === "Application"
            ? "Which term best completes the following observation?"
            : "Choose the correct option to complete the statement:";
      return { text: `${lead} ${cloze.stem}`, marks, options: cloze.options, answer: cloze.answer };
    }
    // Too few key terms for a blank: ask which statement is about the topic instead.
    const statement = buildStatementMcq(topic, sourceSentenceRaw, ownSentences, allSentences, questionIndex, usedSentences);
    if (statement) {
      usedSentences.add(statement.answer);
      const ask = difficulty === "Advanced" || difficulty === "Application"
        ? `Which of the following statements correctly describes ${topic}?`
        : `Which of the following statements is about ${topic}?`;
      return { text: ask, marks, options: statement.options, answer: statement.answer };
    }
    // Too little textbook text even for that: fall back to a true/false style choice.
    return {
      text: `State whether the following statement about ${topic} is true or false: ${sentence.replace(/[.]$/, "")}.`,
      marks,
      options: ["True", "False", "Partly true", "Cannot be determined"],
      answer: "True",
    };
  }

  // Written questions quote a textbook sentence about the topic; with none available they ask about the topic itself.
  const quote = sourceSentenceRaw.trim() ? `"${sentence.replace(/\.$/, "")}."` : "";

  // A question-style heading ("How do metals react with water?") is asked directly.
  const asked = askedHeading(topicRaw);
  if (asked && marks === 2) {
    if (difficulty === "Easy") return { text: `${asked} Answer briefly.`, marks };
    if (difficulty === "Advanced") return { text: `${asked} Give two reasons.`, marks };
    if (difficulty === "Application") return { text: `${asked} Give one example from daily life.`, marks };
    return { text: quote ? `${asked} Answer in two points, using the statement: ${quote}` : `${asked} Answer in two points.`, marks };
  }
  if (asked && marks === 3) {
    if (difficulty === "Easy") return { text: `${asked} Answer in three points.`, marks };
    if (difficulty === "Advanced") return { text: `${asked} Explain, and state one exception or limitation.`, marks };
    if (difficulty === "Application") return { text: `${asked} Describe an activity or everyday situation that shows this.`, marks };
    return { text: quote ? `${asked} Explain with reference to the statement ${quote} Give an example.` : `${asked} Explain with an example.`, marks };
  }

  // 1-Mark written questions (MCQ turned off): a one-line answer.
  if (marks === 1) {
    if (asked) return { text: `${asked} Answer in one sentence.`, marks };
    if (difficulty === "Easy") return { text: `Define ${topic}.`, marks };
    if (difficulty === "Advanced") return { text: `State one reason why ${topic} is important.`, marks };
    if (difficulty === "Application") return { text: `Give one example of ${topic} from everyday life.`, marks };
    return { text: `What is meant by ${topic}?`, marks };
  }

  // 2-Mark Questions (Very Short Answer)
  if (marks === 2) {
    if (quote) {
      if (difficulty === "Easy") return { text: `Read the statement: ${quote} State two points about ${topic} that it tells us.`, marks };
      if (difficulty === "Advanced") return { text: `Justify the following statement with two reasons: ${quote}`, marks };
      if (difficulty === "Application") return { text: `Give one example from everyday life or the laboratory that illustrates this idea from ${topic}, and explain it briefly: ${quote}`, marks };
      return { text: `Explain the following statement about ${topic} in your own words: ${quote}`, marks };
    }
    if (difficulty === "Easy") return { text: `Define ${topic}. Give one example.`, marks };
    if (difficulty === "Advanced") return { text: `Explain why ${topic} is important. Give two reasons.`, marks };
    if (difficulty === "Application") return { text: `Give one real-life example of ${topic} and explain how it takes place.`, marks };
    return { text: `What is meant by ${topic}? Explain briefly with an example.`, marks };
  }

  // 3-Mark Questions (Short Answer)
  if (marks === 3) {
    if (quote) {
      if (difficulty === "Easy") return { text: `${quote} (a) What does this statement tell us about ${topic}? (b) Give one example. (c) State one more related fact.`, marks };
      if (difficulty === "Advanced") return { text: `${quote} (i) Explain the idea behind this statement. (ii) What would happen if it were not true? (iii) How is it related to ${topic}?`, marks };
      if (difficulty === "Application") return { text: `Using the idea that ${quote.replace(/^"|\."$/g, "")}, describe a real-life situation where ${topic} can be seen. What would change if the conditions were different?`, marks };
      return { text: `Explain the statement ${quote} with reference to ${topic}. Support your answer with an example.`, marks };
    }
    if (difficulty === "Easy") return { text: `Describe ${topic} in three points.`, marks };
    if (difficulty === "Advanced") return { text: `Explain ${topic}. How is it different from a related process you have studied? Give one reason for the difference.`, marks };
    if (difficulty === "Application") return { text: `Describe a situation in which ${topic} can be observed. Explain, step by step, what happens.`, marks };
    return { text: `Explain ${topic} with the help of an example. State one advantage or use of it.`, marks };
  }

  // 4 or 5+ Marks (Long Answer with an OR choice)
  // The OR choice must not repeat the main question's sentence or one used elsewhere in the paper.
  let altSentence = "";
  for (let offset = 0; offset < allSentences.length; offset += 1) {
    const candidate = allSentences[(questionIndex * 7 + 3 + offset) % allSentences.length];
    if (candidate !== sourceSentenceRaw && !usedSentences.has(candidate)) {
      altSentence = candidate;
      break;
    }
  }
  // The OR sentence can come from anywhere in the chapter, so it is asked about on its own terms.
  const altQuote = altSentence ? `"${altSentence.replace(/\.$/, "")}."` : "";

  let mainText = "";
  let altText = "";
  if (difficulty === "Easy") {
    mainText = quote
      ? `Describe ${topic} in detail. Explain the statement ${quote} Draw a neat, labelled diagram wherever necessary.`
      : `Describe ${topic} in detail. Draw a neat, labelled diagram wherever necessary.`;
    altText = altQuote
      ? `Explain the following statement in detail with suitable examples: ${altQuote}`
      : `Write a detailed note on ${topic} with suitable examples.`;
  } else if (difficulty === "Advanced") {
    mainText = quote
      ? `(a) Explain the statement ${quote} in the context of ${topic}. (b) Compare it with a related process you have studied. (c) Discuss its significance.`
      : `(a) Explain ${topic} in detail. (b) Compare it with a related process you have studied. (c) Discuss its significance.`;
    altText = altQuote
      ? `Evaluate the statement ${altQuote} Give reasons and examples to support your answer.`
      : `Evaluate the importance of ${topic}. Give reasons and examples to support your answer.`;
  } else if (difficulty === "Application") {
    mainText = quote
      ? `A student studying ${topic} reads: ${quote} Explain how this idea can be observed or tested, and describe the result you would expect.`
      : `Explain how ${topic} can be observed or demonstrated, and describe the result you would expect.`;
    altText = altQuote
      ? `Describe a real-life situation that shows the following idea, and explain it in detail: ${altQuote}`
      : `Describe a real-life situation where ${topic} is seen, and explain it in detail.`;
  } else {
    mainText = quote
      ? `Explain ${topic} in detail. (a) What does the statement ${quote} mean? (b) Describe the steps or stages involved. (c) State its importance.`
      : `Explain ${topic} in detail. (a) What is it? (b) Describe the steps or stages involved. (c) State its importance.`;
    altText = altQuote
      ? `Discuss the following statement with suitable examples: ${altQuote}`
      : `Discuss ${topic} with suitable examples.`;
  }
  if (asked) {
    const extra = quote ? ` Include an explanation of the statement ${quote}` : "";
    mainText = difficulty === "Easy"
      ? `${asked} Describe in detail, with a labelled diagram or equations where relevant.${extra}`
      : difficulty === "Advanced"
        ? `${asked} (a) Explain in detail. (b) Compare it with a related process or reaction. (c) Discuss its importance.${extra}`
        : difficulty === "Application"
          ? `${asked} Describe an activity or experiment that shows this, and the result you would expect.${extra}`
          : `${asked} Explain in detail with examples, writing equations or drawing diagrams where relevant.${extra}`;
    if (!altQuote) altText = `Write a detailed note that answers the question: ${asked}`;
  }

  return {
    text: mainText,
    marks,
    alternative: altText,
    alternativeAnswer: altSentence || undefined,
  };
}

/**
 * The topic's most distinctive word ("spore" in "Spore Formation", "human" in "Reproduction in
 * Human Beings"), so matching does not hinge on a common word like "formation" or "reproduction".
 */
function topicKeyWord(topic: string, sentences: string[]): string | undefined {
  return topicKeyWords(topic, sentences)[0];
}

// The topic's words that the chapter actually uses, rarest (most distinctive) first.
function topicKeyWords(topic: string, sentences: string[]): string[] {
  const lowerSentences = sentences.map((s) => s.toLowerCase());
  return cleanTopicName(topic)
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.replace(/[^a-z-]/g, ""))
    // Question headings ("What happens when metals react with water?") carry words that match everything.
    .filter((w) => w.length > 3 && !commonWords.has(w) && !/^(with|what|when|does|have|happens|each|really|more|about|from|into)$/.test(w))
    .map((word) => ({ word, count: lowerSentences.filter((s) => s.includes(word)).length }))
    .filter((entry) => entry.count > 0)
    .sort((a, b) => a.count - b.count)
    .map((entry) => entry.word);
}

// Passage sentences must be complete statements: no activity steps, figure references or cut-off brackets.
const passageSentenceOk = (sentence: string) =>
  /\.$/.test(sentence) &&
  !/\([a-d]\)|\b(activity|figure|fig\.?|exercise)\b|\(fig/i.test(sentence) &&
  !/^(place|note|take|observe|look|find|try|draw|discuss|let|keep|cut|put|add|remove|collect|compare|now|write|balance|mix|pour|heat|dip|stir|repeat|record|make sure|ensure|never|always|do not)\b/i.test(sentence) &&
  !/\b(you|your|we|us|let's)\b/i.test(sentence) &&
  (sentence.match(/\(/g) || []).length === (sentence.match(/\)/g) || []).length;

/**
 * The textbook's definition of a term: "... are called ores", "... is known as corrosion",
 * "Reduction is ...". Null when the chapter never defines it.
 */
function definitionOf(term: string, sentences: string[]): string | null {
  const word = escapeRegExp(term).replace(/s$/i, "");
  const patterns = [
    new RegExp(`\\b(?:called|known as|termed|referred to as)\\s+(?:an?\\s+|the\\s+)?${word}s?\\b`, "i"),
    new RegExp(`^(?:an?\\s+|the\\s+)?${word}s?\\s+(?:is|are|means|refers to)\\b`, "i"),
  ];
  for (const pattern of patterns) {
    const found = sentences.find((sentence) => pattern.test(sentence) && answerSentenceOk(sentence));
    if (found) return found;
  }
  return null;
}

/**
 * Builds a CBSE-style source/case-based question: a textbook passage followed by
 * (i) 1 mark, (ii) 1 mark and (iii) the remaining marks with an internal OR choice.
 * Returns null when the chapter has no suitable passage for the topic.
 */
export function generateCaseQuestion(
  topicRaw: string,
  textbookText: string,
  marks: number,
  difficulty: string,
  seed: number,
  usedSentences: Set<string> = new Set(),
): GeneratedQuestion | null {
  if (marks < 3) return null;
  const topic = topicForSentence(topicRaw);
  const asked = askedHeading(topicRaw);
  const ordered = extractTextbookSentences(textbookText);
  const allSentences = extractCleanSentences(textbookText);
  const keyWord = topicKeyWord(topicRaw, ordered);
  // A topic the chapter never mentions outside its heading has no passage of its own.
  if (!keyWord) return null;

  // Runs of 3-4 consecutive textbook sentences that open with the topic and read as one paragraph.
  const windows: string[][] = [];
  for (let start = 0; start < ordered.length; start += 1) {
    if (keyWord && !ordered[start].toLowerCase().includes(keyWord)) continue;
    for (const size of [4, 3]) {
      const run = ordered.slice(start, start + size);
      const length = run.join(" ").length;
      if (run.length === size && run.every(passageSentenceOk) && length >= 220 && length <= 760) {
        windows.push(run);
        break;
      }
    }
  }
  // Prefer a passage no other question has quoted; reuse one only if the chapter has nothing else.
  const fresh = windows.filter((run) => !run.some((sentence) => usedSentences.has(sentence)));
  const choices = fresh.length ? fresh : windows;
  if (!choices.length) return null;
  const passage = choices[seed % choices.length];

  // Sub-questions prefer sentences no other question has used, even when the passage overlaps.
  const byFreshness = [...passage].sort((a, b) => Number(usedSentences.has(a)) - Number(usedSentences.has(b)));

  // (i) a fill-in-the-blank from the passage
  let partOne: { text: string; answer: string } | null = null;
  let partOneSentence = "";
  for (const sentence of byFreshness) {
    const cloze = buildClozeMcq(sentence, allSentences, seed);
    if (cloze) {
      partOne = { text: `Fill in the blank: ${cloze.stem}`, answer: cloze.answer };
      partOneSentence = sentence;
      break;
    }
  }
  // (ii) the meaning of a technical term from the passage, or a second blank if it has none
  const vocabulary = keyTermVocabulary(allSentences);
  const term = passage
    .flatMap((sentence) => (sentence.match(/[A-Za-z][A-Za-z-]*[A-Za-z]/g) || []).map((word) => ({ sentence, info: vocabulary.get(word.toLowerCase()) })))
    .filter((entry) =>
      entry.info && !entry.info.proper && entry.info.score >= 2.5 &&
      entry.info.term.toLowerCase() !== partOne?.answer.toLowerCase() &&
      // A word used all over the chapter ("organisms") is too general to define.
      allSentences.filter((sentence) => sentence.toLowerCase().includes(entry.info!.term.toLowerCase())).length <= 6)
    .sort((a, b) => (b.info?.score || 0) - (a.info?.score || 0))[0];
  let partTwo: { text: string; answer: string } | null = term?.info
    ? { text: `What is meant by "${term.info.term}"?`, answer: definitionOf(term.info.term, ordered) || term.sentence }
    : null;
  let partTwoSentence = term?.sentence || "";
  for (const sentence of byFreshness) {
    if (partTwo) break;
    if (sentence === partOneSentence) continue;
    const cloze = buildClozeMcq(sentence, allSentences, seed + 1);
    if (cloze && cloze.answer.toLowerCase() !== partOne?.answer.toLowerCase()) {
      partTwo = { text: `Fill in the blank: ${cloze.stem}`, answer: cloze.answer };
      partTwoSentence = sentence;
    }
  }
  // (iii) the longer part, built on the fullest sentence the first two parts did not use
  const remaining = passage.filter((sentence) => sentence !== partOneSentence && sentence !== partTwoSentence);
  const focus = [...remaining].sort((a, b) => Number(usedSentences.has(a)) - Number(usedSentences.has(b)) || b.length - a.length)[0] || passage[passage.length - 1];
  const focusQuote = `"${focus.replace(/\.$/, "")}."`;
  const lastMarks = marks - 2;
  const partThreeText = difficulty === "Application"
    ? `Give one real-life example of the idea in the statement ${focusQuote} and explain it.`
    : difficulty === "Advanced"
      ? `Explain the statement ${focusQuote} What would happen if it were not true?`
      : `Explain the following statement from the passage: ${focusQuote}`;

  // Part answers come from the passage itself, with the key terms to look for.
  const caseAnswer = (anchor: string, wholePassage = false) => {
    const model = buildModelAnswer(allSentences, wholePassage ? lastMarks + 1 : lastMarks, anchor, wholePassage ? topicRaw : undefined, passage);
    return { answer: model?.answer || anchor, keywords: model?.keywords };
  };

  passage.forEach((sentence) => usedSentences.add(sentence));
  return {
    kind: "case",
    text: `Read the passage given below and answer the questions that follow.\n${passage.join(" ")}`,
    marks,
    parts: [
      { ...(partOne || { text: asked ? "State one fact given in the passage." : `State one fact about ${topic} given in the passage.`, answer: passage[0] }), marks: 1 },
      { ...(partTwo || { text: `Name the process described in the passage.`, answer: cleanTopicName(topicRaw) }), marks: 1 },
      {
        text: partThreeText,
        marks: lastMarks,
        ...caseAnswer(focus),
        alternative: lastMarks >= 2
          ? { text: asked ? `Based on the passage, answer in ${lastMarks >= 3 ? "three" : "two"} points: ${asked}` : `Based on the passage, state ${lastMarks >= 3 ? "three" : "two"} important points about ${topic}.`, ...caseAnswer(passage[0], true) }
          : undefined,
      },
    ],
  };
}

/**
 * Drafts full question sections from topics, sentences, pattern, and difficulty.
 */
export function draftQuestionSections(
  options: QuestionGeneratorOptions,
): GeneratedSection[] {
  const { textbookText, selectedTopics, difficulty, patternSections } = options;
  const sentences = extractCleanSentences(textbookText);
  const topics = selectedTopics.length > 0 ? selectedTopics : ["General Science"];

  const sentenceSet = new Set(sentences);
  const allTextbookSentences = extractTextbookSentences(textbookText);
  const getSourceSentence = (topic: string, index: number): string => {
    // The topic's distinctive word is looked for in the whole chapter ("mask", not "work"), even where
    // it only appears in sentences too long or too narrative to quote.
    const keyWord = topicKeyWord(topic, allTextbookSentences);
    const mentions = keyWord ? sentences.filter((s) => s.toLowerCase().includes(keyWord)) : [];
    // Statements printed under the topic's own heading come first, so the question and its answer match.
    const own = topicSectionSentences(textbookText, topic).filter((s) => sentenceSet.has(s));

    // Take the next sentence about this topic not already used in the paper, from its own section before
    // the rest of the chapter. If there is none, return "" so the question asks about the topic directly
    // instead of quoting an unrelated sentence.
    // A section is read in order, since its opening sentences usually carry the main facts.
    // A box printed at the top of a section ("Its leaves have stinging hair...") is passed over for a
    // sentence that names the topic.
    const topicWords = [...contentWords(cleanTopicName(topic))];
    const fromSection = own.find((s) => !usedSentences.has(s) && [...contentWords(s)].some((word) => topicWords.includes(word))) ||
      own.find((s) => !usedSentences.has(s));
    if (fromSection) return fromSection;
    // Once its own section is used up, a topic is asked about directly rather than through a stray mention.
    if (own.length) return "";
    const others = mentions.filter((s) => !own.includes(s));
    for (let offset = 0; offset < others.length; offset += 1) {
      const candidate = others[(index + offset) % others.length];
      if (!usedSentences.has(candidate)) return candidate;
    }
    return "";
  };

  const usedSentences = new Set<string>();
  const usedTexts = new Set<string>();
  let globalQuestionCounter = 0;

  return patternSections.map((section, sIndex) => {
    const sectionLabel =
      section.label || `Section ${String.fromCharCode(65 + sIndex)}`;

    const questions: GeneratedQuestion[] = [];
    for (let qIndex = 0; qIndex < section.count; qIndex += 1) {
      // Try the next topic whenever a question would repeat one already in the paper.
      // The paper-wide question count alone picks the topic, so consecutive questions move one topic on.
      let sentence = "";
      let q: GeneratedQuestion | null = null;
      for (let attempt = 0; attempt < topics.length; attempt += 1) {
        const topic = topics[(globalQuestionCounter + attempt) % topics.length];
        sentence = getSourceSentence(topic, globalQuestionCounter + qIndex);
        // A case-based section looks through the other topics for a usable passage before giving up.
        let caseQuestion: GeneratedQuestion | null = null;
        for (let offset = 0; isCaseBasedSection(section) && !caseQuestion && offset < topics.length; offset += 1) {
          const caseTopic = topics[(globalQuestionCounter + attempt + offset) % topics.length];
          caseQuestion = generateCaseQuestion(caseTopic, textbookText, section.marks, difficulty, globalQuestionCounter + qIndex + attempt, usedSentences);
        }
        q = caseQuestion || generateSingleQuestion(
          topic,
          sentence,
          section.marks,
          difficulty,
          globalQuestionCounter + 1,
          sentences,
          usedSentences,
          textbookText,
          isMcqSection(section),
        );
        if (!usedTexts.has(q.text)) break;
      }
      if (!q) continue;
      usedTexts.add(q.text);
      if (!isMcqSection(section)) usedSentences.add(sentence);
      if (typeof q.alternative === "string") {
        const quoted = q.alternative.match(/"([^"]+)"/)?.[1];
        if (quoted) usedSentences.add(quoted);
      }

      // Prepend standard numbering prefix
      const qNum = globalQuestionCounter + 1;
      questions.push({
        ...q,
        text: `${qNum}. ${q.text}`,
      });

      globalQuestionCounter += 1;
    }

    return {
      label: sectionLabel,
      questions,
    };
  });
}
