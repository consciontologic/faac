# faac

**Ask for a code change. Keep your work when the model changes.**

[![CI](https://github.com/consciontologic/faac/actions/workflows/ci.yml/badge.svg)](https://github.com/consciontologic/faac/actions/workflows/ci.yml)
[![Node.js 22+](https://img.shields.io/badge/node-%3E%3D22-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![MIT license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

faac is a terminal coding assistant powered by hosted free models. It reads your project, edits files with conflict checks, runs commands you approve, and checks the results. Sessions survive restarts. When a model becomes unavailable, another eligible free model can continue the same task.

**[Start here: usage guide](docs/guides/USAGE.md)** · [Development](docs/guides/DEVELOPMENT.md) · [AI and releases](docs/guides/DEVOPS.md) · [Verification](docs/reports/VERIFICATION.md)

## What you get

- **A working coding loop:** file search, reads, patches, writes, approved shell commands, and test results.
- **Work preservation:** incremental sessions, checkpoints, edit hashes, conflict-aware undo, and resumable blocked tasks.
- **Strict free routing:** official OpenRouter and Groq APIs; no silent paid fallback, local model, or running OmniRoute server.
- **A usable terminal:** streaming Markdown and highlighted code, diffs, multiline editing, history, slash completion, cancellation, narrow layouts, and `NO_COLOR`.
- **Reviewed upstream updates:** a dedicated Git cache, validated data extraction, atomic activation, quarantine, and rollback.

## Install from source

Requires **Node.js 22+**, npm, and Git. Linux is the verified environment.

```bash
git clone https://github.com/consciontologic/faac.git
cd faac
npm ci
npm run build
npm_config_prefix="$HOME/.local" npm link
export PATH="$HOME/.local/bin:$PATH"
```

Keep the PATH entry in your shell configuration if needed. The npm prefix applies only to this command. To run without linking, use `node /path/to/faac/dist/cli.js`.

Now open the project you want to work on:

```bash
cd /path/to/your/project
faac
```

Inside faac, connect a provider and ask for a change:

```text
/connect openrouter
/models refresh
Explain this project, then suggest a small improvement I can verify.
```

Enter the API key in the hidden prompt. A passphrase encrypts the local credential vault; it is not stored. Hosted free access can require credentials. See the [first-task walkthrough](docs/guides/USAGE.md#1-your-first-task).

## Copyable examples

```bash
# Pick the workspace explicitly.
faac --cwd /path/to/project

# Authorize workspace edits and one exact test command.
faac -C /path/to/project -p 'Fix the failing parser test' \
  --allow-edit --allow-command 'npm test'

# Continue a saved objective from /sessions.
faac --resume SESSION_ID

# Machine-readable status without automatic upstream checks.
faac -C /path/to/project -p '/status' --json --no-sync
```

Type `/` for the command menu. Useful starting commands are `/help`, `/status`, `/models`, `/permissions`, `/diff`, `/undo`, `/sessions`, and `/sync status`. Installation, workspace, and state are separate: state defaults to `~/.local/share/faac`, or `FAAC_HOME`.

## Free means verified eligibility

| Provider   | Eligibility                                                                                                                        |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| OpenRouter | Explicit `:free` model, fresh zero-price catalog data, advertised tool support, and a zero-price request route                     |
| Groq       | Confirmed Free-plan account with no paid billing/automatic overage, reviewed model capabilities, and fresh recurring-free evidence |

Trials, one-time credits, unknown prices, and uncertain overage are ineligible. A catalog listing is not proof of successful inference. Models can have different capabilities, context windows, and shared account limits. `/models`, `/status`, and `/doctor live` expose the distinction.

## Know the boundaries

Shell commands run **without a sandbox** and can have effects outside the workspace; approve them carefully. `/undo` reverses only faac-owned file edits whose current hashes match. Checkpoints record hashes rather than backing up arbitrary shell changes. Context compaction is explicit and persisted, but cannot be lossless for every model.

Use a readable monospace font in an xterm-compatible terminal. An 80-column window is comfortable; narrower layouts are supported. faac cannot change the terminal emulator's font. `NO_COLOR=1` disables color and `FAAC_ASCII=1` selects simpler symbols.

## Develop and verify

```bash
make check
make build
make test.terminal
make package.test
```

Tests using simulated providers are separate from opted-in authenticated tests. Actual OpenRouter coding, process restart/resume, and alternate-model inference after an injected interruption passed on 2026-10-10. Groq authenticated fallback and natural quota exhaustion remain unverified. See [the evidence and reproduction steps](docs/reports/VERIFICATION.md).

The repository includes GitFlow checks, cost-controlled Copilot delegation, package verification, release automation, and a GHCR container workflow. Credential- and account-dependent automation must be configured before it can run; see [DevOps](docs/guides/DEVOPS.md).

## Source and license

MIT licensed. faac adapts attributed public OmniRoute catalog data and reviewed routing concepts; it does not copy the full application or its private Radar backend. Development scaffolding comes from agentic-workspace, with DevOps patterns adapted from wfform. Read [attribution](docs/project/ATTRIBUTION.md) and [third-party notices](THIRD_PARTY_NOTICES.md).
