import { describe, expect, it } from "vitest";
import { draftQuestionSections, isCaseBasedSection, isMcqSection } from "./question-generator";
import { generatePatternGeneralInstructions } from "./text-cleaner";

const textbook = `1.1 Photosynthesis
Photosynthesis is the process by which green plants make their own food using sunlight. Chlorophyll is the green pigment that absorbs sunlight in the leaves. Carbon dioxide enters the leaf through tiny pores called stomata. Oxygen is released as a by-product of photosynthesis.
1.2 Respiration
Respiration is the process of breaking down glucose to release energy. Aerobic respiration takes place in the presence of oxygen and produces carbon dioxide and water. Anaerobic respiration takes place without oxygen and produces less energy. Yeast carries out anaerobic respiration to produce alcohol.`;

const photosynthesisSection = [
  "Photosynthesis is the process by which green plants make their own food using sunlight.",
  "Chlorophyll is the green pigment that absorbs sunlight in the leaves.",
  "Carbon dioxide enters the leaf through tiny pores called stomata.",
  "Oxygen is released as a by-product of photosynthesis.",
];

const draft = (patternSections: Parameters<typeof draftQuestionSections>[0]["patternSections"], topics = ["1.1 Photosynthesis", "1.2 Respiration"]) =>
  draftQuestionSections({ textbookText: textbook, selectedTopics: topics, difficulty: "Moderate", patternSections });

describe("MCQ and case-based section choice", () => {
  it("defaults 1-mark sections to MCQ and 4-mark sections to case-based", () => {
    expect(isMcqSection({ marks: 1 })).toBe(true);
    expect(isMcqSection({ marks: 2 })).toBe(false);
    expect(isCaseBasedSection({ marks: 4 })).toBe(true);
  });

  it("lets the teacher turn MCQ off, or on for any marks", () => {
    expect(isMcqSection({ marks: 1, mcq: false })).toBe(false);
    expect(isMcqSection({ marks: 5, mcq: true })).toBe(true);
  });

  it("never treats a section as both MCQ and case-based", () => {
    expect(isMcqSection({ marks: 1, caseBased: true })).toBe(false);
    expect(isMcqSection({ marks: 4, mcq: true, caseBased: true })).toBe(false);
  });
});

describe("drafting questions", () => {
  it("writes MCQs whose correct answer is one of four options", () => {
    const [section] = draft([{ count: 2, marks: 1 }]);
    for (const question of section.questions) {
      expect(question.options).toHaveLength(4);
      expect(question.options).toContain(question.answer);
      expect(question.marks).toBe(1);
    }
  });

  it("writes one-line written questions with answers when MCQ is off", () => {
    const [section] = draft([{ count: 2, marks: 1, mcq: false }]);
    for (const question of section.questions) {
      expect(question.options).toBeUndefined();
      expect(question.answer).toBeTruthy();
    }
  });

  it("keeps the section's marks on MCQs worth more than one mark", () => {
    const [section] = draft([{ count: 1, marks: 3, mcq: true }]);
    expect(section.questions[0].options).toHaveLength(4);
    expect(section.questions[0].marks).toBe(3);
  });

  it("asks which statement is about a topic when the text is too short for blanks, with no second right answer", () => {
    const [section] = draft([{ count: 1, marks: 1 }]);
    const question = section.questions[0];
    expect(question.text).toMatch(/Which of the following statements is about Photosynthesis\?/);
    expect(photosynthesisSection).toContain(question.answer);
    const wrong = question.options!.filter((option) => option !== question.answer);
    for (const option of wrong) expect(photosynthesisSection).not.toContain(option);
  });

  it("does the same for textbooks whose headings are not numbered", () => {
    const unnumbered = textbook.replace(/^1\.\d /gm, "");
    const [section] = draftQuestionSections({
      textbookText: unnumbered,
      selectedTopics: ["Photosynthesis", "Respiration"],
      difficulty: "Moderate",
      patternSections: [{ count: 1, marks: 1 }],
    });
    const question = section.questions[0];
    const wrong = question.options!.filter((option) => option !== question.answer);
    for (const option of wrong) expect(photosynthesisSection).not.toContain(option);
  });

  it("moves through every topic in turn", () => {
    const topics = ["Alpha", "Beta", "Gamma", "Delta"];
    const sections = draftQuestionSections({
      textbookText: "",
      selectedTopics: topics,
      difficulty: "Moderate",
      patternSections: [{ count: 4, marks: 2 }, { count: 4, marks: 3 }],
    });
    const asked = sections.flatMap((section) => section.questions).map((q) => topics.find((topic) => q.text.includes(topic)));
    expect(asked).toEqual([...topics, ...topics]);
  });

  it("numbers questions 1..N across sections", () => {
    const sections = draft([{ count: 2, marks: 1 }, { count: 2, marks: 2 }]);
    const numbers = sections.flatMap((section) => section.questions).map((q) => Number(q.text.match(/^(\d+)\./)?.[1]));
    expect(numbers).toEqual([1, 2, 3, 4]);
  });
});

describe("general instructions", () => {
  it("calls a section MCQ only when it really holds MCQs", () => {
    const sections = draft([
      { count: 1, marks: 1, label: "Section A" },
      { count: 1, marks: 1, label: "Section B", mcq: false },
    ]);
    const lines = generatePatternGeneralInstructions(sections).filter((line) => line.startsWith("In "));
    expect(lines[0]).toMatch(/Multiple Choice/);
    expect(lines[1]).toMatch(/Very Short Answer/);
  });
});
