import Anthropic from "@anthropic-ai/sdk";
import type { GeneratedQuestion, GeneratedSection } from "./blueprint";

const MODEL = "claude-opus-5-5";
// Roughly 4 characters per token; keeps the textbook well inside the model's 1M-token window.
const MAX_TEXTBOOK_CHARS = 2_400_000;

export class AiQuestionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiQuestionError";
  }
}

type AiQuestion = {
  text: string;
  options: string[];
  answer: string;
  answerKeywords: string[];
  alternative: string;
  alternativeAnswer: string;
  parts: Array<{ text: string; answer: string }>;
};

const stringList = { type: "array", items: { type: "string" } };

const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["sections"],
  properties: {
    sections: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["questions"],
        properties: {
          questions: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["text", "options", "answer", "answerKeywords", "alternative", "alternativeAnswer", "parts"],
              properties: {
                text: { type: "string" },
                options: stringList,
                answer: { type: "string" },
                answerKeywords: stringList,
                alternative: { type: "string" },
                alternativeAnswer: { type: "string" },
                parts: {
                  type: "array",
                  items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["text", "answer"],
                    properties: { text: { type: "string" }, answer: { type: "string" } },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
};

const SYSTEM_PROMPT = `You are an experienced school examiner. A teacher has drafted an exam paper automatically from their textbook, and the draft questions often read awkwardly or test trivia. Rewrite each question so it is clear, grammatical and tests real understanding of the textbook, at the requested difficulty.

Keep the paper's structure exactly: the same sections in the same order, the same number of questions in each, and for every question the same type and shape as the draft:
- A multiple-choice question keeps the same number of options, with exactly one correct option; "answer" must repeat the correct option's text exactly. Distractors should be plausible.
- A case-based question keeps a short passage as "text" and the same number of sub-questions in "parts", each with its own answer.
- A question with an OR alternative gets a different alternative question of equal difficulty; otherwise leave "alternative" and "alternativeAnswer" empty.
- Use empty strings and empty lists for fields that do not apply.

Every question must be answerable from the textbook. "answer" is a model answer a teacher can mark against, sized to the marks. "answerKeywords" lists the few key terms a marker looks for. Spread questions across the listed topics and do not repeat a question. Write in the same language as the textbook. Do not number the questions.`;

const strip = (text: string) => text.replace(/^\s*\d+[.)]\s*/, "").trim();

function describeDraft(sections: GeneratedSection[], difficulty: string, topics: string[]) {
  return JSON.stringify({
    difficulty,
    topics,
    sections: sections.map((section) => ({
      label: section.label,
      questions: section.questions.map((q) => ({
        marks: q.marks || 1,
        type: q.parts?.length ? "case-based" : q.options?.length ? "multiple-choice" : "written",
        optionCount: q.options?.length || 0,
        partMarks: q.parts?.map((part) => part.marks) || [],
        hasAlternative: typeof q.alternative === "string" && q.alternative.trim() !== "",
        draft: strip(q.text),
        draftOptions: q.options || [],
        draftParts: q.parts?.map((part) => part.text) || [],
      })),
    })),
  });
}

const nonEmpty = (text: string) => (text.trim() ? text.trim() : undefined);

// Uses the rewritten question only if it kept the draft's shape; otherwise the draft stays.
function mergeQuestion(original: GeneratedQuestion, ai: AiQuestion | undefined): GeneratedQuestion | null {
  if (!ai || !ai.text.trim()) return null;
  const isMcq = Boolean(original.options?.length);
  if (isMcq && (ai.options.length !== original.options!.length || !ai.options.includes(ai.answer))) return null;
  if (original.parts?.length && ai.parts.length !== original.parts.length) return null;
  const hasStringAlternative = typeof original.alternative === "string" && original.alternative.trim() !== "";
  return {
    ...original,
    text: ai.text.trim(),
    options: isMcq ? ai.options.map((option) => option.trim()) : original.options,
    answer: nonEmpty(ai.answer) ?? original.answer,
    answerKeywords: ai.answerKeywords.length ? ai.answerKeywords : original.answerKeywords,
    alternative: hasStringAlternative ? nonEmpty(ai.alternative) ?? original.alternative : original.alternative,
    alternativeAnswer: hasStringAlternative ? nonEmpty(ai.alternativeAnswer) ?? original.alternativeAnswer : original.alternativeAnswer,
    parts: original.parts?.map((part, i) => ({
      ...part,
      text: nonEmpty(ai.parts[i].text) ?? part.text,
      answer: nonEmpty(ai.parts[i].answer) ?? part.answer,
    })),
  };
}

function friendlyError(error: unknown): AiQuestionError {
  if (error instanceof AiQuestionError) return error;
  if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
    return new AiQuestionError("Your Anthropic API key was not accepted. Check it in AI settings.");
  }
  if (error instanceof Anthropic.RateLimitError) {
    return new AiQuestionError("Anthropic is limiting requests on your key right now. Wait a minute and try again.");
  }
  if (error instanceof Anthropic.BadRequestError) {
    return new AiQuestionError(`Anthropic could not process this request: ${error.message}`);
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return new AiQuestionError("Could not reach Anthropic. Check your internet connection and try again.");
  }
  if (error instanceof Anthropic.APIError) {
    return new AiQuestionError(`Anthropic returned an error (${error.status ?? "unknown"}). Please try again.`);
  }
  return new AiQuestionError("The AI could not improve the questions. Please try again.");
}

/**
 * Sends the textbook and the drafted paper to Claude and returns better-worded questions in the same structure.
 * Questions the AI changed shape on are left as drafted and counted in `kept`.
 */
export async function improveQuestionsWithAI(options: {
  apiKey: string;
  sections: GeneratedSection[];
  textbookText: string;
  topics: string[];
  difficulty: string;
}): Promise<{ sections: GeneratedSection[]; improved: number; kept: number }> {
  const { apiKey, sections, textbookText, topics, difficulty } = options;
  if (!textbookText.trim()) throw new AiQuestionError("Add a textbook first, so the AI has something to write questions from.");
  if (textbookText.length > MAX_TEXTBOOK_CHARS) {
    throw new AiQuestionError("This textbook is too long to send in one go. Remove some files in step 1 and try again.");
  }

  try {
    // The key belongs to the teacher using this page and is sent only to Anthropic.
    const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
    const response = await client.beta.messages
      .stream({
        model: MODEL,
        max_tokens: 64000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: { effort: "medium", format: { type: "json_schema", schema: OUTPUT_SCHEMA } },
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: [
              // The textbook is cached, so improving the same paper again costs much less.
              { type: "text", text: `<textbook>\n${textbookText}\n</textbook>`, cache_control: { type: "ephemeral" } },
              { type: "text", text: `Rewrite this drafted paper:\n${describeDraft(sections, difficulty, topics)}` },
            ],
          },
        ],
      })
      .finalMessage();

    if (response.stop_reason === "refusal") {
      throw new AiQuestionError("The AI declined to write questions for this textbook. Your draft was left unchanged.");
    }
    if (response.stop_reason === "max_tokens") {
      throw new AiQuestionError("The paper is too long for the AI to rewrite in one go. Try fewer questions.");
    }
    const text = response.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
    let parsed: { sections: Array<{ questions: AiQuestion[] }> };
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new AiQuestionError("The AI's reply could not be read. Please try again.");
    }

    let improved = 0;
    let kept = 0;
    const merged = sections.map((section, sIdx) => ({
      ...section,
      questions: section.questions.map((question, qIdx) => {
        const rewritten = mergeQuestion(question, parsed.sections?.[sIdx]?.questions?.[qIdx]);
        if (rewritten) improved += 1;
        else kept += 1;
        return rewritten ?? question;
      }),
    }));
    return { sections: merged, improved, kept };
  } catch (error) {
    throw friendlyError(error);
  }
}
