type ModelAnswerEditorProps = {
  label: string;
  answer?: string;
  keywords?: string[];
  onAnswer: (value: string) => void;
  onKeywords: (value: string[]) => void;
};

// Same rule as the answer key PDF: a word matches a keyword or a close form of it ("cell"/"cells").
const isKeyword = (word: string, keywords: string[]) => {
  const plain = word.toLowerCase().replace(/[^a-z0-9-]/g, "");
  return plain.length > 1 && keywords.some((keyword) => {
    const key = keyword.trim().toLowerCase();
    return !!key && (plain === key || (plain.startsWith(key) && plain.length - key.length <= 2) || (key.startsWith(plain) && key.length - plain.length <= 1));
  });
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
          {answer.split(/(\s+)/).map((part, index) =>
            isKeyword(part, activeKeywords) ? <mark key={index}>{part}</mark> : part,
          )}
        </p>
      )}
    </div>
  );
}
