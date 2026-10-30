import { useState } from "react";

/**
 * The "Improve with AI" box on the review step. The AI is optional and off until the teacher adds their own key.
 */
export function AiImprovePanel({
  apiKey,
  onApiKeyChange,
  onImprove,
  status,
  hasTextbook,
}: {
  apiKey: string;
  onApiKeyChange: (key: string) => void;
  onImprove: () => void;
  status: { busy: boolean; message: string; isError: boolean };
  hasTextbook: boolean;
}) {
  const [isEditingKey, setIsEditingKey] = useState(!apiKey);
  const [draftKey, setDraftKey] = useState(apiKey);

  return (
    <div className="ai-panel">
      <div className="ai-panel-head">
        <div>
          <strong>✦ Improve questions with AI</strong>
          <p>
            Claude rewrites the drafted questions and answers from your textbook so they read naturally and test
            understanding. Your textbook text and the draft are sent to Anthropic; nothing else leaves this browser.
          </p>
        </div>
        {apiKey && !isEditingKey && (
          <button
            className="next-button"
            onClick={onImprove}
            disabled={status.busy || !hasTextbook}
            title={hasTextbook ? undefined : "Add a textbook in step 1 first"}
          >
            {status.busy ? "Improving…" : "Improve all questions"}
          </button>
        )}
      </div>

      {isEditingKey ? (
        <form
          className="ai-key-form"
          onSubmit={(e) => {
            e.preventDefault();
            onApiKeyChange(draftKey.trim());
            setIsEditingKey(!draftKey.trim());
          }}
        >
          <label>
            Your Anthropic API key
            <input
              type="password"
              autoComplete="off"
              placeholder="sk-ant-…"
              value={draftKey}
              onChange={(e) => setDraftKey(e.target.value)}
            />
          </label>
          <button type="submit" className="q-action-btn" disabled={!draftKey.trim()}>
            Save key
          </button>
          {apiKey && (
            <button type="button" className="q-action-btn" onClick={() => setIsEditingKey(false)}>
              Cancel
            </button>
          )}
          <small>
            Get a key at console.anthropic.com. It is stored only in this browser and used only to call Anthropic;
            usage is billed to your Anthropic account.
          </small>
        </form>
      ) : (
        <div className="ai-key-row">
          <small>API key saved in this browser.</small>
          <button
            className="q-action-btn"
            onClick={() => {
              setDraftKey(apiKey);
              setIsEditingKey(true);
            }}
          >
            Change key
          </button>
          <button
            className="q-action-btn"
            onClick={() => {
              onApiKeyChange("");
              setDraftKey("");
              setIsEditingKey(true);
            }}
          >
            Remove key
          </button>
        </div>
      )}

      {status.message && (
        <p className={`ai-status ${status.isError ? "error" : ""}`} role="status">
          {status.message}
        </p>
      )}
    </div>
  );
}
