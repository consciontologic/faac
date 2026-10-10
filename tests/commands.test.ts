import assert from "node:assert/strict";
import test from "node:test";
import {
  COMMANDS,
  commandHelp,
  completions,
  parseCommand,
} from "../src/commands.js";

test("all required slash commands have useful argument help and completions", () => {
  const expected =
    "help init cd status models providers connect disconnect route params tools permissions sessions resume checkpoint diff undo sync doctor config exit".split(
      " ",
    );
  assert.deepEqual(
    COMMANDS.map((command) => command.name),
    expected,
  );
  for (const command of COMMANDS) {
    assert.ok(command.description.length > 20);
    assert.ok(command.usage.startsWith(`/${command.name}`));
    assert.ok(
      completions(`/${command.name}`).some(
        (item) => item.name === command.name,
      ),
    );
    assert.ok(commandHelp(command.name).includes(command.usage));
  }
  assert.ok(commandHelp().includes("Ctrl-J"));
  assert.ok(
    commandHelp().includes(
      "shell commands and external effects cannot be undone",
    ),
  );
});

test("command parser preserves quoted paths, empty values, and literal JSON", () => {
  assert.equal(parseCommand("create a /status command"), null);
  assert.deepEqual(parseCommand('/cd "/tmp/work with spaces"'), {
    name: "cd",
    args: ["/tmp/work with spaces"],
  });
  assert.deepEqual(parseCommand(`/params set reasoning '{"effort":"low"}'`), {
    name: "params",
    args: ["set", "reasoning", '{"effort":"low"}'],
  });
  assert.deepEqual(parseCommand('/params set stop ""'), {
    name: "params",
    args: ["set", "stop", ""],
  });
  assert.deepEqual(parseCommand("/cd /tmp/my\\ folder"), {
    name: "cd",
    args: ["/tmp/my folder"],
  });
  assert.deepEqual(parseCommand("/HELP"), { name: "help", args: [] });
  assert.deepEqual(parseCommand("/"), { name: "help", args: [] });
  assert.throws(() => parseCommand('/cd "unterminated'), /Unclosed/);
});

test("completion handles prefixes without interpreting command arguments", () => {
  assert.equal(completions("/").length, COMMANDS.length);
  assert.deepEqual(
    completions("/con").map((item) => item.name),
    ["connect", "config"],
  );
  assert.deepEqual(completions("/connect "), []);
  assert.deepEqual(completions("hello"), []);
  assert.deepEqual(completions("/not-a-command"), []);
});
