import { useState, useEffect, useMemo, useRef } from "react";
import type { BlueprintAnalysis, GeneratedQuestion, GeneratedSection } from "./blueprint";
import {
  DEFAULT_TEMPLATE_CONFIG,
  type StandardTemplateConfig,
} from "./standard-template-config";
import {
  draftQuestionSections,
  generateSingleQuestion,
  generateCaseQuestion,
  isCaseBasedSection,
  extractCleanSentences,
  cleanTopicName,
} from "./question-generator";
import {
  extractTextFromPatternFile,
  parsePatternText,
} from "./pattern-parser";
import {
  loadRecentPapers,
  saveRecentPaper,
  deleteRecentPaper,
  loadQuestionBank,
  deleteBankQuestion,
  savePaperPdf,
  loadPaperPdf,
  migrateLegacyPaperPdfs,
  loadProfile,
  saveProfile,
  type StoredPaper,
  type StoredBankQuestion,
} from "./storage";
import { joinPdfPages, cleanBrokenKerningWords } from "./text-cleaner";
import "./App.css";

// The PDF and Word libraries are large, so they load only when a file is read or a paper is built.
const loadBlueprint = () => import("./blueprint");
const loadStandardTemplate = () => import("./standard-template");
const loadReflow = () => import("./blueprint-reflow");
const loadMammoth = () => import("mammoth/mammoth.browser");

function pickRandomItem<T>(items: T[], fallback: T): T {
  if (items.length === 0) return fallback;
  return items[Math.floor(Math.random() * items.length)];
}

// Rewrites every question's leading number so it runs 1..N across all sections.
function renumberSections(sections: GeneratedSection[]): GeneratedSection[] {
  let number = 0;
  return sections.map((section) => ({
    ...section,
    questions: section.questions.map((question) => {
      number += 1;
      return { ...question, text: `${number}. ${question.text.replace(/^\s*\d+[.)]\s*/, "")}` };
    }),
  }));
}

const steps = [
  { number: "01", label: "Textbook", detail: "Add your source" },
  { number: "02", label: "Pattern", detail: "Set the blueprint" },
  { number: "03", label: "Design", detail: "Match your institution" },
  { number: "04", label: "Difficulty", detail: "Review & Generate" },
];

