import { stripVTControlCharacters } from "node:util";
import { Chalk, type ChalkInstance } from "chalk";
import { highlight } from "cli-highlight";
import stringWidth from "string-width";
import wrapAnsi from "wrap-ansi";
import { COMMANDS, completions } from "./commands.js";
import type { AgentEvent } from "./types.js";

/** Never allow model, workspace, or shell text to operate the terminal. */
export function safeText(value: string): string {
  return stripVTControlCharacters(value)
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "")
    .replace(/[\u202a-\u202e\u2066-\u2069]/g, "");
}

export function truncate(value: string, width: number): string {
  const text = safeText(value).replace(/\n/g, " ");
  if (stringWidth(text) <= width) return text;
  let result = "";
  for (const char of text) {
    if (stringWidth(result + char) > Math.max(0, width - 3)) break;
    result += char;
  }
  return width >= 3 ? `${result}...` : result;
}

/** Pure editor state, kept separate from terminal control for deterministic tests. */
export class InputEditor {
  text = "";
  cursor = 0;
  private historyIndex: number;
  private draft = "";
  constructor(readonly history: string[] = []) {
    this.historyIndex = history.length;
  }
  get chars(): string[] {
    return Array.from(this.text);
  }
  insert(value: string): void {
    const chars = this.chars;
    const incoming = Array.from(safeText(value.replace(/\r\n?/g, "\n")));
    chars.splice(this.cursor, 0, ...incoming);
    this.text = chars.join("");
    this.cursor += incoming.length;
  }
  backspace(): void {
    if (this.cursor === 0) return;
    const chars = this.chars;
    chars.splice(--this.cursor, 1);
    this.text = chars.join("");
  }
  delete(): void {
    const chars = this.chars;
    chars.splice(this.cursor, 1);
    this.text = chars.join("");
  }
  left(): void {
    this.cursor = Math.max(0, this.cursor - 1);
  }
  right(): void {
    this.cursor = Math.min(this.chars.length, this.cursor + 1);
  }
  home(): void {
    const chars = this.chars;
    while (this.cursor > 0 && chars[this.cursor - 1] !== "\n") this.cursor--;
  }
  end(): void {
    const chars = this.chars;
    while (this.cursor < chars.length && chars[this.cursor] !== "\n")
      this.cursor++;
  }
  clearLine(): void {
    const end = this.cursor;
    this.home();
    const chars = this.chars;
    chars.splice(this.cursor, end - this.cursor);
    this.text = chars.join("");
  }
  deleteWord(): void {
    const chars = this.chars;
    const end = this.cursor;
    while (this.cursor && /\s/.test(chars[this.cursor - 1]!)) this.cursor--;
    while (this.cursor && !/\s/.test(chars[this.cursor - 1]!)) this.cursor--;
    chars.splice(this.cursor, end - this.cursor);
    this.text = chars.join("");
  }
  historyMove(direction: -1 | 1): void {
    if (!this.history.length) return;
    if (this.historyIndex === this.history.length) this.draft = this.text;
    this.historyIndex = Math.max(
      0,
      Math.min(this.history.length, this.historyIndex + direction),
    );
    this.text = this.history[this.historyIndex] ?? this.draft;
    this.cursor = this.chars.length;
  }
  vertical(direction: -1 | 1): void {
    const chars = this.chars;
    let start = this.cursor;
    while (start > 0 && chars[start - 1] !== "\n") start--;
    const column = this.cursor - start;
    if (direction === -1) {
      if (start === 0) return this.historyMove(-1);
      let previous = start - 1;
      while (previous > 0 && chars[previous - 1] !== "\n") previous--;
      this.cursor = previous + Math.min(column, start - 1 - previous);
    } else {
      let end = this.cursor;
      while (end < chars.length && chars[end] !== "\n") end++;
      if (end === chars.length) return this.historyMove(1);
      let nextEnd = end + 1;
      while (nextEnd < chars.length && chars[nextEnd] !== "\n") nextEnd++;
      this.cursor = end + 1 + Math.min(column, nextEnd - end - 1);
    }
  }
}

