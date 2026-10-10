#!/usr/bin/env python3
"""Exercise the real terminal component in a pseudoterminal (no provider calls).

Run: python3 scripts/ad-hoc/pty-smoke.py
Requires the optional Python developer package pexpect; not a faac dependency.
"""
import json
import os
from pathlib import Path
import re
import shutil
import sys
import subprocess
import tempfile

import pexpect

ROOT = Path(__file__).resolve().parents[2]
NODE = shutil.which("node")
HARNESS = r'''
import { Terminal } from "./src/terminal.ts";
const terminal = new Terminal();
terminal.header({workspace:"/tmp/faac terminal smoke", session:"pty-session", model:"openrouter/free-model", state:"ready"});
const first = await terminal.input(["saved history"]);
terminal.event({type:"model",text:"openrouter/free-model"});
terminal.event({type:"text",text:"# Result\nStreaming **Markdown** and `code`.\n```typescript\n"});
terminal.event({type:"text",text:"const answer = 42;\n```\n"});
terminal.event({type:"tool",text:"read_file src/example.ts"});
terminal.event({type:"diff",text:"--- before\n+++ after\n@@ line 1 @@\n-old\n+new"});
terminal.event({type:"fallback",text:"HTTP 429: shared pool cooldown; continuing with healthy free model"});
const confirmation = await terminal.confirm("Run a shell command? It may change workspace files.");
const credential = await terminal.secret("API credential (hidden)");
const last = await terminal.input(["saved history"]);
terminal.close();
process.stdout.write("RESULT:"+JSON.stringify({first, confirmation, credentialLength:credential?.length, last})+"\n");
'''


def run(width, no_color):
    env = dict(os.environ, TERM="xterm-256color", FAAC_ASCII="1" if no_color else "0")
    if no_color:
        env["NO_COLOR"] = "1"
    else:
        env.pop("NO_COLOR", None)
    child = pexpect.spawn(NODE, ["--import", "tsx", "--input-type=module", "-e", HARNESS], cwd=str(ROOT), env=env, encoding="utf-8", dimensions=(24, width), timeout=10)
    capture = []
    class Capture:
        def write(self, text): capture.append(text)
        def flush(self): pass
    child.logfile_read = Capture()
    child.expect("Enter send")
    child.send("/sta")
    child.expect("/status")
    child.send("\t\r")
    child.expect("Allow\\? ")
    child.send("\r")
    child.expect("API credential")
    child.send("private-smoke-secret\r")
    child.expect("credential hidden")
    child.expect("Enter send")
    child.setwinsize(18, 28)
    child.send("\x1b[200~line one\r\nline two\x1b[201~")
    child.send("\x1b[D\x7f!\r")
    child.expect(r"RESULT:(\{[^\n]+\})")
    result = json.loads(child.match.group(1))
    child.expect(pexpect.EOF)
    child.close()
    transcript = "".join(capture)
    assert result == {"first": "/status", "confirmation": False, "credentialLength": 20, "last": "line one\nline t!o"}, result
    assert "private-smoke-secret" not in transcript
    assert child.exitstatus == 0, child.exitstatus
    assert "[fallback]" in re.sub(r"\x1b\[[0-9;]*m", "", transcript)
    if no_color:
        assert not re.search(r"\x1b\[(?:3[0-9]|9[0-9]|1)(?:;|m)", transcript)
    return {"columns": width, "resizedColumns": 28, "noColor": no_color, "exit": child.exitstatus, "checks": ["slash completion", "streamed Markdown", "syntax-highlighted fence", "diff", "fallback notice", "deny by default", "hidden secret", "multiline paste", "cursor edit", "resize"]}


