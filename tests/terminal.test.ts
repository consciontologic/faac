import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import test from "node:test";
import stringWidth from "string-width";
import { InputEditor, Terminal, safeText, truncate } from "../src/terminal.js";

process.env.TERM = "xterm-256color";

function fakeTerminal(tty = true, width = 80, height = 24) {
  const chunks: string[] = [];
  const input = Object.assign(new PassThrough(), {
    isTTY: tty,
    isRaw: false,
    setRawMode(value: boolean) {
      this.isRaw = value;
      return this;
    },
  });
  const output = Object.assign(
    new Writable({
      write(chunk, _encoding, done) {
        chunks.push(String(chunk));
        done();
      },
    }),
    { isTTY: tty, columns: width, rows: height },
  );
  const terminal = new Terminal({
    input: input as unknown as NodeJS.ReadStream,
    output: output as unknown as NodeJS.WriteStream,
    color: false,
  });
  return { terminal, input, output, chunks, text: () => chunks.join("") };
}

// These tests use terminal streams rather than provider mocks. The full process
// PTY smoke is separate at scripts/ad-hoc/pty-smoke.py.
test("editor handles multiline insertion, Unicode, line motion, deletion, and draft history", () => {
  const editor = new InputEditor(["old request", "second"]);
  editor.insert("one\ntw😀");
  editor.left();
  editor.insert("o");
  assert.equal(editor.text, "one\ntwo😀");
  editor.backspace();
  editor.delete();
  assert.equal(editor.text, "one\ntw");
  editor.home();
  assert.equal(editor.cursor, 4);
  editor.vertical(-1);
  assert.equal(editor.cursor, 0);
  editor.vertical(1);
  assert.equal(editor.cursor, 4);
  editor.historyMove(-1);
  assert.equal(editor.text, "second");
  editor.historyMove(-1);
  assert.equal(editor.text, "old request");
  editor.historyMove(1);
  editor.historyMove(1);
  assert.equal(editor.text, "one\ntw");
  editor.end();
  editor.clearLine();
  assert.equal(editor.text, "one\n");
});

test("terminal strips escape sequences, C1 controls, and deceptive direction controls", () => {
  assert.equal(safeText("a\x1b[2Jb\x1b]0;danger\x07c\u009b\u202ed"), "abcd");
  assert.equal(safeText("line\n\ttab"), "line\n\ttab");
  assert.ok(stringWidth(truncate("long 😀 text", 8)) <= 8);
});

test("interactive input supports completions, multiline, and history without duplicate listeners", async () => {
  const { terminal, input, text } = fakeTerminal();
  try {
    const first = terminal.input([]);
    input.write("/sta\t\r");
    assert.equal(await first, "/status");
    const second = terminal.input(["previous task"]);
    input.write("hello\nworld\x1b[D\x7f!\r");
    assert.equal(await second, "hello\nwor!d");
    const third = terminal.input(["previous task"]);
    input.write("\x1b[A\r");
    assert.equal(await third, "previous task");
    assert.equal(input.listenerCount("data"), 1);
    assert.ok(text().includes("/status"));
  } finally {
    terminal.close();
  }
  assert.equal(input.listenerCount("data"), 0);
  assert.equal(input.isRaw, false);
});

test("bracketed paste stays editable and does not submit embedded newlines", async () => {
  const { terminal, input } = fakeTerminal();
  try {
    let submitted = false;
    const answer = terminal.input().then((value) => {
      submitted = true;
      return value;
    });
    input.write("\x1b[200~line one\r\nline two");
    input.write("\x1b[20");
    input.write("1~");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(submitted, false);
    input.write("\r");
    assert.equal(await answer, "line one\nline two");
  } finally {
    terminal.close();
  }
});

test("secret entry never writes credentials; permissions default to no", async () => {
  const { terminal, input, text } = fakeTerminal();
  try {
    const secret = terminal.secret("Connect provider");
    input.write("sk-secret-never-render\r");
    assert.equal(await secret, "sk-secret-never-render");
    assert.ok(!text().includes("sk-secret-never-render"));
    const rejected = terminal.confirm("Run shell command?");
    input.write("\r");
    assert.equal(await rejected, false);
    const accepted = terminal.confirm("Run shell command?");
    input.write("yes\r");
    assert.equal(await accepted, true);
  } finally {
    terminal.close();
  }
});

