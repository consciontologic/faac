import type { Redactor } from "./storage.js";

/**
 * Incremental output redaction with bounded look-behind. Never redact independent
 * provider chunks: a credential can be split at any byte/word boundary. Keep the
 * longest registered secret plus an unfinished token, and avoid cutting through
 * a recognized credential span. Very long unbroken lines are explicitly withheld
 * to keep buffering bounded; ordinary Markdown is preserved exactly.
 */
export function createRedactedStream(redactor: Redactor): {
  push(text: string): string;
  finish(): string;
} {
  let pending = "";
  let droppingLine = false;
  return {
    push(text: string): string {
      if (droppingLine) {
        const newline = text.indexOf("\n");
        if (newline === -1) return "";
        text = text.slice(newline + 1);
        droppingLine = false;
      }
      pending += text;
      const hold = Math.max(32, redactor.maxSecretLength + 1);
      const target = pending.length - hold;
      if (target <= 0) return "";
      let boundary = -1;
      for (let i = target; i >= 0; i--) {
        if (/\s/.test(pending[i]!)) {
          boundary = i + 1;
          break;
        }
      }
      const cut =
        boundary > 0 ? redactor.streamingBoundary(pending, boundary) : 0;
      if (cut > 0) {
        const result = redactor.text(pending.slice(0, cut));
        pending = pending.slice(cut);
        return result;
      }
      const limit = Math.max(65536, redactor.maxSecretLength * 2 + 256);
      if (pending.length > limit) {
        const newline = pending.indexOf("\n");
        pending = newline === -1 ? "" : pending.slice(newline + 1);
        droppingLine = newline === -1;
        return "[Oversized unbroken output withheld for credential safety]\n";
      }
      return "";
    },
    finish(): string {
      const result = redactor.text(pending);
      pending = "";
      droppingLine = false;
      return result;
    },
  };
}