def run_cli():
    """Actual CLI control flow, isolated durable state, and real filesystem tools."""
    with tempfile.TemporaryDirectory(prefix="faac-cli-smoke-") as temporary:
        base = Path(temporary)
        workspace = base / "workspace"
        workspace.mkdir()
        alternate = base / "other workspace"
        alternate.mkdir()
        sentinel = workspace / "existing.txt"
        sentinel.write_text("existing user work\n", encoding="utf-8")
        env = {key: value for key, value in os.environ.items() if key not in ("OPENROUTER_API_KEY", "GROQ_API_KEY", "FAAC_VAULT_PASSWORD")}
        env.update(TERM="xterm-256color", NO_COLOR="1", FAAC_HOME=str(base / "state"))
        child = pexpect.spawn(NODE, ["dist/cli.js", "--no-sync", "--allow-edit", "--cwd", str(workspace)], cwd=str(ROOT), env=env, encoding="utf-8", dimensions=(30, 88), timeout=15)
        child.expect("Enter send")

        def command(text, result):
            child.send(text + "\r")
            child.expect(result)
            child.expect("Enter send")

        command("/status", r'"state": "idle"')
        command("/init", r'"saved":true')
        guidance = (workspace / "AGENTS.md").read_text(encoding="utf-8")
        command("/init", "AGENTS.md already exists; preserved")
        assert (workspace / "AGENTS.md").read_text(encoding="utf-8") == guidance
        command("/checkpoint smoke", r"saved \(file hashes")
        command("/diff", "after faac edit")
        command("/undo", "Undid AGENTS.md")
        assert not (workspace / "AGENTS.md").exists()
        command("/diff", "No faac-owned edits")
        command("/permissions", "Shell is unsandboxed")
        command("/params set heat 0.3", "Parameter temperature updated")
        command("/config set maxSteps 12", "Configuration saved")
        command("/config", r'"maxSteps": 12')
        command('/cd "' + str(alternate) + '"', "Workspace  ")
        child.send("/exit\r")
        child.expect(pexpect.EOF)
        child.close()
        assert child.exitstatus == 0, child.exitstatus
        assert sentinel.read_text(encoding="utf-8") == "existing user work\n"
        sessions = [json.loads(file.read_text()) for file in (base / "state" / "sessions").glob("*/session.json")]
        edited = next(session for session in sessions if session["workspace"] == str(workspace))
        assert edited["edits"][0]["undone"] is True
        assert edited["checkpoints"][-1]["label"] == "smoke"
        assert edited["params"]["temperature"] == 0.3
        assert all(action["state"] == "completed" for action in edited["actions"])

        common = [NODE, str(ROOT / "dist/cli.js"), "--no-sync"]
        one_shot = subprocess.run(common + ["--json", "-p", "/status"], cwd=str(workspace), env=env, text=True, capture_output=True, check=True)
        assert "\x1b" not in one_shot.stdout
        events = [json.loads(line) for line in one_shot.stdout.splitlines()]
        status = json.loads(events[-1]["text"])
        assert status["workspace"] == str(workspace)
        resumed = subprocess.run(common + ["--json", "--resume", edited["id"], "-p", "/status"], cwd=str(alternate), env=env, text=True, capture_output=True, check=True)
        resumed_status = json.loads(json.loads(resumed.stdout.splitlines()[-1])["text"])
        assert resumed_status["session"] == edited["id"]
        assert resumed_status["workspace"] == str(workspace)
        redirected = subprocess.run(common, input="/status\n", cwd=str(workspace), env=env, text=True, capture_output=True, check=True)
        assert "\x1b" not in redirected.stdout
        assert str(workspace) in redirected.stdout
        json_tty = pexpect.spawn(NODE, [str(ROOT / "dist/cli.js"), "--no-sync", "--json", "--cwd", str(workspace), "-p", "/status"], cwd=str(ROOT), env=env, encoding="utf-8", timeout=15)
        json_tty.expect(pexpect.EOF)
        json_output = json_tty.before
        json_tty.close()
        assert json_tty.exitstatus == 0
        assert "\x1b" not in json_output
        assert json.loads(json.loads(json_output.splitlines()[-1])["text"])["workspace"] == str(workspace)
        assert json.loads((base / "state" / "config.json").read_text())["permissions"]["edit"] == "ask", "--allow-edit leaked into persisted config"
        chosen = subprocess.run(common + ["--json", "--cwd", str(alternate), "-p", "/status"], cwd=str(workspace), env=env, text=True, capture_output=True, check=True)
        assert json.loads(json.loads(chosen.stdout.splitlines()[-1])["text"])["workspace"] == str(alternate)
        return {"exit": child.exitstatus, "providerCalls": 0, "checks": ["launch directory", "explicit --cwd", "interactive /cd", "/status", "/init create and preserve", "/checkpoint", "/diff", "/undo", "existing file preservation", "durable session edits/actions", "resume saved session", "session parameter", "config validation", "one-shot --json", "--json inside actual TTY", "temporary --allow-edit permission", "redirected request"]}


if __name__ == "__main__":
    if not NODE:
        sys.exit("Node.js is required")
    result = {"component": "terminal", "providerCalls": 0, "runs": [run(88, False), run(36, True)]}
    if (ROOT / "dist/cli.js").is_file():
        result["cli"] = run_cli()
    print(json.dumps(result, indent=2))