test("Ctrl-C cancels work, clears drafts, and abort signal ends an input", async () => {
  const { terminal, input } = fakeTerminal();
  try {
    let cancelled = 0;
    terminal.onCancel = () => {
      cancelled++;
    };
    input.write("\x03");
    assert.equal(cancelled, 1);
    const answer = terminal.input();
    input.write("discard\x03keep\r");
    assert.equal(await answer, "keep");
    assert.equal(cancelled, 1);
    const controller = new AbortController();
    const aborted = terminal.input([], controller.signal);
    controller.abort();
    assert.equal(await aborted, null);
  } finally {
    terminal.close();
  }
});

test("Ctrl-C rejects permission and secret prompts while cancelling active work", async () => {
  const { terminal, input, text } = fakeTerminal();
  try {
    let cancelled = 0;
    terminal.onCancel = () => {
      cancelled++;
    };
    const permission = terminal.confirm("Approve this shell command?");
    input.write("y\x03");
    assert.equal(await permission, false);
    assert.equal(cancelled, 1);
    const secret = terminal.secret("Unlock the credential vault");
    input.write("private-do-not-echo\x03");
    assert.equal(await secret, null);
    assert.equal(cancelled, 2);
    assert.ok(!text().includes("private-do-not-echo"));
    const draft = terminal.input();
    input.write("discard\x03kept\r");
    assert.equal(await draft, "kept");
    assert.equal(cancelled, 2);
  } finally {
    terminal.close();
  }
});

test("narrow terminal renders bounded menu rows and keeps text editable after resize", async () => {
  const { terminal, input, output, text } = fakeTerminal(true, 24, 12);
  try {
    terminal.header({
      workspace: "/tmp/a workspace with a long name",
      session: "session-123",
      model: "provider/model-long",
      state: "ready",
    });
    const answer = terminal.input();
    input.write("/con");
    output.columns = 18;
    output.emit("resize");
    input.write("\t\r");
    assert.equal(await answer, "/connect");
    for (const line of text().split("\n")) {
      // Cursor-control redraws can share one recording line; check visible
      // final strings between erase operations rather than flattened ANSI.
      for (const part of line.split("\x1b[0J")) {
        const content = stripVTControlCharacters(part).split("\r").at(-1)!;
        assert.ok(stringWidth(content) < 90);
      }
    }
  } finally {
    terminal.close();
  }
});

test("redirected output is plain, retains streaming text, and refuses secret/approval prompts", async () => {
  const { terminal, input, text } = fakeTerminal(false);
  try {
    terminal.event({ type: "text", text: "**streaming** " });
    terminal.event({
      type: "text",
      text: "answer\n```ts\nconst x = 1;\n```\n",
    });
    terminal.event({
      type: "fallback",
      text: "HTTP 429; continuing with another free model",
    });
    terminal.event({ type: "diff", text: "+ added\n- removed" });
    assert.ok(!text().includes("\x1b"));
    assert.ok(text().includes("**streaming** answer"));
    assert.equal(await terminal.secret("API key"), null);
    assert.equal(await terminal.confirm("danger"), false);
    const line = terminal.input();
    input.write("/status\n/exit\n");
    assert.equal(await line, "/status");
    assert.equal(await terminal.input(), "/exit");
  } finally {
    terminal.close();
  }
});

test("NO_COLOR and ASCII override terminal decoration", async () => {
  const previousNoColor = process.env.NO_COLOR;
  const previousAscii = process.env.FAAC_ASCII;
  process.env.NO_COLOR = "";
  process.env.FAAC_ASCII = "1";
  const { terminal, input, text } = fakeTerminal();
  try {
    assert.equal(terminal.color, false);
    assert.equal(terminal.ascii, true);
    terminal.header({
      workspace: "/tmp",
      session: "id",
      model: "none",
      state: "idle",
    });
    const answer = terminal.input();
    input.write("hi\r");
    assert.equal(await answer, "hi");
    assert.ok(!/\x1b\[[\d;]*m/.test(text()));
    assert.ok(text().includes("> hi"));
  } finally {
    terminal.close();
    if (previousNoColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = previousNoColor;
    if (previousAscii === undefined) delete process.env.FAAC_ASCII;
    else process.env.FAAC_ASCII = previousAscii;
  }
});
