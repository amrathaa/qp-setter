import { useEffect, useRef, useState } from "react";
import type { TeacherProfile } from "./storage";

export function MessageDialog({
  message,
  confirmLabel,
  cancellable,
  onClose,
}: {
  message: string;
  confirmLabel: string;
  cancellable: boolean;
  onClose: (ok: boolean) => void;
}) {
  const confirmButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    confirmButton.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="modal-overlay" onClick={() => onClose(false)}>
      <div
        className="modal-content dialog-small"
        role="alertdialog"
        aria-modal="true"
        aria-describedby="dialog-message"
        onClick={(e) => e.stopPropagation()}
      >
        <p id="dialog-message" className="dialog-message">
          {message}
        </p>
        <div className="dialog-actions">
          {cancellable && (
            <button className="back-button" onClick={() => onClose(false)}>
              Cancel
            </button>
          )}
          <button ref={confirmButton} className="next-button" onClick={() => onClose(true)}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export function ProfileDialog({
  profile,
  onSave,
  onClose,
}: {
  profile: TeacherProfile;
  onSave: (profile: TeacherProfile) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(profile.name);
  const [department, setDepartment] = useState(profile.department);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <form
        className="modal-content dialog-small"
        role="dialog"
        aria-modal="true"
        aria-labelledby="profile-title"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === "Escape" && onClose()}
        onSubmit={(e) => {
          e.preventDefault();
          onSave({ name: name.trim(), department: department.trim() });
        }}
      >
        <div className="modal-header">
          <h2 id="profile-title">Your profile</h2>
          <button type="button" className="modal-close" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>
        <label className="dialog-field">
          Your name
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Priya Sharma" />
        </label>
        <label className="dialog-field">
          Department
          <input
            value={department}
            onChange={(e) => setDepartment(e.target.value)}
            placeholder="e.g. Science department"
          />
        </label>
        <div className="dialog-actions">
          <button type="button" className="back-button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="next-button">
            Save
          </button>
        </div>
      </form>
    </div>
  );
}