interface TerminalOptions {
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
  color?: boolean;
  interactive?: boolean;
}
interface InputRequest {
  editor: InputEditor;
  prompt: string;
  secret: boolean;
  resolve(value: string | null): void;
  abort?: () => void;
  signal?: AbortSignal;
}
export interface HeaderInfo {
  workspace: string;
  session: string;
  model: string;
  state: string;
  fallback?: string;
}

export class Terminal {
  readonly interactive: boolean;
  readonly color: boolean;
  readonly ascii: boolean;
  onCancel?: () => void;
  private readonly stdin: NodeJS.ReadStream;
  private readonly stdout: NodeJS.WriteStream;
  private readonly ink: ChalkInstance;
  private request?: InputRequest;
  private closed = false;
  private originalRaw = false;
  private editorCursorRow = 0;
  private editorVisible = false;
  private escapePending = "";
  private paste = false;
  private pasted = "";
  private completionIndex = -1;
  private completionBase = "";
  private streamLine = "";
  private streamRows = 0;
  private codeLanguage: string | null = null;
  private plainBuffer = "";
  private plainEnded = false;
  private escapeTimer?: NodeJS.Timeout;
  private readonly receive = (chunk: Buffer | string): void =>
    this.handleData(String(chunk));
  private readonly ended = (): void => {
    this.plainEnded = true;
    this.consumePlainLine();
  };
  private readonly resized = (): void => {
    if (this.request && this.interactive) {
      // A terminal emulator reflows existing lines on resize. Start a fresh editor
      // below it rather than guessing how many physical rows the old editor occupies.
      this.stdout.write("\r\n");
      this.editorVisible = false;
      this.editorCursorRow = 0;
      this.drawInput();
    }
  };

  constructor(options: TerminalOptions = {}) {
    this.stdin = options.input ?? process.stdin;
    this.stdout = options.output ?? process.stdout;
    this.interactive = Boolean(
      options.interactive !== false &&
      this.stdin.isTTY &&
      this.stdout.isTTY &&
      process.env.TERM !== "dumb",
    );
    this.ascii = process.env.FAAC_ASCII === "1" || process.env.TERM === "dumb";
    this.color = Boolean(
      this.stdout.isTTY &&
      !("NO_COLOR" in process.env) &&
      process.env.TERM !== "dumb" &&
      options.color !== false,
    );
    this.ink = new Chalk({ level: this.color ? 1 : 0 });
    if (this.interactive) {
      this.originalRaw = this.stdin.isRaw;
      this.stdin.setRawMode(true);
      this.stdout.write("\x1b[?2004h");
      this.stdout.on("resize", this.resized);
    }
    this.stdin.setEncoding("utf8");
    this.stdin.on("data", this.receive);
    this.stdin.on("end", this.ended);
    this.stdin.resume();
  }

  private get width(): number {
    return Math.max(10, this.stdout.columns || 80);
  }
  private get height(): number {
    return Math.max(8, this.stdout.rows || 24);
  }
  private get glyph(): string {
    return this.ascii ? ">" : "›";
  }

  header(info: HeaderInfo): void {
    this.flushStream();
    const divider = this.ascii ? "-" : "─";
    this.styled(
      this.ink.cyan.bold("faac") +
        this.ink.gray(`  hosted free models  [${safeText(info.state)}]`),
    );
    this.print(`Workspace  ${info.workspace}`);
    this.print(
      `Session    ${info.session}  ${this.ascii ? "|" : "·"}  ${info.model || "no model selected"}`,
    );
    if (info.fallback) this.print(`Fallback   ${info.fallback}`);
    this.styled(this.ink.gray(divider.repeat(Math.min(72, this.width - 1))));
  }

