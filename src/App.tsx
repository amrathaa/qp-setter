import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import type { BlueprintAnalysis, GeneratedQuestion, GeneratedSection } from "./blueprint";
import {
  DEFAULT_TEMPLATE_CONFIG,
  type StandardTemplateConfig,
} from "./standard-template-config";
import {
  draftQuestionSections,
  generateSingleQuestion,
  generateCaseQuestion,
  levelForQuestion,
  isCaseBasedSection,
  isMcqSection,
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
  requestPersistentStorage,
  savePaperPdf,
  loadPaperPdf,
  migrateLegacyPaperPdfs,
  clearRemovedFeatureData,
  loadProfile,
  saveProfile,
  type TeacherProfile,
  type SyncResult,
  type StoredPaper,
} from "./storage";
import { joinPdfPages, cleanBrokenKerningWords } from "./text-cleaner";
import { findTopics } from "./topic-finder";
import { ModelAnswerEditor } from "./model-answer-editor";
import { useUndoHistory, useUndoShortcuts } from "./use-undo-history";
import { ProfileDialog } from "./dialogs";
import { useDialogs } from "./use-dialogs";
import { SyncView } from "./sync-view";
import { useAutoSync } from "./use-auto-sync";
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

// The blueprint quality suite is a developer tool, shown only with ?debug=1.
const isDebugMode = new URLSearchParams(window.location.search).get("debug") === "1";

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
  const [patternSections, setPatternSections] = useState<Array<{ count: number; marks: number; label?: string; caseBased?: boolean; mcq?: boolean }>>([
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

  // Undo/redo for the pattern (step 2) and the drafted questions (step 4).
  const patternHistory = useUndoHistory({ sections: patternSections, duration }, (snapshot) => {
    setPatternSections(snapshot.sections);
    setDuration(snapshot.duration);
  });
  const draftHistory = useUndoHistory({ sections: draftedSections, difficulty }, (snapshot) => {
    setDraftedSections(snapshot.sections);
    setDifficulty(snapshot.difficulty);
    setDraftEdited(true);
  });
  // A short "Section C removed" note next to the Undo button, so a deletion is easy to take back.
  // It belongs to the screen it was shown on, so it is hidden once the teacher moves to another step.
  const [undoNoticeState, setUndoNoticeState] = useState({ step: -1, text: "" });
  const undoNotice = undoNoticeState.step === activeStep ? undoNoticeState.text : "";
  const setUndoNotice = (text: string) => setUndoNoticeState({ step: activeStep, text });
  const undoPattern = () => { patternHistory.undo(); setUndoNotice(""); };
  const redoPattern = () => { patternHistory.redo(); setUndoNotice(""); };
  const undoDraft = () => { draftHistory.undo(); setUndoNotice(""); };
  const redoDraft = () => { draftHistory.redo(); setUndoNotice(""); };
  useUndoShortcuts(activeStep === 1, undoPattern, redoPattern);
  useUndoShortcuts(activeStep === 3, undoDraft, redoDraft);

  // Storage and Help
  const [recentPapers, setRecentPapers] = useState<StoredPaper[]>(() => loadRecentPapers());
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

  // Sync with the linked file in the teacher's cloud folder; refresh here when it brings changes.
  const showSyncedData = useCallback((result: SyncResult) => {
    setRecentPapers(loadRecentPapers());
    setProfile(result.profile);
  }, []);
  const sync = useAutoSync(showSyncedData);

  const [isProfileOpen, setIsProfileOpen] = useState(false);
  const saveProfileEdits = (updated: TeacherProfile) => {
    saveProfile(updated);
    setProfile(loadProfile());
    setIsProfileOpen(false);
    sync.notifyChanged();
  };
  const dialogs = useDialogs();

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
    clearRemovedFeatureData();
    void migrateLegacyPaperPdfs().then(setRecentPapers);
    void requestPersistentStorage();
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

  const draftSourceKey = (level: string, pattern = patternSections) =>
    JSON.stringify([textbookText.length, textbookText.slice(0, 500), selectedTopics, pattern, level]);

  const redraft = (level = difficulty) => {
    draftHistory.record();
    const sections = draftQuestionSections({
      textbookText,
      selectedTopics,
      difficulty: level,
      patternSections,
    });
    setDraftedSections(sections);
    setDraftSource(draftSourceKey(level));
    setDraftEdited(false);
  };

  const confirmDiscardEdits = async (message: string, confirmLabel = "Redraft") =>
    !draftEdited || (await dialogs.confirm(message, confirmLabel));

  // Loads a saved paper back into the review step, with its pattern, so it can be changed and generated again.
  const openPaperForEditing = async (paper: StoredPaper) => {
    if (
      !(await confirmDiscardEdits(
        `Open "${paper.title}" for editing? The questions you are working on now are replaced; Undo brings them back.`,
        "Open paper",
      ))
    ) return;
    const pattern = paper.sections.map((section) => {
      const filled = section.questions.length > 0;
      return {
        label: section.label,
        count: section.questions.length,
        marks: section.questions[0]?.marks || 1,
        mcq: filled && section.questions.every((q) => Boolean(q.options?.length)),
        caseBased: filled && section.questions.every((q) => q.kind === "case"),
      };
    });
    patternHistory.record();
    setPatternSections(pattern);
    setDuration(paper.duration);
    draftHistory.record();
    setDifficulty(paper.difficulty);
    setDraftedSections(renumberSections(paper.sections));
    setDraftEdited(true);
    // Marks the draft as matching the current inputs, so opening the review step does not offer to redraft it.
    setDraftSource(draftSourceKey(paper.difficulty, pattern));
    setUndoNotice("");
    setGenerated(false);
    showGeneratedPdf(null);
    setOpenedSavedPaper(true);
    setActiveNav("New paper");
    setActiveStep(3);
  };

  // Entering the review step keeps the current draft (and any edits) unless its inputs changed.
  const refreshDraftOnEnter = async () => {
    if (draftSourceKey(difficulty) === draftSource) return;
    if (!(await confirmDiscardEdits("Your textbook, topics or pattern changed since these questions were drafted. Redraft them now? You can bring your edits back with Undo on the review screen."))) return;
    redraft();
  };

  // The later steps need a textbook to draft from, unless a saved paper was reopened with its questions.
  const [openedSavedPaper, setOpenedSavedPaper] = useState(false);
  const textbookBlocker = isAnalyzing
    ? "Reading your textbook…"
    : !textbookText.trim()
      ? "Add a textbook to continue."
      : selectedTopics.length === 0
        ? "Choose at least one topic to continue."
        : "";
  const canLeaveTextbook = !textbookBlocker || openedSavedPaper;

  const goToStep = (index: number) => {
    if (index > 0 && !canLeaveTextbook) return;
    if (index === 3) void refreshDraftOnEnter();
    setActiveStep(index);
  };

  const nextStep = () => {
    if (activeStep === 0 && !canLeaveTextbook) return;
    const next = Math.min(activeStep + 1, steps.length - 1);
    if (next === 3) void refreshDraftOnEnter();
    setActiveStep(next);
  };

  // Step 2 Pattern Handlers
  const updatePatternSection = (
    index: number,
    field: "count" | "marks" | "label" | "caseBased" | "mcq",
    value: any,
  ) => {
    const isToggle = field === "caseBased" || field === "mcq";
    // Typing in one field is a single undo step; ticking "Case-based" or "MCQ" is its own.
    patternHistory.record(isToggle ? undefined : `${field}-${index}`);
    setPatternSections((current) =>
      current.map((section, sectionIndex) => {
        if (sectionIndex !== index) return section;
        // A section is either MCQ or case-based, so ticking one unticks the other.
        if (field === "caseBased") return { ...section, caseBased: Boolean(value), ...(value ? { mcq: false } : {}) };
        if (field === "mcq") return { ...section, mcq: Boolean(value), ...(value ? { caseBased: false } : {}) };
        return {
          ...section,
          [field]: field === "label" ? String(value) : Math.max(field === "marks" ? 1 : 0, Number(value)),
        };
      }),
    );
  };

  const updateDuration = (value: number) => {
    patternHistory.record("duration");
    setDuration(Math.max(1, value));
  };

  const addPatternSection = () => {
    patternHistory.record();
    setUndoNotice("");
    setPatternSections((current) => [
      ...current,
      {
        count: 1,
        marks: 1,
        label: `Section ${String.fromCharCode(65 + current.length)}`,
      },
    ]);
  };

  const removePatternSection = (index: number) => {
    if (patternSections.length <= 1) return;
    patternHistory.record();
    setUndoNotice(`${patternSections[index]?.label || `Section ${String.fromCharCode(65 + index)}`} removed.`);
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
      patternHistory.record();
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
    draftHistory.record(`text-${sectionIndex}-${questionIndex}`);
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
    draftHistory.record(`option-${sectionIndex}-${questionIndex}-${optIndex}`);
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
    draftHistory.record(`alternative-${sectionIndex}-${questionIndex}`);
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
    // Edits under the same key in quick succession (typing) undo together.
    historyKey = `question-${sectionIndex}-${questionIndex}`,
  ) => {
    draftHistory.record(historyKey);
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
    }), `part-${sectionIndex}-${questionIndex}-${partIndex}-${field}`);

  // Each regenerate picks a different passage for case-based questions.
  const regenerateCount = useRef(0);
  const regenerateQuestion = (sectionIndex: number, questionIndex: number) => {
    const sentences = extractCleanSentences(textbookText);
    const topics = selectedTopics.length > 0 ? selectedTopics : ["General Concept"];
    const topic = topics[(sectionIndex + questionIndex + 1) % topics.length];
    const sentence = pickRandomItem(sentences, topic);
    const current = draftedSections[sectionIndex]?.questions[questionIndex];
    const marks = current?.marks || 1;
    // On a "Mixed" paper each regenerate picks a level for the new question.
    const level = levelForQuestion(difficulty, regenerateCount.current + questionIndex);

    const freshCase = current?.kind === "case"
      ? generateCaseQuestion(pickRandomItem(topics, topic), textbookText, marks, level, (regenerateCount.current += 1) * 7 + questionIndex)
      : null;
    const fresh = freshCase || generateSingleQuestion(
      topic,
      sentence,
      marks,
      level,
      // Each regenerate moves on, so the question gets a different wording and source sentence.
      questionIndex + 1 + (regenerateCount.current += 1),
      sentences,
      new Set(),
      textbookText,
      // A regenerated question keeps its type: MCQ stays MCQ, written stays written.
      Boolean(current?.options?.length),
    );

    draftHistory.record();
    setUndoNotice("");
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
    draftHistory.record();
    setUndoNotice(`Question ${questionIndex + 1} removed from ${draftedSections[sectionIndex]?.label || "this section"}.`);
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
    draftHistory.record();
    setUndoNotice("");
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

      // Save to Recent Papers
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
      const paperSaved = saveRecentPaper(paperRecord);
      const storageProblems = [
        !paperSaved && "Recent papers",
        !pdfSaved && "the saved PDF copy",
      ].filter(Boolean);
      if (storageProblems.length) {
        setWarnings((current) => [
          ...current,
          `Your paper was generated, but the browser's storage is full, so ${storageProblems.join(", ")} could not be updated. Download the PDF now, and delete old papers to free space.`,
        ]);
      }
      setRecentPapers(loadRecentPapers());
      if (paperSaved) sync.notifyChanged();
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
            className={`nav-item ${activeNav === "Recent papers" ? "active" : ""}`}
            onClick={() => setActiveNav("Recent papers")}
          >
            <span className="nav-icon">◷</span>Recent papers{" "}
            {recentPapers.length > 0 && <span className="count">{recentPapers.length}</span>}
          </button>
          <button
            className={`nav-item ${activeNav === "Sync" ? "active" : ""}`}
            onClick={() => setActiveNav("Sync")}
          >
            <span className="nav-icon">⇅</span>Sync
            {sync.handle && <span className={`sync-dot ${sync.state}`} title={sync.message} aria-hidden="true" />}
          </button>
          {sync.state === "needs-access" && (
            <button className="sync-nudge" onClick={sync.syncNow}>
              Click to sync with {sync.handle?.name}
            </button>
          )}
        </nav>
        <div className="sidebar-bottom">
          <button className="profile" onClick={() => setIsProfileOpen(true)} title="Edit your name and department">
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
                : activeNav === "Sync"
                  ? "Sync"
                  : "Recent Papers"}
            </strong>
          </div>
          <button className="help" onClick={() => setIsHelpOpen(true)}>
            ? <span>Help</span>
          </button>
        </header>

        <div className="content-wrap">
          {/* SYNC VIEW */}
          {activeNav === "Sync" && (
            <SyncView sync={sync} onLoaded={showSyncedData} />
          )}

          {/* RECENT PAPERS VIEW */}
          {activeNav === "Recent papers" && (
            <div className="recent-container">
              <section className="page-intro">
                <div>
                  <p className="eyebrow">RECENT PAPERS <span className="line" /></p>
                  <h1>Archived question <em>papers.</em></h1>
                  <p className="intro-copy">Re-download a paper, or open it to change questions and generate it again.</p>
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
                              else void dialogs.inform("The saved PDF for this paper is no longer available in this browser.");
                            }}
                          >
                            Download PDF
                          </button>
                        )}
                        <button className="back-button" onClick={() => void openPaperForEditing(paper)}>
                          Open and edit
                        </button>
                        <button
                          className="q-delete-btn"
                          onClick={() => {
                            setRecentPapers(deleteRecentPaper(paper.id));
                            sync.notifyChanged();
                          }}
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
                    disabled={index > 0 && !canLeaveTextbook}
                    title={index > 0 && !canLeaveTextbook ? textbookBlocker : undefined}
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
                                          fontSize: "14px",
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
                      <button className="next-button" onClick={nextStep} disabled={!canLeaveTextbook}>
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
                        <div className="undo-bar">
                          {undoNotice && <span className="undo-notice">{undoNotice}</span>}
                          <button type="button" className="q-action-btn" onClick={undoPattern} disabled={!patternHistory.canUndo} title="Undo (Ctrl+Z)">
                            ↶ Undo
                          </button>
                          <button type="button" className="q-action-btn" onClick={redoPattern} disabled={!patternHistory.canRedo} title="Redo (Ctrl+Y)">
                            ↷ Redo
                          </button>
                        </div>
                        <div className="pattern-labels pattern-grid">
                          <span>Section</span>
                          <span>Questions</span>
                          <span />
                          <span>Marks</span>
                        </div>
                        {patternSections.map((section, index) => (
                          <div className="pattern-row-custom pattern-grid" key={index}>
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
                            <label className="case-toggle" title="Four-option multiple-choice questions with one correct answer">
                              <input
                                type="checkbox"
                                checked={isMcqSection(section)}
                                onChange={(event) => updatePatternSection(index, "mcq", event.target.checked)}
                              />
                              MCQ
                            </label>
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
                            onChange={(event) => updateDuration(Number(event.target.value))}
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
                      {["Easy", "Moderate", "Advanced", "Application", "Mixed"].map(
                        (level) => (
                          <button
                            key={level}
                            className={`difficulty ${level.toLowerCase()} ${difficulty === level ? "active-diff" : ""}`}
                            onClick={async () => {
                              if (level === difficulty) return;
                              if (!(await confirmDiscardEdits(`Switching to ${level} redrafts all questions. You can bring your edits back with Undo.`, `Switch to ${level}`))) return;
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
                        <div className="undo-bar">
                          {undoNotice && <span className="undo-notice">{undoNotice}</span>}
                          <button type="button" className="q-action-btn" onClick={undoDraft} disabled={!draftHistory.canUndo} title="Undo (Ctrl+Z)">
                            ↶ Undo
                          </button>
                          <button type="button" className="q-action-btn" onClick={redoDraft} disabled={!draftHistory.canRedo} title="Redo (Ctrl+Y)">
                            ↷ Redo
                          </button>
                          <button
                            className="q-action-btn"
                            onClick={async () => {
                              if (!(await confirmDiscardEdits("Redraft all questions? You can bring your edits back with Undo."))) return;
                              redraft();
                            }}
                          >
                            ↻ Redraft all
                          </button>
                        </div>
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
                                      {/^fill in the blank/i.test(part.text) ? (
                                        <label className="answer-wrap">
                                          <strong>Answer:</strong>
                                          <input
                                            type="text"
                                            value={part.answer || ""}
                                            onChange={(e) => updateQuestionPart(sIdx, qIdx, pIdx, "answer", e.target.value)}
                                          />
                                        </label>
                                      ) : (
                                        <ModelAnswerEditor
                                          label="Model answer"
                                          answer={part.answer}
                                          keywords={part.keywords}
                                          onAnswer={(value) => updateQuestionPart(sIdx, qIdx, pIdx, "answer", value)}
                                          onKeywords={(value) => patchQuestion(sIdx, qIdx, (question) => ({
                                            ...question,
                                            parts: question.parts?.map((p, i) => (i === pIdx ? { ...p, keywords: value } : p)),
                                          }))}
                                        />
                                      )}
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
                                    <ModelAnswerEditor
                                      label="Model answer (from the textbook)"
                                      answer={q.answer}
                                      keywords={q.answerKeywords}
                                      onAnswer={(value) => updateQuestionAnswer(sIdx, qIdx, value)}
                                      onKeywords={(value) => patchQuestion(sIdx, qIdx, (question) => ({ ...question, answerKeywords: value }))}
                                    />
                                  )}
                                  {!q.options?.length && !q.parts?.length && q.alternative && (
                                    <ModelAnswerEditor
                                      label="OR choice: model answer"
                                      answer={q.alternativeAnswer}
                                      keywords={q.alternativeKeywords}
                                      onAnswer={(value) => patchQuestion(sIdx, qIdx, (question) => ({ ...question, alternativeAnswer: value }))}
                                      onKeywords={(value) => patchQuestion(sIdx, qIdx, (question) => ({ ...question, alternativeKeywords: value }))}
                                    />
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

                    {warnings.length > 0 && (
                      <ul className="generation-warnings">
                        {warnings.map((warning) => (
                          <li key={warning}>{warning}</li>
                        ))}
                      </ul>
                    )}

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
              <h2>Help</h2>
              <button className="modal-close" onClick={() => setIsHelpOpen(false)}>
                ×
              </button>
            </div>
            <div>
              <p className="help-lead">
                <strong>QP Setter</strong> builds question papers matching your institution's voice and typography.
              </p>
              <ul className="help-list">
                <li>Step 1: Upload your course material (PDF or DOCX) to extract topics.</li>
                <li>Step 2: Set your question pattern (sections, counts, and marks).</li>
                <li>Step 3: Upload a previous blueprint PDF or use our Standard Institutional Header.</li>
                <li>Step 4: Review and edit the questions, then generate the paper and its answer key.</li>
                <li>Sync between computers: keep one sync file in your OneDrive, Google Drive or Dropbox folder.</li>
              </ul>
            </div>

            {isDebugMode && (
            <div style={{ marginTop: "16px", borderTop: "1px solid #e2e8e0", paddingTop: "14px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <strong>Blueprint Quality Test Suite</strong>
                <button
                  className="next-button"
                  style={{ padding: "8px 12px", fontSize: "12px" }}
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
            )}
          </div>
        </div>
      )}

      {isProfileOpen && (
        <ProfileDialog profile={profile} onSave={saveProfileEdits} onClose={() => setIsProfileOpen(false)} />
      )}
      {dialogs.dialog}
    </div>
  );
}

export default App;