function App() {
  const [activeStep, setActiveStep] = useState(0);
  const [activeNav, setActiveNav] = useState("New paper");

  // Step 1: Textbook
  const [textbookFiles, setTextbookFiles] = useState<File[]>([]);
  const [fileName, setFileName] = useState("");
  const [fileCount, setFileCount] = useState(0);
  const [textbookText, setTextbookText] = useState("");
  const [extractedTopics, setExtractedTopics] = useState<string[]>([]);
  const [selectedTopics, setSelectedTopics] = useState<string[]>([]);
  const [topicSearch, setTopicSearch] = useState("");
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [uploadError, setUploadError] = useState("");

  // Step 2: Pattern
  const [patternMode, setPatternMode] = useState<"manual" | "upload">("manual");
  const [patternSections, setPatternSections] = useState<Array<{ count: number; marks: number; label?: string; caseBased?: boolean }>>([
    { count: 10, marks: 1, label: "Section A" },
    { count: 5, marks: 2, label: "Section B" },
    { count: 4, marks: 3, label: "Section C" },
    { count: 2, marks: 5, label: "Section D" },
  ]);
  const [duration, setDuration] = useState(90);
  const [patternFeedback, setPatternFeedback] = useState("");

  // Step 3: Design
  const [designMode, setDesignMode] = useState<"blueprint" | "standard">("blueprint");
  const [blueprintFile, setBlueprintFile] = useState<File | null>(null);
  const [blueprintLayout, setBlueprintLayout] = useState<BlueprintAnalysis | null>(null);
  const [standardBlueprintBytes, setStandardBlueprintBytes] = useState<Uint8Array | null>(null);
  const [standardConfig, setStandardConfig] = useState<StandardTemplateConfig>(DEFAULT_TEMPLATE_CONFIG);
  const [isBlueprintAnalyzing, setIsBlueprintAnalyzing] = useState(false);
  const [blueprintError, setBlueprintError] = useState("");
  const [warnings, setWarnings] = useState<string[]>([]);

  // Step 4: Difficulty & Draft Review & Output
  const [difficulty, setDifficulty] = useState("Moderate");
  const [draftedSections, setDraftedSections] = useState<GeneratedSection[]>(() =>
    draftQuestionSections({
      textbookText: "",
      selectedTopics: [],
      difficulty: "Moderate",
      patternSections: [
        { count: 10, marks: 1, label: "Section A" },
        { count: 5, marks: 2, label: "Section B" },
        { count: 4, marks: 3, label: "Section C" },
        { count: 2, marks: 5, label: "Section D" },
      ],
    }),
  );
  // Which inputs the current draft was built from, and whether the teacher has edited it since.
  const [draftSource, setDraftSource] = useState("");
  const [draftEdited, setDraftEdited] = useState(false);
  const [expandedSectionIndex, setExpandedSectionIndex] = useState<number>(0);
  const [isGeneratingPdf, setIsGeneratingPdf] = useState(false);
  const [generatedPdf, setGeneratedPdf] = useState<Blob | null>(null);
  const [generated, setGenerated] = useState(false);

  // Storage and Help
  const [recentPapers, setRecentPapers] = useState<StoredPaper[]>(() => loadRecentPapers());
  const [bankQuestions, setBankQuestions] = useState<StoredBankQuestion[]>(() => loadQuestionBank());
  const [bankSearch, setBankSearch] = useState("");
  const [bankMarkFilter, setBankMarkFilter] = useState<number | null>(null);
  const [isHelpOpen, setIsHelpOpen] = useState(false);
  const [testResults, setTestResults] = useState<any[] | null>(null);
  const [isRunningTests, setIsRunningTests] = useState(false);
  const [profile, setProfile] = useState(() => loadProfile());
  const profileInitials = profile.name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0].toUpperCase())
    .join("") || "?";

  const editProfile = () => {
    const name = window.prompt("Your name", profile.name);
    if (name === null) return;
    const department = window.prompt("Your department (e.g. Science department)", profile.department);
    if (department === null) return;
    const updated = { name: name.trim(), department: department.trim() };
    setProfile(updated);
    saveProfile(updated);
  };

  // In-app preview URL, released when a newer PDF replaces it
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const previewUrlRef = useRef<string | null>(null);
  const showGeneratedPdf = (blob: Blob | null) => {
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    previewUrlRef.current = blob ? URL.createObjectURL(blob) : null;
    setGeneratedPdf(blob);
    setPreviewUrl(previewUrlRef.current);
  };

  // Total marks calculation
  const totalMarks = useMemo(() => {
    return patternSections.reduce(
      (total, section) => total + section.count * section.marks,
      0,
    );
  }, [patternSections]);

  // Marks of the questions actually in the draft (differs from the pattern once questions are added or removed)
  const draftedTotalMarks = useMemo(
    () => draftedSections.reduce(
      (total, section) => total + section.questions.reduce((sum, question) => sum + (question.marks || 0), 0),
      0,
    ),
    [draftedSections],
  );

  // Move PDFs saved inline by older versions out of localStorage so it has room again.
  useEffect(() => {
    void migrateLegacyPaperPdfs().then(setRecentPapers);
  }, []);

  // Derived standard template config in sync with total marks and duration
  const effectiveStandardConfig = useMemo((): StandardTemplateConfig => ({
    ...standardConfig,
    durationMinutes: duration,
    maxMarks: totalMarks,
    sectionLabels: patternSections.map((s, i) => s.label || `Section ${String.fromCharCode(65 + i)}`),
    subjectName: standardConfig.subjectName || (selectedTopics[0] ? cleanTopicName(selectedTopics[0]) : "Science"),
  }), [standardConfig, duration, totalMarks, patternSections, selectedTopics]);

  // Auto-build standard blueprint when standard mode is active
  useEffect(() => {
    if (designMode !== "standard") return;
    let cancelled = false;
    async function initStandard() {
      try {
        setIsBlueprintAnalyzing(true);
        const [{ createStandardBlueprintPdf }, { analyzeBlueprintBytes }] = await Promise.all([loadStandardTemplate(), loadBlueprint()]);
        const bytes = await createStandardBlueprintPdf(effectiveStandardConfig);
        if (cancelled) return;
        const analysis = await analyzeBlueprintBytes(bytes);
        if (cancelled) return;
        setStandardBlueprintBytes(bytes);
        setBlueprintLayout(analysis);
        setBlueprintError("");
      } catch {
        if (!cancelled) {
          setBlueprintError("Failed to initialize standard template.");
        }
      } finally {
        if (!cancelled) setIsBlueprintAnalyzing(false);
      }
    }
    void initStandard();
    return () => {
      cancelled = true;
    };
  }, [designMode, effectiveStandardConfig]);

  // Topic hierarchy methods
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
    const { pdfjsLib } = await loadBlueprint();
    const document = await pdfjsLib.getDocument({
      data: new Uint8Array(await file.arrayBuffer()),
    }).promise;
    const pages: any[][] = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      pages.push(content.items as any[]);
    }
    return joinPdfPages(pages);
  };

  const extractDocumentText = async (file: File) => {
    if (file.name.toLowerCase().endsWith(".pdf")) return extractPdfText(file);
    const mammoth = await loadMammoth();
    const result = await mammoth.extractRawText({
      arrayBuffer: await file.arrayBuffer(),
    });
    return cleanBrokenKerningWords(result.value);
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
    const numberedHeadings = lines.flatMap((line) => {
      const match = line.match(/^(?:chapter\s+)?(\d+(?:\.\d+)*)(?:[.)])?\s+(.+)$/i);
      if (
        !match ||
        (chapterNumbers.size > 0 && !chapterNumbers.has(match[1].split(".")[0])) ||
        excludedLabel.test(match[2]) ||
        excludedLabel.test(line.slice(0, match.index || 0))
      ) return [];
      const marker = match[1];
      const label = cleanHeading(match[2]);
      if (
        !/^[A-Za-z]/.test(label) || /[.!?]$/.test(label) || label.split(" ").length > 30 ||
        (/^(what|which|how|why|when|where|define|state|explain|describe|give|list|identify)\b/i.test(label) && /^[0-9]+[.)]/.test(line))
      ) return [];
      return [`${marker} ${label}`];
    });
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

  const removeTextbook = (indexToRemove: number) => {
    const updated = textbookFiles.filter((_, idx) => idx !== indexToRemove);
    setTextbookFiles(updated);
    if (updated.length > 0) {
      void analyzeTextbook(updated);
    } else {
      setFileName("");
      setFileCount(0);
      setTextbookText("");
      setExtractedTopics([]);
      setSelectedTopics([]);
    }
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

  const draftSourceKey = (level: string) =>
    JSON.stringify([textbookText.length, textbookText.slice(0, 500), selectedTopics, patternSections, level]);

  const redraft = (level = difficulty) => {
    setDraftedSections(
      draftQuestionSections({
        textbookText,
        selectedTopics,
        difficulty: level,
        patternSections,
      }),
    );
    setDraftSource(draftSourceKey(level));
    setDraftEdited(false);
  };

  const confirmDiscardEdits = (message: string) => !draftEdited || window.confirm(message);

  // Entering the review step keeps the current draft (and any edits) unless its inputs changed.
  const refreshDraftOnEnter = () => {
    if (draftSourceKey(difficulty) === draftSource) return;
    if (!confirmDiscardEdits("Your textbook, topics or pattern changed since these questions were drafted. Redraft them now? Your edits on the review screen will be lost.")) return;
    redraft();
  };

  const goToStep = (index: number) => {
    if (index === 3) refreshDraftOnEnter();
    setActiveStep(index);
  };

  const nextStep = () => {
    const next = Math.min(activeStep + 1, steps.length - 1);
    if (next === 3) refreshDraftOnEnter();
    setActiveStep(next);
  };

  // Step 2 Pattern Handlers
  const updatePatternSection = (
    index: number,
    field: "count" | "marks" | "label" | "caseBased",
    value: any,
  ) =>
    setPatternSections((current) =>
      current.map((section, sectionIndex) =>
        sectionIndex === index
          ? {
              ...section,
              [field]:
                field === "label"
                  ? String(value)
                  : field === "caseBased"
                    ? Boolean(value)
                    : Math.max(field === "marks" ? 1 : 0, Number(value)),
            }
          : section,
      ),
    );

  const addPatternSection = () =>
    setPatternSections((current) => [
      ...current,
      {
        count: 1,
        marks: 1,
        label: `Section ${String.fromCharCode(65 + current.length)}`,
      },
    ]);

  const removePatternSection = (index: number) => {
    if (patternSections.length <= 1) return;
    setPatternSections((current) => current.filter((_, i) => i !== index));
  };

  const handlePatternFileUpload = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    setPatternFeedback("Reading pattern file…");
    try {
      const text = await extractTextFromPatternFile(file);
      const parsed = parsePatternText(text);
      if (parsed.sections.length === 0) {
        setPatternFeedback(
          `No sections could be recognised in "${file.name}". Your current pattern was kept; please check the file or use manual setup.`,
        );
        return;
      }
      setPatternSections(parsed.sections);
      if (parsed.duration) {
        setDuration(parsed.duration);
      }
      const loadedTotal = parsed.sections.reduce((t, s) => t + s.count * s.marks, 0);
      const statedTotal = parsed.totalMarks && parsed.totalMarks !== loadedTotal
        ? ` The file states ${parsed.totalMarks} marks, so please check the sections.`
        : "";
      setPatternFeedback(
        `Loaded ${parsed.sections.length} sections from "${file.name}" (Total ${loadedTotal} marks).${statedTotal}`,
      );
    } catch {
      setPatternFeedback("Could not parse this pattern file. Please use manual setup.");
    }
  };

  // Step 3 Blueprint Handlers
  const handleBlueprintFile = async (file: File) => {
    setBlueprintFile(file);
    showGeneratedPdf(null);
    setBlueprintLayout(null);
    setBlueprintError("");
    setWarnings([]);
    setGenerated(false);
    setIsBlueprintAnalyzing(true);
    try {
      const { analyzeBlueprint } = await loadBlueprint();
      const analysis = await analyzeBlueprint(file);
      setBlueprintLayout(analysis);
      setWarnings(analysis.warnings);
    } catch (error) {
      setBlueprintFile(null);
      setBlueprintError(
        error instanceof Error && error.name === "BlueprintAnalysisError"
          ? error.message
          : "This PDF could not be read. Please upload a valid blueprint PDF.",
      );
      setWarnings([]);
    } finally {
      setIsBlueprintAnalyzing(false);
    }
  };

  // Step 4 Question Editing Handlers
  const updateQuestionText = (sectionIndex: number, questionIndex: number, newText: string) => {
    setDraftEdited(true);
    setDraftedSections((prev) =>
      prev.map((s, sIdx) =>
        sIdx === sectionIndex
          ? {
              ...s,
              questions: s.questions.map((q, qIdx) =>
                qIdx === questionIndex ? { ...q, text: newText } : q,
              ),
            }
          : s,
      ),
    );
  };

  const updateQuestionOption = (
    sectionIndex: number,
    questionIndex: number,
    optIndex: number,
    newOptText: string,
  ) => {
    setDraftEdited(true);
    setDraftedSections((prev) =>
      prev.map((s, sIdx) =>
        sIdx === sectionIndex
          ? {
              ...s,
              questions: s.questions.map((q, qIdx) =>
                qIdx === questionIndex && q.options
                  ? {
                      ...q,
                      options: q.options.map((opt, oIdx) =>
                        oIdx === optIndex ? newOptText : opt,
                      ),
                      // Editing the correct option's wording keeps it marked as correct.
                      answer: q.answer === q.options[optIndex] ? newOptText : q.answer,
                    }
                  : q,
              ),
            }
          : s,
      ),
    );
  };

  const updateQuestionAlternative = (
    sectionIndex: number,
    questionIndex: number,
    newAltText: string,
  ) => {
    setDraftEdited(true);
    setDraftedSections((prev) =>
      prev.map((s, sIdx) =>
        sIdx === sectionIndex
          ? {
              ...s,
              questions: s.questions.map((q, qIdx) =>
                qIdx === questionIndex ? { ...q, alternative: newAltText } : q,
              ),
            }
          : s,
      ),
    );
  };

  // Applies an edit to one drafted question.
  const patchQuestion = (
    sectionIndex: number,
    questionIndex: number,
    patch: (question: GeneratedQuestion) => GeneratedQuestion,
  ) => {
    setDraftEdited(true);
    setDraftedSections((prev) =>
      prev.map((s, sIdx) =>
        sIdx === sectionIndex
          ? { ...s, questions: s.questions.map((q, qIdx) => (qIdx === questionIndex ? patch(q) : q)) }
          : s,
      ),
    );
  };

  const updateQuestionAnswer = (sectionIndex: number, questionIndex: number, answer: string) =>
    patchQuestion(sectionIndex, questionIndex, (q) => ({ ...q, answer }));

  const updateQuestionPart = (
    sectionIndex: number,
    questionIndex: number,
    partIndex: number,
    field: "text" | "answer" | "alternative",
    value: string,
  ) =>
    patchQuestion(sectionIndex, questionIndex, (q) => ({
      ...q,
      parts: q.parts?.map((part, pIdx) =>
        pIdx !== partIndex
          ? part
          : field === "alternative"
            ? { ...part, alternative: { ...part.alternative, text: value } }
            : { ...part, [field]: value },
      ),
    }));

  // Each regenerate picks a different passage for case-based questions.
  const regenerateCount = useRef(0);
  const regenerateQuestion = (sectionIndex: number, questionIndex: number) => {
    const sentences = extractCleanSentences(textbookText);
    const topics = selectedTopics.length > 0 ? selectedTopics : ["General Concept"];
    const topic = topics[(sectionIndex + questionIndex + 1) % topics.length];
    const sentence = pickRandomItem(sentences, topic);
    const current = draftedSections[sectionIndex]?.questions[questionIndex];
    const marks = current?.marks || 1;

    const freshCase = current?.kind === "case"
      ? generateCaseQuestion(pickRandomItem(topics, topic), textbookText, marks, difficulty, (regenerateCount.current += 1) * 7 + questionIndex)
      : null;
    const fresh = freshCase || generateSingleQuestion(
      topic,
      sentence,
      marks,
      difficulty,
      questionIndex + 1,
      sentences,
    );

    setDraftEdited(true);
    setDraftedSections((prev) =>
      renumberSections(prev.map((s, sIdx) =>
        sIdx === sectionIndex
          ? {
              ...s,
              questions: s.questions.map((q, qIdx) =>
                qIdx === questionIndex ? fresh : q,
              ),
            }
          : s,
      )),
    );
  };

  const deleteQuestionFromSection = (sectionIndex: number, questionIndex: number) => {
    setDraftEdited(true);
    setDraftedSections((prev) =>
      renumberSections(prev.map((s, sIdx) =>
        sIdx === sectionIndex
          ? {
              ...s,
              questions: s.questions.filter((_, qIdx) => qIdx !== questionIndex),
            }
          : s,
      )),
    );
  };

  const addCustomQuestionToSection = (sectionIndex: number) => {
    const section = draftedSections[sectionIndex];
    if (!section) return;
    const marks = section.questions[0]?.marks || 1;
    const newQ = {
      text: "State and explain the key principle regarding this concept.",
      marks,
    };
    setDraftEdited(true);
    setDraftedSections((prev) =>
      renumberSections(prev.map((s, sIdx) =>
        sIdx === sectionIndex ? { ...s, questions: [...s.questions, newQ] } : s,
      )),
    );
  };

  const downloadPdf = (blob: Blob, fileName = "qp-setter-blueprint.pdf") => {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const paperTitle = () =>
    designMode === "blueprint" && blueprintFile ? blueprintFile.name.replace(/\.pdf$/i, "") : standardConfig.examTitle;

  // A separate teacher's copy, so the question paper itself never carries the answers.
  const downloadAnswerKey = async () => {
    try {
      const { createAnswerKeyPdf } = await import("./answer-key");
      const bytes = await createAnswerKeyPdf(draftedSections, paperTitle(), draftedTotalMarks);
      downloadPdf(new Blob([new Uint8Array(bytes).buffer], { type: "application/pdf" }), "qp-setter-answer-key.pdf");
    } catch {
      setWarnings((current) => [...current, "The answer key could not be created. Please try again."]);
    }
  };

  const generatePdf = async () => {
    const layout = blueprintLayout;
    if (!layout || layout.regions.length === 0) return;

    setIsGeneratingPdf(true);
    setWarnings([]);

    try {
      let inputBytes: Uint8Array | ArrayBuffer;
      if (designMode === "blueprint" && blueprintFile) {
        inputBytes = await blueprintFile.arrayBuffer();
      } else if (standardBlueprintBytes) {
        inputBytes = standardBlueprintBytes;
      } else {
        const { createStandardBlueprintPdf } = await loadStandardTemplate();
        const generatedBytes = await createStandardBlueprintPdf(standardConfig);
        inputBytes = generatedBytes;
      }

      const { fillBlueprintPdf } = await loadReflow();
      const result = await fillBlueprintPdf(
        inputBytes,
        layout,
        draftedSections,
        new URLSearchParams(window.location.search).get("debug") === "1",
        { durationMinutes: duration },
      );

      setWarnings(result.warnings);
      const blob = new Blob([new Uint8Array(result.bytes).buffer], {
        type: "application/pdf",
      });
      showGeneratedPdf(blob);
      setGenerated(true);

      // Save to Recent Papers and Question Bank
      const paperId = `paper_${Date.now()}`;
      const pdfSaved = await savePaperPdf(paperId, blob);
      const paperRecord: StoredPaper = {
        id: paperId,
        createdAt: new Date().toISOString(),
        title: paperTitle(),
        subject: standardConfig.subjectName,
        className: standardConfig.className,
        totalMarks: draftedTotalMarks,
        duration,
        difficulty,
        questionCount: draftedSections.reduce((acc, s) => acc + s.questions.length, 0),
        sections: draftedSections,
        hasPdf: pdfSaved,
      };
      const { paperSaved, bankSaved } = saveRecentPaper(paperRecord);
      const storageProblems = [
        !paperSaved && "Recent papers",
        !pdfSaved && "the saved PDF copy",
        !bankSaved && "the Question bank",
      ].filter(Boolean);
      if (storageProblems.length) {
        setWarnings((current) => [
          ...current,
          `Your paper was generated, but the browser's storage is full, so ${storageProblems.join(", ")} could not be updated. Download the PDF now, and delete old papers or bank questions to free space.`,
        ]);
      }
      setRecentPapers(loadRecentPapers());
      setBankQuestions(loadQuestionBank());
    } catch {
      setWarnings((current) => [
        ...current,
        "We couldn't place questions safely in this PDF. The original blueprint was left unchanged.",
      ]);
    } finally {
      setIsGeneratingPdf(false);
    }
  };

  const runTestFixtures = async () => {
    setIsRunningTests(true);
    setTestResults(null);
    try {
      const { runBlueprintQualityCases } = await import("./blueprint-quality");
      const results = await runBlueprintQualityCases();
      setTestResults(results);
    } catch (e) {
      console.error("Test execution failed:", e);
    } finally {
      setIsRunningTests(false);
    }
  };

  // Filtered topics for Step 1
  const filteredTopics = useMemo(() => {
    if (!topicSearch.trim()) return extractedTopics;
    return extractedTopics.filter((t) =>
      t.toLowerCase().includes(topicSearch.toLowerCase()),
    );
  }, [extractedTopics, topicSearch]);

  // Filtered bank questions for Question Bank view
  const filteredBankQuestions = useMemo(() => {
    return bankQuestions.filter((q) => {
      const matchesSearch =
        !bankSearch.trim() ||
        q.text.toLowerCase().includes(bankSearch.toLowerCase()) ||
        q.paperTitle?.toLowerCase().includes(bankSearch.toLowerCase());
      const matchesMarks = bankMarkFilter === null || q.marks === bankMarkFilter;
      return matchesSearch && matchesMarks;
    });
  }, [bankQuestions, bankSearch, bankMarkFilter]);

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
            <span className="count">{bankQuestions.length}</span>
          </button>
          <button
            className={`nav-item ${activeNav === "Recent papers" ? "active" : ""}`}
            onClick={() => setActiveNav("Recent papers")}
          >
            <span className="nav-icon">◷</span>Recent papers{" "}
            {recentPapers.length > 0 && <span className="count">{recentPapers.length}</span>}
          </button>
        </nav>
        <div className="sidebar-bottom">
          <div className="bank-note">
            <span className="spark">✦</span>
            <div>
              <strong>Your bank is growing</strong>
              <small>{bankQuestions.length} unique questions saved</small>
            </div>
          </div>
          <button className="profile" onClick={editProfile} title="Edit your name and department">
            <span className="avatar">{profileInitials}</span>
            <span>
              <strong>{profile.name || "Add your name"}</strong>
              <small>{profile.department || "Click to set department"}</small>
            </span>
            <span className="dots">···</span>
          </button>
        </div>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <div className="crumb">
            Workspace <span>/</span>{" "}
            <strong>
              {activeNav === "New paper"
                ? "New question paper"
                : activeNav === "Question bank"
                  ? "Question Bank"
                  : "Recent Papers"}
            </strong>
          </div>
          <button className="help" onClick={() => setIsHelpOpen(true)}>
            ? <span>Help &amp; Quality QA</span>
          </button>
        </header>

        <div className="content-wrap">
          {/* QUESTION BANK VIEW */}
          {activeNav === "Question bank" && (
            <div className="bank-container">
              <section className="page-intro">
                <div>
                  <p className="eyebrow">QUESTION BANK <span className="line" /></p>
                  <h1>Browse your <em>curated questions.</em></h1>
                  <p className="intro-copy">Every question you generate or review is saved here for reuse.</p>
                </div>
              </section>

              <div className="bank-controls">
                <input
                  type="text"
                  className="bank-search"
                  placeholder="Search questions by text or source exam…"
                  value={bankSearch}
                  onChange={(e) => setBankSearch(e.target.value)}
                />
                <div className="filter-pills">
                  <button
                    className={`filter-pill ${bankMarkFilter === null ? "active" : ""}`}
                    onClick={() => setBankMarkFilter(null)}
                  >
                    All Marks
                  </button>
                  {[1, 2, 3, 5].map((m) => (
                    <button
                      key={m}
                      className={`filter-pill ${bankMarkFilter === m ? "active" : ""}`}
                      onClick={() => setBankMarkFilter(m)}
                    >
                      {m} Mark{m > 1 ? "s" : ""}
                    </button>
                  ))}
                </div>
              </div>

              {filteredBankQuestions.length === 0 ? (
                <div className="empty-state">
                  <span>▦</span>
                  <h3>No questions match your filter</h3>
                  <p>Generate papers to populate your question bank or adjust your search.</p>
                </div>
              ) : (
                <div className="bank-grid">
                  {filteredBankQuestions.map((q) => (
                    <div key={q.id} className="bank-card">
                      <div className="bank-card-meta">
                        <span className="marks-badge">{q.marks} Mark{q.marks > 1 ? "s" : ""}</span>
                        <span>{q.dateAdded}</span>
                      </div>
                      <p className="bank-card-text">{q.text}</p>
                      {q.options && q.options.length > 0 && (
                        <div className="bank-card-options">
                          {q.options.map((opt, i) => (
                            <span key={i}>{String.fromCharCode(97 + i)}) {opt}</span>
                          ))}
                        </div>
                      )}
                      {q.alternative && (
                        <div className="bank-card-options" style={{ borderColor: "#d9a566" }}>
                          <span style={{ color: "#9c6827" }}>OR: {q.alternative}</span>
                        </div>
                      )}
                      <div className="bank-card-footer">
                        <small style={{ color: "#8a968f" }}>{q.paperTitle || "Saved question"}</small>
                        <div style={{ display: "flex", gap: "6px" }}>
                          <button
                            className="q-action-btn"
                            onClick={() => {
                              navigator.clipboard.writeText(q.text);
                              alert("Question copied to clipboard!");
                            }}
                          >
                            Copy
                          </button>
                          <button
                            className="q-delete-btn"
                            onClick={() => setBankQuestions(deleteBankQuestion(q.id))}
                          >
                            ×
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* RECENT PAPERS VIEW */}
          {activeNav === "Recent papers" && (
            <div className="recent-container">
              <section className="page-intro">
                <div>
                  <p className="eyebrow">RECENT PAPERS <span className="line" /></p>
                  <h1>Archived question <em>papers.</em></h1>
                  <p className="intro-copy">View, re-download, or inspect papers generated in this workspace.</p>
                </div>
              </section>

              {recentPapers.length === 0 ? (
                <div className="empty-state">
                  <span>◷</span>
                  <h3>No papers generated yet</h3>
                  <p>Ready to set your next exam paper?</p>
                  <button className="next-button" onClick={() => setActiveNav("New paper")}>
                    Start New Paper <span>→</span>
                  </button>
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                  {recentPapers.map((paper) => (
                    <div key={paper.id} className="recent-card">
                      <div className="recent-details">
                        <h3>{paper.title}</h3>
                        <p>
                          Generated on {new Date(paper.createdAt).toLocaleDateString()} · {paper.subject} · {paper.className}
                        </p>
                        <div className="recent-tags">
                          <span className="recent-tag">{paper.totalMarks} Marks</span>
                          <span className="recent-tag">{paper.duration} Minutes</span>
                          <span className="recent-tag">{paper.questionCount} Questions</span>
                          <span className="recent-tag">{paper.difficulty}</span>
                        </div>
                      </div>
                      <div className="recent-actions">
                        {(paper.hasPdf || paper.pdfBase64) && (
                          <button
                            className="next-button"
                            onClick={async () => {
                              let blob: Blob | null = null;
                              if (paper.pdfBase64) {
                                const arr = Uint8Array.from(atob(paper.pdfBase64.split(",")[1]), (c) => c.charCodeAt(0));
                                blob = new Blob([arr], { type: "application/pdf" });
                              } else {
                                blob = await loadPaperPdf(paper.id);
                              }
                              if (blob) downloadPdf(blob);
                              else window.alert("The saved PDF for this paper is no longer available in this browser.");
                            }}
                          >
                            Download PDF
                          </button>
                        )}
                        <button
                          className="q-delete-btn"
                          onClick={() => setRecentPapers(deleteRecentPaper(paper.id))}
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* NEW PAPER CREATION WIZARD */}
          {activeNav === "New paper" && (
            <>
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
                    ) : activeStep === 1 ? (
                      <>
                        Configure your
                        <br />
                        <em>question pattern.</em>
                      </>
                    ) : activeStep === 2 ? (
                      <>
                        Match your
                        <br />
                        <em>institution design.</em>
                      </>
                    ) : (
                      <>
                        Tune challenge &amp;
                        <br />
                        <em>review paper.</em>
                      </>
                    )}
                  </h1>
                  <p className="intro-copy">
                    {activeStep === 0
                      ? "Upload your source material and choose the chapters and topics you want to use."
                      : activeStep === 1
                        ? "Define sections, mark weights, and exam duration for your institution."
                        : activeStep === 2
                          ? "Upload an existing institutional blueprint PDF or use our standard header template."
                          : "Inspect drafted questions, make live edits, and generate your ready-to-print PDF."}
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
                    onClick={() => goToStep(index)}
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

              {/* STEP 1: TEXTBOOK */}
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

                    {textbookFiles.length > 0 && (
                      <div className="file-tag-list">
                        {textbookFiles.map((file, idx) => (
                          <span key={`${file.name}-${idx}`} className="file-tag">
                            📄 {file.name}
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                removeTextbook(idx);
                              }}
                            >
                              ×
                            </button>
                          </span>
                        ))}
                      </div>
                    )}

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

                        {extractedTopics.length > 5 && (
                          <input
                            type="text"
                            className="topic-search-input"
                            placeholder="Filter topics list…"
                            value={topicSearch}
                            onChange={(e) => setTopicSearch(e.target.value)}
                          />
                        )}

                        <div className="topic-list">
                          {filteredTopics.map((topic) => {
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

              {/* STEP 2: PATTERN */}
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
                          <span>Section &amp; Count</span>
                          <span>Marks</span>
                        </div>
                        {patternSections.map((section, index) => (
                          <div className="pattern-row-custom" key={index}>
                            <input
                              className="pattern-label-input"
                              type="text"
                              value={section.label || `Section ${String.fromCharCode(65 + index)}`}
                              onChange={(e) =>
                                updatePatternSection(index, "label", e.target.value)
                              }
                            />
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
                            <span>qs ×</span>
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
                            <label className="case-toggle" title="Passage with (i), (ii), (iii) sub-questions, as in CBSE Section E">
                              <input
                                type="checkbox"
                                checked={isCaseBasedSection(section)}
                                onChange={(event) => updatePatternSection(index, "caseBased", event.target.checked)}
                              />
                              Case-based
                            </label>
                            {patternSections.length > 1 && (
                              <button
                                type="button"
                                className="pattern-delete-btn"
                                onClick={() => removePatternSection(index)}
                                title="Remove section"
                              >
                                ×
                              </button>
                            )}
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
                      <div>
                        <label className="compact-upload" style={{ cursor: "pointer" }}>
                          <input
                            type="file"
                            accept=".pdf,.doc,.docx,.txt,.json"
                            onChange={(e) => handlePatternFileUpload(e.target.files)}
                          />
                          <span>＋</span> Upload one or more pattern files (PDF, DOCX, TXT)
                        </label>
                        {patternFeedback && (
                          <div className="pattern-feedback">{patternFeedback}</div>
                        )}
                      </div>
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

              {/* STEP 3: DESIGN / BLUEPRINT */}
              {activeStep === 2 && (
                <section className="single-panel">
                  <div className="mini-card large-card">
                    <div className="mini-title">
                      <span className="section-index">03</span>
                      <div>
                        <h2>Institution Design</h2>
                        <p>Upload your institutional blueprint PDF or use our standard template.</p>
                      </div>
                    </div>

                    <div className="segmented" style={{ marginBottom: "18px" }}>
                      <button
                        className={designMode === "blueprint" ? "on" : ""}
                        onClick={() => setDesignMode("blueprint")}
                      >
                        Upload Blueprint PDF
                      </button>
                      <button
                        className={designMode === "standard" ? "on" : ""}
                        onClick={() => setDesignMode("standard")}
                      >
                        Standard Institution Template
                      </button>
                    </div>

                    {designMode === "blueprint" ? (
                      <>
                        <label className="design-upload">
                          <input
                            type="file"
                            accept=".pdf,application/pdf"
                            onChange={(event) => {
                              const file = event.currentTarget.files?.[0];
                              if (file) void handleBlueprintFile(file);
                              event.currentTarget.value = "";
                            }}
                          />
                          <span className="doc-icon">▤</span>
                          <span>
                            <strong>Choose blueprint PDF</strong>
                            <small>PDF only · headers, borders &amp; footers preserved</small>
                          </span>
                          <span className="design-upload-add" aria-hidden="true">＋</span>
                        </label>

                        {isBlueprintAnalyzing && (
                          <p className="blueprint-status">Analyzing blueprint layout…</p>
                        )}
                        {blueprintError && <p className="upload-error">{blueprintError}</p>}
                        {blueprintFile && blueprintLayout && (
                          <p className="blueprint-status">
                            Blueprint loaded: <strong>{blueprintFile.name}</strong> —{" "}
                            {blueprintLayout.tier === 3 ? 0 : blueprintLayout.regions.length} sections detected
                            {blueprintLayout.tier !== 3
                              ? ` (${blueprintLayout.regions.map((region) => region.label).join(", ")})`
                              : ""}
                          </p>
                        )}
                      </>
                    ) : (
                      <div className="standard-template-form">
                        <div className="form-grid-2">
                          <label className="form-field">
                            Institution / School Name
                            <input
                              type="text"
                              value={standardConfig.schoolName}
                              onChange={(e) =>
                                setStandardConfig((prev) => ({ ...prev, schoolName: e.target.value }))
                              }
                            />
                          </label>
                          <label className="form-field">
                            Examination Title
                            <input
                              type="text"
                              value={standardConfig.examTitle}
                              onChange={(e) =>
                                setStandardConfig((prev) => ({ ...prev, examTitle: e.target.value }))
                              }
                            />
                          </label>
                        </div>
                        <div className="form-grid-2">
                          <label className="form-field">
                            Class / Grade
                            <input
                              type="text"
                              value={standardConfig.className}
                              onChange={(e) =>
                                setStandardConfig((prev) => ({ ...prev, className: e.target.value }))
                              }
                            />
                          </label>
                          <label className="form-field">
                            Subject
                            <input
                              type="text"
                              value={standardConfig.subjectName}
                              onChange={(e) =>
                                setStandardConfig((prev) => ({ ...prev, subjectName: e.target.value }))
                              }
                            />
                          </label>
                        </div>
                        <label className="form-field">
                          General Instructions (one per line)
                          <textarea
                            value={standardConfig.generalInstructions.join("\n")}
                            onChange={(e) =>
                              setStandardConfig((prev) => ({
                                ...prev,
                                generalInstructions: e.target.value.split(/\r?\n/).filter(Boolean),
                              }))
                            }
                          />
                        </label>
                        <div className="template-ready-pill">
                          ✓ Standard institutional template ready ({patternSections.length} sections, {totalMarks} marks)
                        </div>
                      </div>
                    )}

                    {warnings.length > 0 && (
                      <ul className="generation-warnings">
                        {warnings.map((warning) => (
                          <li key={warning}>{warning}</li>
                        ))}
                      </ul>
                    )}

                    <div className="panel-actions">
                      <button
                        className="back-button"
                        onClick={() => setActiveStep(1)}
                      >
                        ← Back
                      </button>
                      <button
                        className="next-button"
                        onClick={nextStep}
                        disabled={designMode === "blueprint" && (!blueprintFile || !blueprintLayout)}
                      >
                        Continue to questions <span>→</span>
                      </button>
                    </div>
                  </div>
                </section>
              )}

              {/* STEP 4: DIFFICULTY & REVIEW / GENERATE */}
              {activeStep === 3 && (
                <section className="single-panel">
                  <div className="mini-card large-card difficulty-card">
                    <div className="mini-title">
                      <span className="section-index">04</span>
                      <div>
                        <h2>Review &amp; Generate Paper</h2>
                        <p>Tune difficulty, edit question texts, and preview the final ready-to-print document.</p>
                      </div>
                    </div>

                    <div className="difficulty-options">
                      {["Easy", "Moderate", "Advanced", "Application"].map(
                        (level) => (
                          <button
                            key={level}
                            className={`difficulty ${level.toLowerCase()} ${difficulty === level ? "active-diff" : ""}`}
                            onClick={() => {
                              if (level === difficulty) return;
                              if (!confirmDiscardEdits(`Switching to ${level} redrafts all questions. Your edits will be lost. Continue?`)) return;
                              setDifficulty(level);
                              redraft(level);
                            }}
                          >
                            <i />
                            {level}
                          </button>
                        ),
                      )}
                    </div>

                    {/* QUESTION REVIEW & EDITOR SECTION */}
                    <div className="question-review-wrap">
                      <div className="review-header">
                        <div>
                          <h3>Questions Preview &amp; Editor</h3>
                          <p>
                            Review or modify any question before generating the final PDF.
                            Paper total: <strong>{draftedTotalMarks} marks</strong>
                            {draftedTotalMarks !== totalMarks && ` (your pattern was ${totalMarks} marks)`}.
                          </p>
                        </div>
                        <button
                          className="q-action-btn"
                          onClick={() => {
                            if (!confirmDiscardEdits("Redraft all questions? Your edits will be lost.")) return;
                            redraft();
                          }}
                        >
                          ↻ Redraft all
                        </button>
                      </div>

                      {draftedSections.map((section, sIdx) => (
                        <div key={`${sIdx}-${section.label}`} className="section-accordion">
                          <div
                            className="section-accordion-header"
                            onClick={() =>
                              setExpandedSectionIndex(expandedSectionIndex === sIdx ? -1 : sIdx)
                            }
                          >
                            <strong>{section.label}</strong>
                            <span>
                              {section.questions.length} Questions (
                              {section.questions.reduce((sum, q) => sum + (q.marks || 1), 0)} Marks){" "}
                              {expandedSectionIndex === sIdx ? "▲" : "▼"}
                            </span>
                          </div>

                          {expandedSectionIndex === sIdx && (
                            <div className="questions-list">
                              {section.questions.map((q, qIdx) => (
                                <div key={qIdx} className="question-card">
                                  <div className="question-card-top">
                                    <span className="marks-badge">{q.marks || 1} Mark{(q.marks || 1) > 1 ? "s" : ""}</span>
                                    <div className="q-actions">
                                      <button
                                        type="button"
                                        className="q-action-btn"
                                        onClick={() => regenerateQuestion(sIdx, qIdx)}
                                        title="Regenerate this question with different topic angle"
                                      >
                                        ↻ Regenerate
                                      </button>
                                      <button
                                        type="button"
                                        className="q-delete-btn"
                                        onClick={() => deleteQuestionFromSection(sIdx, qIdx)}
                                        title="Delete question"
                                      >
                                        ×
                                      </button>
                                    </div>
                                  </div>

                                  <textarea
                                    value={q.text}
                                    onChange={(e) => updateQuestionText(sIdx, qIdx, e.target.value)}
                                  />

                                  {q.options && q.options.length > 0 && (
                                    <div className="options-edit-grid">
                                      {q.options.map((opt, oIdx) => (
                                        <div key={oIdx} className="option-input-wrap">
                                          <span>{String.fromCharCode(97 + oIdx)})</span>
                                          <input
                                            type="text"
                                            value={opt}
                                            onChange={(e) =>
                                              updateQuestionOption(sIdx, qIdx, oIdx, e.target.value)
                                            }
                                          />
                                        </div>
                                      ))}
                                    </div>
                                  )}

                                  {q.options && q.options.length > 0 && (
                                    <label className="answer-wrap">
                                      <strong>Correct answer:</strong>
                                      <select
                                        value={q.options.findIndex((opt) => opt === q.answer)}
                                        onChange={(e) => updateQuestionAnswer(sIdx, qIdx, q.options?.[Number(e.target.value)] || "")}
                                      >
                                        <option value={-1} disabled>Choose the correct option</option>
                                        {q.options.map((opt, oIdx) => (
                                          <option key={oIdx} value={oIdx}>
                                            {String.fromCharCode(97 + oIdx)}) {opt}
                                          </option>
                                        ))}
                                      </select>
                                    </label>
                                  )}

                                  {q.parts?.map((part, pIdx) => (
                                    <div key={pIdx} className="case-part">
                                      <strong>({["i", "ii", "iii", "iv", "v"][pIdx] || pIdx + 1}) · {part.marks} mark{part.marks > 1 ? "s" : ""}</strong>
                                      <textarea
                                        value={part.text}
                                        onChange={(e) => updateQuestionPart(sIdx, qIdx, pIdx, "text", e.target.value)}
                                      />
                                      {part.alternative && (
                                        <>
                                          <strong>OR</strong>
                                          <textarea
                                            value={part.alternative.text}
                                            onChange={(e) => updateQuestionPart(sIdx, qIdx, pIdx, "alternative", e.target.value)}
                                          />
                                        </>
                                      )}
                                      <label className="answer-wrap">
                                        <strong>Answer key:</strong>
                                        <input
                                          type="text"
                                          value={part.answer || ""}
                                          onChange={(e) => updateQuestionPart(sIdx, qIdx, pIdx, "answer", e.target.value)}
                                        />
                                      </label>
                                    </div>
                                  ))}

                                  {q.alternative && (
                                    <div className="alternative-wrap">
                                      <strong>OR Alternative Choice:</strong>
                                      <textarea
                                        value={typeof q.alternative === "string" ? q.alternative : q.alternative?.text}
                                        onChange={(e) =>
                                          updateQuestionAlternative(sIdx, qIdx, e.target.value)
                                        }
                                      />
                                    </div>
                                  )}

                                  {!q.options?.length && !q.parts?.length && (
                                    <label className="answer-wrap">
                                      <strong>Key point for marking:</strong>
                                      <input
                                        type="text"
                                        value={q.answer || ""}
                                        placeholder="What a full-marks answer must mention"
                                        onChange={(e) => updateQuestionAnswer(sIdx, qIdx, e.target.value)}
                                      />
                                    </label>
                                  )}
                                </div>
                              ))}

                              <button
                                type="button"
                                className="add-q-btn"
                                onClick={() => addCustomQuestionToSection(sIdx)}
                              >
                                ＋ Add Question to {section.label}
                              </button>
                            </div>
                          )}
                        </div>
                      ))}
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
                        disabled={
                          isGeneratingPdf ||
                          (designMode === "blueprint" && (!blueprintFile || !blueprintLayout)) ||
                          draftedSections.length === 0
                        }
                      >
                        {isGeneratingPdf
                          ? "Generating PDF…"
                          : generated
                            ? "Regenerate PDF"
                            : "Generate question paper"}{" "}
                        <span>→</span>
                      </button>
                    </div>

                    {/* IN-APP PDF PREVIEW */}
                    {previewUrl && (
                      <div className="pdf-viewer-container">
                        <div className="pdf-viewer-bar">
                          <strong>PDF Preview</strong>
                          <div className="pdf-viewer-bar-actions">
                            <button
                              className="next-button"
                              onClick={() => generatedPdf && downloadPdf(generatedPdf)}
                            >
                              Download PDF
                            </button>
                            <button className="next-button" onClick={() => void downloadAnswerKey()}>
                              Download answer key
                            </button>
                          </div>
                        </div>
                        <iframe
                          className="pdf-viewer-frame"
                          src={previewUrl}
                          title="Generated Question Paper Preview"
                        />
                      </div>
                    )}
                  </div>
                </section>
              )}
            </>
          )}
        </div>
      </main>

      {/* HELP AND QUALITY TEST MODAL */}
      {isHelpOpen && (
        <div className="modal-overlay" onClick={() => setIsHelpOpen(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>Help &amp; Quality QA Runner</h2>
              <button className="modal-close" onClick={() => setIsHelpOpen(false)}>
                ×
              </button>
            </div>
            <div>
              <p style={{ fontSize: "12px", color: "#56675e", lineHeight: 1.6 }}>
                <strong>QP Setter</strong> builds question papers matching your institution's voice and typography.
              </p>
              <ul style={{ fontSize: "11px", color: "#677970", marginTop: "8px", paddingLeft: "18px" }}>
                <li>Step 1: Upload your course material (PDF or DOCX) to extract topics.</li>
                <li>Step 2: Set your question pattern (sections, counts, and marks).</li>
                <li>Step 3: Upload a previous blueprint PDF or use our Standard Institutional Header.</li>
                <li>Step 4: Review questions, customize prompts, and download or preview your paper.</li>
              </ul>
            </div>

            <div style={{ marginTop: "16px", borderTop: "1px solid #e2e8e0", paddingTop: "14px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <strong>Blueprint Quality Test Suite</strong>
                <button
                  className="next-button"
                  style={{ padding: "8px 12px", fontSize: "10px" }}
                  onClick={runTestFixtures}
                  disabled={isRunningTests}
                >
                  {isRunningTests ? "Running 8 fixtures…" : "Run Quality Suite"}
                </button>
              </div>

              {testResults && (
                <table className="test-table">
                  <thead>
                    <tr>
                      <th>Test Fixture</th>
                      <th>Tier</th>
                      <th>Font</th>
                      <th>Header Preserved</th>
                      <th>No Overlap</th>
                      <th>Continuous #</th>
                    </tr>
                  </thead>
                  <tbody>
                    {testResults.map((r, i) => (
                      <tr key={i}>
                        <td>{r.case}</td>
                        <td>{r.tier}</td>
                        <td>{r.paperFont || "Helvetica"}</td>
                        <td className={r.headerPreserved ? "test-passed" : "test-failed"}>
                          {r.headerPreserved ? "✓" : "—"}
                        </td>
                        <td className={r.noTextOverlap ? "test-passed" : "test-failed"}>
                          {r.noTextOverlap ? "✓" : "✗"}
                        </td>
                        <td className={r.numberingContinuous ? "test-passed" : "test-failed"}>
                          {r.numberingContinuous ? "✓" : "✗"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
