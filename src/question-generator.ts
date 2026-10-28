import type { GeneratedQuestion, GeneratedSection } from "./blueprint";
import { cleanBrokenKerningWords } from "./text-cleaner";

export interface QuestionGeneratorOptions {
  textbookText: string;
  selectedTopics: string[];
  difficulty: "Easy" | "Moderate" | "Advanced" | "Application" | string;
  patternSections: Array<{ count: number; marks: number; label?: string; caseBased?: boolean }>;
}

/** CBSE's source/case-based items carry 4 marks, so 4-mark sections default to case-based. */
export const isCaseBasedSection = (section: { marks: number; caseBased?: boolean }) =>
  section.caseBased ?? section.marks === 4;

// Sentences that only make sense inside the textbook's own narration ("Let us...", "Can you think...").
const narrationPattern = /\([a-d]\)|^(it|this|these|that|those|they|he|she|we|let|can|think|but|and|or|so|now|here|on the other hand|however|such|therefore|thus|hence|similarly|also|compare|observe|take|find|look|draw|discuss|try|note|see|place|collect|consider|imagine|arrange|for this|never|always|do not|now|add|put|mix|pour|heat|dip|stir|repeat|record|cover|balance|name|state|give|write|explain|define|list|identify|describe|mention|what|which|why|how)\b|\bto think of\b|\b(we|us|our|you|your|let's)\b|\b(classroom|next chapter|previous chapter|class\s+(?:ix|viii|x)|activity|activities|figure|fig\.)|\b(chapter|section|table)\s+\d/i;

// Chemical equations lose their subscripts in PDF text ("CaCO s Ca(HCO aq3 3( ) )"), so they are left out.
const garbledEquation = (sentence: string) => {
  if (/→|←|⇌|\(\s*\)|\((?:aq|s|l|g)\)/.test(sentence)) return true;
  const tokens = sentence.split(/\s+/);
  return tokens.filter((token) => /^[A-Za-z0-9()+–-]{1,2}$/.test(token)).length / tokens.length > 0.25;
};

/**
 * Extracts clean sentences from raw textbook text for question drafting.
 */
export function extractCleanSentences(text: string): string[] {
  const sentences = extractTextbookSentences(text);
  // Prefer self-contained factual statements; fall back to everything if a chapter is too short.
  const factual = sentences.filter((sentence) => /\.$/.test(sentence) && !narrationPattern.test(sentence));
  return factual.length >= 10 ? factual : sentences;
}

/**
 * All readable sentences in textbook order (used to cut out case-study passages).
 */
function extractTextbookSentences(text: string): string[] {
  return text
    .replace(/([A-Za-z])-\s+([a-z])/g, "$1-$2")
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => cleanBrokenKerningWords(sentence.replace(/\s+/g, " ").trim()))
    .filter(
      (sentence) =>
        sentence.length >= 35 &&
        sentence.length <= 220 &&
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
): GeneratedQuestion {
  const question = draftQuestion(topicRaw, sourceSentenceRaw, marks, difficulty, questionIndex, allSentences, usedSentences);
  if (question.answer || question.options) return question;
  const source = sourceSentenceRaw.trim();
  return source ? { ...question, answer: source } : question;
}

function draftQuestion(
  topicRaw: string,
  sourceSentenceRaw: string,
  marks: number,
  difficulty: string,
  questionIndex: number,
  allSentences: string[],
  usedSentences: Set<string> = new Set(),
): GeneratedQuestion {
  const topic = topicForSentence(topicRaw);
  const sentence = sourceSentenceRaw
    .replace(/\b(chapter|section|unit|lesson)\s+\d+(?:\.\d+)*/gi, "the lesson")
    .replace(/\b\d+(?:\.\d+)+\b/g, "")
    .replace(/\s+/g, " ")
    .trim() || `The characteristic properties of ${topic}`;

  // 1-Mark Questions: always four-option MCQs, as the Section A instruction ("select one of the four options") requires.
  if (marks === 1) {
    const topicWords = topic.toLowerCase().split(/\s+/).filter((word) => word.length > 3);
    const related = allSentences.filter((candidate) => topicWords.some((word) => candidate.toLowerCase().includes(word)));
    const ordered = [sourceSentenceRaw, ...related, ...allSentences];
    const start = ordered.length > 1 ? questionIndex % ordered.length : 0;
    let mcq: ReturnType<typeof buildClozeMcq> = null;
    for (let offset = 0; offset < ordered.length && !mcq; offset += 1) {
      const candidate = offset === 0 ? sourceSentenceRaw : ordered[(start + offset) % ordered.length];
      if (offset > 0 && usedSentences.has(candidate)) continue;
      mcq = buildClozeMcq(candidate, allSentences, questionIndex);
      if (mcq) usedSentences.add(candidate);
    }
    if (mcq) {
      const lead = difficulty === "Easy"
        ? "Fill in the blank:"
        : difficulty === "Advanced"
          ? "Identify the term that correctly completes the statement:"
          : difficulty === "Application"
            ? "Which term best completes the following observation?"
            : "Choose the correct option to complete the statement:";
      return { text: `${lead} ${mcq.stem}`, marks: 1, options: mcq.options, answer: mcq.answer };
    }
    // Too little textbook text to build options from: fall back to a true/false style choice.
    return {
      text: `State whether the following statement about ${topic} is true or false: ${sentence.replace(/[.]$/, "")}.`,
      marks: 1,
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
  const lowerSentences = sentences.map((s) => s.toLowerCase());
  return cleanTopicName(topic)
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.replace(/[^a-z-]/g, ""))
    // Question headings ("What happens when metals react with water?") carry words that match everything.
    .filter((w) => w.length > 3 && !commonWords.has(w) && !/^(with|what|when|does|have|happens|each|really|more|about|from|into)$/.test(w))
    .map((word) => ({ word, count: lowerSentences.filter((s) => s.includes(word)).length }))
    .filter((entry) => entry.count > 0)
    .sort((a, b) => a.count - b.count)[0]?.word;
}

// Passage sentences must be complete statements: no activity steps, figure references or cut-off brackets.
const passageSentenceOk = (sentence: string) =>
  /\.$/.test(sentence) &&
  !/\([a-d]\)|\b(activity|figure|fig\.?|exercise)\b|\(fig/i.test(sentence) &&
  !/^(place|note|take|observe|look|find|try|draw|discuss|let|keep|cut|put|add|remove|collect|compare|now|write|balance|mix|pour|heat|dip|stir|repeat|record)\b/i.test(sentence) &&
  !/\b(you|your|we|us|let's)\b/i.test(sentence) &&
  (sentence.match(/\(/g) || []).length === (sentence.match(/\)/g) || []).length;

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
    ? { text: `What is meant by "${term.info.term}"?`, answer: term.sentence }
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
        answer: focus,
        alternative: lastMarks >= 2
          ? { text: asked ? `Based on the passage, answer in ${lastMarks >= 3 ? "three" : "two"} points: ${asked}` : `Based on the passage, state ${lastMarks >= 3 ? "three" : "two"} important points about ${topic}.`, answer: passage.join(" ") }
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

  const getSourceSentence = (topic: string, index: number): string => {
    const keyWord = topicKeyWord(topic, sentences);
    const matches = keyWord ? sentences.filter((s) => s.toLowerCase().includes(keyWord)) : [];

    // Take the next sentence about this topic not already used in the paper. If there is none, return ""
    // so the question asks about the topic directly instead of quoting an unrelated sentence.
    for (let offset = 0; offset < matches.length; offset += 1) {
      const candidate = matches[(index + offset) % matches.length];
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
      let sentence = "";
      let q: GeneratedQuestion | null = null;
      for (let attempt = 0; attempt < topics.length; attempt += 1) {
        const topic = topics[(globalQuestionCounter + qIndex + attempt) % topics.length];
        sentence = getSourceSentence(topic, globalQuestionCounter + qIndex);
        // A case-based section looks through the other topics for a usable passage before giving up.
        let caseQuestion: GeneratedQuestion | null = null;
        for (let offset = 0; isCaseBasedSection(section) && !caseQuestion && offset < topics.length; offset += 1) {
          const caseTopic = topics[(globalQuestionCounter + qIndex + attempt + offset) % topics.length];
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
        );
        if (!usedTexts.has(q.text)) break;
      }
      if (!q) continue;
      usedTexts.add(q.text);
      if (section.marks !== 1) usedSentences.add(sentence);
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