  /** Plain text never receives color, formatting, or control sequences from untrusted input. */
  print(text: string): void {
    this.flushStream();
    this.clearInput();
    this.stdout.write(this.wrap(safeText(text)) + "\n");
    if (this.request && this.interactive) this.drawInput();
  }

  private styled(text: string): void {
    this.clearInput();
    this.stdout.write(this.wrap(text) + "\n");
    if (this.request && this.interactive) this.drawInput();
  }

  private wrap(text: string): string {
    return this.interactive
      ? wrapAnsi(text.replace(/\t/g, "  "), this.width - 1, {
          hard: true,
          trim: false,
        })
      : text;
  }

  event(event: AgentEvent): void {
    if (event.type === "text") {
      this.stream(event.text);
      return;
    }
    this.flushStream();
    if (event.type === "model" || event.type === "fallback")
      this.codeLanguage = null;
    const text = safeText(event.text);
    if (event.type === "diff") {
      for (const line of text.split("\n")) {
        this.styled(
          line.startsWith("+")
            ? this.ink.green(line)
            : line.startsWith("-")
              ? this.ink.red(line)
              : line.startsWith("@@")
                ? this.ink.cyan(line)
                : this.ink.gray(line),
        );
      }
      return;
    }
    const labels = {
      status: "state",
      model: "model",
      fallback: "fallback",
      warning: "warning",
      compaction: "context",
      tool: "tool",
    };
    const label = labels[event.type];
    const paint =
      event.type === "fallback" ||
      event.type === "warning" ||
      event.type === "compaction"
        ? this.ink.yellow
        : this.ink.cyan;
    this.styled(`${paint(`[${label}]`)} ${text}`);
  }

