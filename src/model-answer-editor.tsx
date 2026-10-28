type ModelAnswerEditorProps = {
  label: string;
  answer?: string;
  keywords?: string[];
  onAnswer: (value: string) => void;
  onKeywords: (value: string[]) => void;
};

import { keywordMask } from "./keyword-highlight";

// Answer text split into alternating words and spaces, with the words the answer key will print in bold.
const highlightedParts = (answer: string, keywords: string[]) => {
  const parts = answer.split(/(\s+)/);
  const mask = keywordMask(parts.filter((_, index) => index % 2 === 0), keywords);
  return parts.map((part, index) => ({ part, marked: index % 2 === 0 && mask[index / 2] }));
};

/**
 * Editable model answer and keywords for one written question, with a preview of how the
 * keywords are highlighted in the answer key.
 */
export function ModelAnswerEditor({ label, answer, keywords = [], onAnswer, onKeywords }: ModelAnswerEditorProps) {
  const activeKeywords = keywords.filter((keyword) => keyword.trim());
  return (
    <div className="model-answer">
      <strong>{label}:</strong>
      <textarea
        value={answer || ""}
        placeholder="No matching passage was found in the textbook. Write the model answer here."
        onChange={(event) => onAnswer(event.target.value)}
      />
      <label className="answer-wrap">
        <strong>Keywords:</strong>
        <input
          type="text"
          value={keywords.join(", ")}
          placeholder="Comma-separated terms a full-marks answer should use"
          // Empty entries are kept while typing so a trailing comma can be typed.
          onChange={(event) => onKeywords(event.target.value.split(",").map((keyword) => keyword.trimStart()))}
        />
      </label>
      {answer && activeKeywords.length > 0 && (
        <p className="model-answer-preview">
          {highlightedParts(answer, activeKeywords).map(({ part, marked }, index) =>
            marked ? <mark key={index}>{part}</mark> : part,
          )}
        </p>
      )}
    </div>
  );
}
