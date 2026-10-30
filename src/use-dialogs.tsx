import { useState } from "react";
import { MessageDialog } from "./dialogs";

type DialogRequest = {
  message: string;
  confirmLabel: string;
  /** Message-only dialogs have just an OK button. */
  cancellable: boolean;
  resolve: (ok: boolean) => void;
};

/**
 * In-page replacements for window.confirm and window.alert.
 * `confirm` resolves true when the teacher agrees; `inform` resolves once they close it.
 */
export function useDialogs() {
  const [request, setRequest] = useState<DialogRequest | null>(null);

  const confirm = (message: string, confirmLabel = "Continue") =>
    new Promise<boolean>((resolve) => setRequest({ message, confirmLabel, cancellable: true, resolve }));

  const inform = (message: string) =>
    new Promise<void>((resolve) =>
      setRequest({ message, confirmLabel: "OK", cancellable: false, resolve: () => resolve() }),
    );

  const close = (ok: boolean) => {
    request?.resolve(ok);
    setRequest(null);
  };

  const dialog = request ? (
    <MessageDialog
      message={request.message}
      confirmLabel={request.confirmLabel}
      cancellable={request.cancellable}
      onClose={close}
    />
  ) : null;

  return { confirm, inform, dialog };
}