  private markdown(line: string, complete: boolean): string {
    const text = safeText(line);
    const fence = text.match(/^\s*```\s*([\w+-]*)/);
    if (fence) {
      if (complete)
        this.codeLanguage =
          this.codeLanguage === null ? fence[1] || "plaintext" : null;
      return this.ink.gray(text);
    }
    if (this.codeLanguage !== null) {
      if (!this.color) return text;
      try {
        return highlight(text, {
          language: this.codeLanguage,
          ignoreIllegals: true,
        });
      } catch {
        return this.ink.cyan(text);
      }
    }
    if (/^#{1,6}\s/.test(text))
      return this.ink.cyan.bold(text.replace(/^#{1,6}\s/, ""));
    if (/^>\s/.test(text)) return this.ink.gray(text);
    return text
      .replace(/`([^`]+)`/g, (_, code: string) => this.ink.cyan(code))
      .replace(/\*\*([^*]+)\*\*/g, (_, bold: string) => this.ink.bold(bold));
  }

  private clearStreamPreview(): void {
    if (!this.streamRows) return;
    this.stdout.write(
      "\r" +
        (this.streamRows > 1 ? `\x1b[${this.streamRows - 1}A` : "") +
        "\x1b[0J",
    );
    this.streamRows = 0;
  }

  private stream(chunk: string): void {
    if (!this.interactive) {
      this.stdout.write(safeText(chunk));
      this.streamLine =
        (this.streamLine + safeText(chunk)).split("\n").at(-1) ?? "";
      return;
    }
    this.clearInput();
    this.clearStreamPreview();
    this.streamLine += safeText(chunk);
    const lines = this.streamLine.split("\n");
    this.streamLine = lines.pop() ?? "";
    for (const line of lines)
      this.stdout.write(this.wrap(this.markdown(line, true)) + "\n");
    if (this.streamLine) {
      const rendered = this.wrap(this.markdown(this.streamLine, false));
      this.stdout.write(rendered);
      this.streamRows = rendered.split("\n").length;
    }
    if (this.request) {
      this.flushStream();
      this.drawInput();
    }
  }

  private flushStream(): void {
    if (this.streamLine) this.stdout.write("\n");
    this.streamLine = "";
    this.streamRows = 0;
  }

  async input(
    history: string[] = [],
    signal?: AbortSignal,
  ): Promise<string | null> {
    return this.read(history, "", false, signal);
  }

  async secret(prompt: string): Promise<string | null> {
    if (!this.interactive) return null;
    this.print(prompt);
    return this.read([], "Hidden input", true);
  }

  async confirm(description: string): Promise<boolean> {
    if (!this.interactive) return false;
    this.print(description);
    const answer = await this.read([], "Allow? [y/N]", false);
    return answer !== null && /^(y|yes)$/i.test(answer.trim());
  }

  private read(
    history: string[],
    prompt: string,
    secret: boolean,
    signal?: AbortSignal,
  ): Promise<string | null> {
    if (this.request)
      return Promise.reject(new Error("An input prompt is already active."));
    if (this.closed || signal?.aborted) return Promise.resolve(null);
    this.flushStream();
    return new Promise((resolve) => {
      const abort = (): void => this.finish(null);
      this.request = {
        editor: new InputEditor(history),
        prompt,
        secret,
        resolve,
        signal,
        abort,
      };
      signal?.addEventListener("abort", abort, { once: true });
      this.completionIndex = -1;
      this.completionBase = "";
      if (this.interactive) this.drawInput();
      else this.consumePlainLine();
    });
  }

  private clearInput(): void {
    if (!this.editorVisible) return;
    this.stdout.write(
      "\r" +
        (this.editorCursorRow ? `\x1b[${this.editorCursorRow}A` : "") +
        "\x1b[0J",
    );
    this.editorVisible = false;
    this.editorCursorRow = 0;
  }

  private drawInput(): void {
    const request = this.request;
    if (!request || !this.interactive) return;
    this.clearInput();
    const { editor, secret, prompt } = request;
    const contentWidth = this.width - 3;
    const chars = secret ? editor.chars.map(() => "*") : editor.chars;
    const lines = [""];
    let column = 0;
    let cursorRow = 0;
    let cursorColumn = 0;
    for (let index = 0; index <= chars.length; index++) {
      if (index === editor.cursor) {
        cursorRow = lines.length - 1;
        cursorColumn = column;
      }
      const char = chars[index];
      if (char === undefined) break;
      if (char === "\n") {
        lines.push("");
        column = 0;
      } else {
        const expanded = char === "\t" ? "  " : char;
        const width = stringWidth(expanded);
        if (column + width > contentWidth) {
          lines.push("");
          column = 0;
          if (index === editor.cursor) {
            cursorRow++;
            cursorColumn = 0;
          }
        }
        lines[lines.length - 1] += expanded;
        column += width;
      }
    }
    const visibleCount = Math.min(8, Math.max(2, this.height - 9));
    const start = Math.max(0, cursorRow - visibleCount + 1);
    const visible = lines.slice(start, start + visibleCount);
    const output = visible.map(
      (line, index) =>
        `${this.ink.cyan(index === 0 ? this.glyph : " ")} ${line}`,
    );
    const prefix = prompt
      ? [this.ink.gray(truncate(prompt, this.width - 1))]
      : [];
    const matches = secret || prompt ? [] : completions(editor.text);
    const hints: string[] = [];
    if (matches.length) {
      const max = Math.min(
        5,
        Math.max(1, this.height - output.length - prefix.length - 4),
      );
      const selected = Math.max(
        0,
        matches.findIndex((entry) => `/${entry.name}` === editor.text.trim()),
      );
      const offset = Math.max(0, selected - max + 1);
      for (const command of matches.slice(offset, offset + max)) {
        hints.push(
          this.ink.cyan(
            truncate(
              `/${command.name}  ${command.description}`,
              this.width - 1,
            ),
          ),
        );
      }
      if (matches.length > max)
        hints.push(
          this.ink.gray(
            truncate(
              `+ ${matches.length - max} commands; type to filter, /help for all`,
              this.width - 1,
            ),
          ),
        );
    } else if (!secret && !prompt && editor.text.startsWith("/")) {
      const name = editor.text.trim().split(/\s/)[0]!.slice(1);
      const command = COMMANDS.find((entry) => entry.name === name);
      hints.push(
        this.ink.gray(
          truncate(
            command?.usage ?? "Unknown command. /help lists commands.",
            this.width - 1,
          ),
        ),
      );
    }
    const controls = secret
      ? "Enter save · Ctrl-C cancel · Ctrl-D cancel"
      : this.width < 46
        ? "Enter send · / commands · ^J newline"
        : "Enter send · Ctrl-J newline · Tab complete · Ctrl-C cancel";
    hints.push(
      this.ink.gray(
        truncate(
          this.ascii ? controls.replaceAll("·", "|") : controls,
          this.width - 1,
        ),
      ),
    );
    const all = [...prefix, ...output, ...hints];
    this.stdout.write(all.join("\n"));
    const targetRow = prefix.length + cursorRow - start;
    const up = all.length - 1 - targetRow;
    this.stdout.write(
      "\r" + (up ? `\x1b[${up}A` : "") + `\x1b[${cursorColumn + 2}C`,
    );
    this.editorCursorRow = targetRow;
    this.editorVisible = true;
  }

  private finish(value: string | null): void {
    const request = this.request;
    if (!request) return;
    this.clearInput();
    this.request = undefined;
    request.signal?.removeEventListener("abort", request.abort!);
    if (this.interactive) {
      if (request.secret)
        this.stdout.write(
          `${this.glyph} ${value ? "[credential hidden]" : "[cancelled]"}\n`,
        );
      else if (value !== null)
        this.stdout.write(
          this.wrap(`${this.ink.cyan(this.glyph)} ${safeText(value)}`) + "\n\n",
        );
    }
    request.resolve(value);
  }

  private consumePlainLine(): void {
    if (!this.request) return;
    const newline = this.plainBuffer.indexOf("\n");
    if (newline >= 0) {
      const line = this.plainBuffer.slice(0, newline).replace(/\r$/, "");
      this.plainBuffer = this.plainBuffer.slice(newline + 1);
      this.finish(safeText(line));
    } else if (this.plainEnded) {
      this.finish(this.plainBuffer ? safeText(this.plainBuffer) : null);
      this.plainBuffer = "";
    }
  }

  private handleData(data: string): void {
    if (this.closed) return;
    if (!this.interactive) {
      this.plainBuffer += data;
      this.consumePlainLine();
      return;
    }
    this.escapePending += data;
    if (this.escapeTimer) clearTimeout(this.escapeTimer);
    while (this.escapePending) {
      if (this.paste) {
        const end = this.escapePending.indexOf("\x1b[201~");
        if (end === -1) {
          // Keep a possible split closing delimiter out of the pasted content.
          const hold = Math.min(5, this.escapePending.length);
          this.pasted += this.escapePending.slice(0, -hold || undefined);
          this.escapePending = this.escapePending.slice(-hold);
          return;
        }
        this.pasted += this.escapePending.slice(0, end);
        this.request?.editor.insert(this.pasted.replace(/\r\n?/g, "\n"));
        this.escapePending = this.escapePending.slice(end + 6);
        this.pasted = "";
        this.paste = false;
        this.drawInput();
        continue;
      }
      if (this.escapePending.startsWith("\x1b[200~")) {
        this.paste = true;
        this.escapePending = this.escapePending.slice(6);
        continue;
      }
      const sequences: Record<string, string> = {
        "\x1b[A": "up",
        "\x1b[B": "down",
        "\x1b[C": "right",
        "\x1b[D": "left",
        "\x1b[H": "home",
        "\x1b[F": "end",
        "\x1bOH": "home",
        "\x1bOF": "end",
        "\x1b[1~": "home",
        "\x1b[4~": "end",
        "\x1b[3~": "delete",
        "\x1b\r": "newline",
        "\x1b\n": "newline",
      };
      const matched = Object.keys(sequences).find((sequence) =>
        this.escapePending.startsWith(sequence),
      );
      if (matched) {
        this.escapePending = this.escapePending.slice(matched.length);
        this.key(sequences[matched]!);
        continue;
      }
      const possible = [...Object.keys(sequences), "\x1b[200~"].some(
        (sequence) => sequence.startsWith(this.escapePending),
      );
      if (possible) {
        this.escapeTimer = setTimeout(() => {
          this.escapePending = "";
        }, 80);
        return;
      }
      if (this.escapePending.startsWith("\x1b[")) {
        const unknown = this.escapePending.match(/^\x1b\[[0-9;?]*[ -/]*[@-~]/);
        if (unknown)
          this.escapePending = this.escapePending.slice(unknown[0].length);
        else this.escapePending = this.escapePending.slice(1);
        continue;
      }
      const char = Array.from(this.escapePending)[0]!;
      this.escapePending = this.escapePending.slice(char.length);
      const keys: Record<string, string> = {
        "\r": "submit",
        "\n": "newline",
        "\t": "tab",
        "\x7f": "backspace",
        "\x08": "backspace",
        "\x01": "home",
        "\x05": "end",
        "\x03": "cancel",
        "\x04": "eof",
        "\x0c": "redraw",
        "\x15": "clearLine",
        "\x17": "deleteWord",
        "\x10": "previous",
        "\x0e": "next",
      };
      this.key(keys[char] ?? "text", char);
    }
  }

  private key(key: string, char = ""): void {
    if (key === "cancel" && !this.request) {
      this.onCancel?.();
      return;
    }
    const request = this.request;
    if (!request) return;
    const editor = request.editor;
    if (key !== "tab") {
      this.completionIndex = -1;
      this.completionBase = "";
    }
    if (key === "submit") {
      this.finish(editor.text);
      return;
    }
    if (key === "eof" && !editor.text) {
      this.finish(null);
      return;
    }
    if (key === "cancel" && (request.secret || request.prompt)) {
      this.finish(null);
      this.onCancel?.();
      return;
    }
    if (key === "eof") editor.delete();
    else if (key === "cancel") {
      editor.text = "";
      editor.cursor = 0;
    } else if (key === "newline" && !request.secret) editor.insert("\n");
    else if (key === "up") editor.vertical(-1);
    else if (key === "down") editor.vertical(1);
    else if (key === "previous") editor.historyMove(-1);
    else if (key === "next") editor.historyMove(1);
    else if (key === "left") editor.left();
    else if (key === "right") editor.right();
    else if (key === "home") editor.home();
    else if (key === "end") editor.end();
    else if (key === "delete") editor.delete();
    else if (key === "backspace") editor.backspace();
    else if (key === "clearLine") editor.clearLine();
    else if (key === "deleteWord") editor.deleteWord();
    else if (key === "tab" && !request.secret && !request.prompt) {
      if (this.completionIndex < 0) this.completionBase = editor.text;
      const matches = completions(this.completionBase);
      if (matches.length) {
        this.completionIndex = (this.completionIndex + 1) % matches.length;
        editor.text = `/${matches[this.completionIndex]!.name}`;
        editor.cursor = editor.chars.length;
      }
    } else if (key === "text" && !/[\u0000-\u001f\u007f-\u009f]/.test(char))
      editor.insert(char);
    this.drawInput();
  }

  close(): void {
    if (this.closed) return;
    this.flushStream();
    this.finish(null);
    this.closed = true;
    if (this.escapeTimer) clearTimeout(this.escapeTimer);
    this.stdin.removeListener("data", this.receive);
    this.stdin.removeListener("end", this.ended);
    this.stdout.removeListener("resize", this.resized);
    if (this.interactive) {
      this.stdout.write("\x1b[?2004l" + (this.color ? "\x1b[0m" : ""));
      this.stdin.setRawMode(this.originalRaw);
    }
    this.stdin.pause();
  }
}
