import type { GeneratedQuestion, GeneratedSection } from "./blueprint";
import { cleanBrokenKerningWords } from "./text-cleaner";

export interface QuestionGeneratorOptions {
  textbookText: string;
  selectedTopics: string[];
  difficulty: "Easy" | "Moderate" | "Advanced" | "Application" | string;
  patternSections: Array<{ count: number; marks: number; label?: string }>;
}

// Sentences that only make sense inside the textbook's own narration ("Let us...", "Can you think...").
const narrationPattern = /\([a-d]\)|^(it|this|these|that|those|they|he|she|we|let|can|think|but|and|or|so|now|here|on the other hand|however|such|therefore|thus|hence|similarly|also|compare|observe|take|find|look|draw|discuss|try|note|see|place|collect|consider|imagine)\b|\bto think of\b|\b(we|us|our|you|your|let's)\b|\b(classroom|next chapter|previous chapter|class\s+(?:ix|viii|x)|activity|figure|fig\.)/i;

/**
 * Extracts clean sentences from raw textbook text for question drafting.
 */
export function extractCleanSentences(text: string): string[] {
  const sentences = text
    .replace(/([A-Za-z])-\s+([a-z])/g, "$1-$2")
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => cleanBrokenKerningWords(sentence.replace(/\s+/g, " ").trim()))
    .filter(
      (sentence) =>
        sentence.length >= 35 &&
        sentence.length <= 220 &&
        !/^(activity|figure|fig\.?|table|question|exercise|page|chapter)\b/i.test(sentence) &&
        !/\bReprint\s+\d{4}/i.test(sentence) &&
        /^[A-Z]/.test(sentence) &&
        /[a-zA-Z]{3,}/.test(sentence),
    );
  // Prefer self-contained factual statements; fall back to everything if a chapter is too short.
  const factual = sentences.filter((sentence) => /\.$/.test(sentence) && !narrationPattern.test(sentence));
  return factual.length >= 10 ? factual : sentences;
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

const commonWords = new Set(`about above after again against almost along already also although always among another answer anything around because become becomes been before being below between beyond both called cannot cases certain change changes common could different does doing done during each early either enough especially even every example fact first following form found from further given great happen happens having however important instance into itself known large larger later least less level like likely little made main make makes making many might more most much must namely nature necessary need needs never number often only other others otherwise over part particular parts place possible present process processes produce produced rather really reason result same seen several shall should show shown similar simple since single small some something sometimes specific still such take taken than that their them themselves then there therefore these they thing things think this those though three through thus time together turn under until upon used useful using usually various very what when where whether which while whole whose will with within without would years`.split(/\s+/));

type KeyTerm = { term: string; proper: boolean; score: number };
const vocabularyCache = new WeakMap<string[], Map<string, KeyTerm>>();

// Builds the chapter's key terms (Hydra, Plasmodium, fission, chromosomes, ...) used as blanks and distractors.
function keyTermVocabulary(sentences: string[]): Map<string, KeyTerm> {
  const cached = vocabularyCache.get(sentences);
  if (cached) return cached;
  const counts = new Map<string, { count: number; properCount: number; surface: string }>();
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
    const proper = entry.properCount > 0 && entry.properCount >= entry.count / 2;
    // Technical terms recur a few times; very frequent words are usually generic.
    if (entry.count > 25 || (!proper && entry.count < 2)) continue;
    // Blanks and options should be nouns; skip adverb/verb/adjective-looking words.
    if (!proper && /(?:ly|ed|ing|ive|ous|ful|able|ible|ent|ant|ise|ize|ate|al|ic|ar|ian|ens)$/.test(key)) continue;
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
  const pool = [...vocabulary.values()]
    .filter((entry) =>
      entry.proper === answer.proper &&
      (entry.proper || isPlural(entry.term) === isPlural(answer.term)) &&
      !sentenceWords.has(entry.term.toLowerCase()) &&
      stemOf(entry.term) !== stemOf(answer.term) &&
      entry.score >= 1)
    .sort((a, b) => b.score - a.score || a.term.localeCompare(b.term));
  const distractors: string[] = [];
  for (let offset = 0; offset < pool.length && distractors.length < 3; offset += 1) {
    const candidate = pool[(seed * 5 + offset) % pool.length].term;
    if (!distractors.some((term) => stemOf(term) === stemOf(candidate))) distractors.push(candidate);
  }
  if (distractors.length < 3) return null;

  const blankPattern = new RegExp(`\\b${escapeRegExp(answer.term)}\\b`, "i");
  const blankAtStart = sentence.search(blankPattern) === 0;
  const stem = sentence.replace(blankPattern, "________");
  const display = (term: string) => (blankAtStart ? term.charAt(0).toUpperCase() + term.slice(1) : term);
  const options = [answer.term, ...distractors].map(display);
  const shift = seed % 4;
  return { stem, options: [...options.slice(shift), ...options.slice(0, shift)] };
}

/**
 * Generates an individual question given a topic, sentence, marks, and difficulty.
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
  const topic = cleanTopicName(topicRaw) || "the key concept";
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
      return { text: `${lead} ${mcq.stem}`, marks: 1, options: mcq.options };
    }
    // Too little textbook text to build options from: fall back to a true/false style choice.
    return {
      text: `State whether the following statement about ${topic} is true or false: ${sentence.replace(/[.]$/, "")}.`,
      marks: 1,
      options: ["True", "False", "Partly true", "Cannot be determined"],
    };
  }

  // Written questions quote a textbook sentence about the topic; with none available they ask about the topic itself.
  const quote = sourceSentenceRaw.trim() ? `"${sentence.replace(/\.$/, "")}."` : "";

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

  return {
    text: mainText,
    marks,
    alternative: altText,
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
    const topicWords = cleanTopicName(topic)
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 3);

    // Match on the topic's most distinctive word ("spore" in "Spore Formation", "human" in
    // "Reproduction in Human Beings"), not on a common word like "formation" or "reproduction".
    const lowerSentences = sentences.map((s) => s.toLowerCase());
    const byRarity = topicWords
      .map((word) => ({ word, count: lowerSentences.filter((s) => s.includes(word)).length }))
      .filter((entry) => entry.count > 0)
      .sort((a, b) => a.count - b.count);
    const keyWord = byRarity[0]?.word;
    const matches = keyWord ? sentences.filter((_, i) => lowerSentences[i].includes(keyWord)) : [];

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
        q = generateSingleQuestion(
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
