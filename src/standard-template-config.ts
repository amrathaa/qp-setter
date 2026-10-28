// Kept apart from standard-template.ts so the app can use the defaults without loading pdf-lib.
export interface StandardTemplateConfig {
  schoolName: string;
  examTitle: string;
  className: string;
  subjectName: string;
  durationMinutes: number;
  maxMarks: number;
  generalInstructions: string[];
  sectionLabels: string[];
}

export const DEFAULT_TEMPLATE_CONFIG: StandardTemplateConfig = {
  schoolName: "DELHI PUBLIC SCHOOL",
  examTitle: "Annual Examination 2026-27",
  className: "Class X",
  subjectName: "Science",
  durationMinutes: 90,
  maxMarks: 80,
  generalInstructions: [
    "This question paper consists of compulsory sections as specified.",
    "Section A contains 1-mark questions, Section B contains 2-mark questions, Section C contains 3-mark questions, and Section D contains 5-mark questions.",
    "All questions are compulsory. Internal choice has been provided in some questions.",
    "Use of calculators is strictly prohibited unless specifically permitted.",
  ],
  sectionLabels: ["Section A", "Section B", "Section C", "Section D"],
};
