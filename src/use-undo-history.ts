import { useEffect, useRef, useState } from "react";

const LIMIT = 50;
// Keystrokes in the same field within this window undo together, not one letter at a time.
const MERGE_MS = 1000;

/**
 * Undo/redo for one piece of state. Call `record()` just before each change; pass a key
 * (e.g. "label-2") for typing so a burst of edits in one field becomes a single undo step.
 */
export function useUndoHistory<T>(current: T, restore: (value: T) => void) {
  const past = useRef<T[]>([]);
  const future = useRef<T[]>([]);
  const lastEdit = useRef<{ key: string; time: number } | null>(null);
  const [, setVersion] = useState(0);
  const bump = () => setVersion((v) => v + 1);

  const record = (key?: string) => {
    const now = Date.now();
    if (key && lastEdit.current?.key === key && now - lastEdit.current.time < MERGE_MS) {
      lastEdit.current.time = now;
      return;
    }
    past.current.push(current);
    if (past.current.length > LIMIT) past.current.shift();
    future.current = [];
    lastEdit.current = key ? { key, time: now } : null;
    bump();
  };

  const undo = () => {
    const previous = past.current.pop();
    if (previous === undefined) return;
    future.current.push(current);
    lastEdit.current = null;
    restore(previous);
    bump();
  };

  const redo = () => {
    const next = future.current.pop();
    if (next === undefined) return;
    past.current.push(current);
    lastEdit.current = null;
    restore(next);
    bump();
  };

  return { record, undo, redo, canUndo: past.current.length > 0, canRedo: future.current.length > 0 };
}

/**
 * Ctrl+Z / Ctrl+Y (and Ctrl+Shift+Z) while `active`. Inside a text box the browser's own
 * text undo is left alone, so typing can still be undone letter by letter there.
 */
export function useUndoShortcuts(active: boolean, undo: () => void, redo: () => void) {
  const handlers = useRef({ undo, redo });
  handlers.current = { undo, redo };
  useEffect(() => {
    if (!active) return;
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      const key = event.key.toLowerCase();
      if (key === "z" && !event.shiftKey) {
        event.preventDefault();
        handlers.current.undo();
      } else if (key === "y" || (key === "z" && event.shiftKey)) {
        event.preventDefault();
        handlers.current.redo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active]);
}
