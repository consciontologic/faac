# How to use faac

faac is an AI coding assistant that runs in your terminal. You tell it what to do. It can read your project, change files, run commands you approve, and check the results.

It uses hosted free models. You need internet access and a provider API key. You do not need a local model or an OmniRoute server.

Start with the walkthrough below if faac is installed. Otherwise, follow the installation instructions at the end first.

Read section 1 to get started. Use the rest as a reference: [prompt examples](#3-everyday-requests-you-can-copy), [resume a task](#5-stop-leave-and-continue-later), [troubleshooting](#11-updates-and-troubleshooting), and [command list](#12-keyboard-and-command-reference).

Two places to type:

- **Your normal terminal:** commands such as `cd`, `faac`, and `node`.
- **Inside faac:** plain-English requests and slash commands such as `/status`.

Run slash commands **one line at a time**. A pasted multiline block stays together as one input.

## 1. Your first task

### Open a practice folder

In your normal terminal:

```bash
mkdir -p "$HOME/code/faac-playground"
cd "$HOME/code/faac-playground"
faac
```

Check the workspace shown at the top. That is where faac will work.

The installation is where faac's program files live, whether installed from a release or a source checkout. You do not need to launch from there. Launching from a project folder makes that folder the workspace.

### Connect OpenRouter

Inside faac:

```text
/connect openrouter
```

1. Paste your OpenRouter API key into the hidden prompt and press Enter.
2. Choose a vault passphrase with at least 12 characters. Remember it: faac does not save the passphrase.
3. If a vault already exists, use its existing passphrase.

The key is saved in an encrypted local vault. On later launches, faac asks you to unlock it when it needs the key. You do not need to reconnect every time.

If `OPENROUTER_API_KEY` is already set in your environment, faac uses it and skips the key-saving prompt.

List the eligible models:

```text
/models refresh
```

Optionally check that authenticated inference works:

```text
/doctor live
```

This sends a small real model request and uses part of your free allowance. Seeing a model in `/models` alone does not prove your key works.

### Ask for a small program

Paste this as one request inside faac:

```text
Create sum.cjs with a function sum(a, b) that returns a + b.
Export it with module.exports = sum.
Create sum.test.cjs using node:test and node:assert/strict.
Test positive numbers, negative numbers, zero, and decimals.
Run exactly node --test sum.test.cjs and report the result.
Do not install dependencies. Preserve unrelated files.
If either target file already exists, read it before changing it.
```

Press Enter to send it. Read each permission request. Type `y` and Enter to allow the action, or `n` and Enter to deny it. An empty answer means no.

When it finishes, inspect its edits:

```text
/diff
```

Then inspect the saved task:

```text
/status
```

Exit:

```text
/exit
```

You can now check the result yourself in your normal terminal:

```bash
node --test sum.test.cjs
```

Model output can vary. The useful evidence is the actual files and test results, not just the assistant saying it finished.

## 2. Use it in an existing project

From your normal terminal:

```bash
cd /path/to/your/project
faac
```

Or choose the directory directly:

```bash
faac --cwd /path/to/your/project
```

`-C` is the short version of `--cwd`. Quote paths containing spaces:

```bash
faac -C "/path/to/my project"
```

Replace the example paths with real directories. The directory must already exist.

A useful first request:

```text
Read the project instructions and explain how this project is organized.
Find the commands used to run it and test it. Do not edit anything yet.
```

To change projects while faac is open:

```text
/cd /path/to/another/project
```

This starts a new session in that directory. Your previous session remains saved. Relative paths are resolved from the current workspace; use an absolute path if unsure. Use the full home-directory path instead of `~` or `$HOME` inside `/cd`; slash commands do not expand shell variables.

## 3. Everyday requests you can copy

Give faac a task, the intended result, and any limits that matter.

**Fix a bug:**

```text
Find why submitting an empty login form crashes the app.
Fix the cause and add a focused regression test.
Keep the existing UI and avoid unrelated changes.
Run the relevant tests and tell me their actual results.
```

**Add a feature:**

```text
Add a search field to the users page that filters by name.
Follow the existing UI style and state-management approach.
Check the current code before choosing an implementation.
Do not add dependencies unless you explain why they are needed.
```

**Understand unfamiliar code:**

```text
Trace what happens when a user clicks Save.
Show the relevant files and functions in order.
Do not change files or run shell commands.
```

**Work on a failing test:**

```text
Inspect package.json and the project instructions to find the test command.
Run the relevant tests, diagnose the failure, and fix it.
Do not weaken assertions just to make the test pass.
```

**Review existing changes:**

```text
Review the current Git diff for bugs and missing tests.
Explain concrete problems with file references.
Do not edit, stage, commit, or discard anything.
```

**Continue a previous change:**

```text
Add tests for empty input and Unicode to the function you just changed.
Keep its current public API.
```

Use follow-up requests in the same session. You do not need to restate the entire project each time.

## 4. Permissions: what gets approved

By default, ordinary file reads are allowed. Edits, shell commands, and access outside the workspace ask for approval. Sensitive files can need separate approval.

Inspect the current settings:

```text
/permissions
```

To let faac edit files without asking each time:

```text
/permissions edit allow
```

To restore edit confirmations:

```text
/permissions edit ask
```

To enforce an inspection-only session, deny edits and shell execution:

```text
/permissions edit deny
/permissions shell deny
```

Restore those settings when finished:

```text
/permissions edit ask
/permissions shell ask
```

**These settings persist across launches and projects that use the same faac state directory.** They are not limited to the current session. Shell and outside-workspace access support `ask` or `deny`; they do not support unrestricted `allow`.

For automatic workspace edits during just one launch, use:

```bash
faac --cwd /path/to/project --allow-edit
```

That flag overrides the saved edit policy for that launch. It does not approve shell commands or outside-workspace access.

Shell commands run with your operating-system permissions. Review the actual command before approving it. After three consecutive permission denials, faac pauses rather than repeatedly trying blocked actions. Adjust the permissions if appropriate, then use `/resume`.

## 5. Stop, leave, and continue later

- Press **Ctrl-C while faac is working** to cancel the task. Cancellation does not trigger model fallback.
- Type **`/exit`** at the input prompt to save and close.
- Press **Ctrl-D on empty input** to exit.

Completed edits remain on disk when you cancel. Stopping work does not undo it.

To find saved sessions, open faac and run:

```text
/sessions
```

Each entry shows its ID, workspace, state, and task. Copy the ID you want:

```text
/resume SESSION_ID
```

Replace `SESSION_ID` with that real ID. **This immediately continues the saved task.** It switches to the session's saved workspace.

For a paused task in your current session:

```text
/resume
```

From your normal terminal:

```bash
faac --resume SESSION_ID
```

To inspect a saved session without continuing model work:

```bash
faac --resume SESSION_ID --no-sync -p "/status"
```

If a shell command was interrupted and its outcome is uncertain, `/status` shows its action ID. Check what actually happened before continuing. After you have reconciled the result:

```text
/checkpoint resolve ACTION_ID
/resume
```

Replace `ACTION_ID` with the ID shown in `/status`. Resolving it acknowledges the outcome; it does not rerun or undo the command.

## 6. Review changes and undo an edit

Review file edits made by faac in this session:

```text
/diff
```

Undo the most recent reversible faac file edit:

```text
/undo
```

Undo checks the current file first. If someone changed it afterward, faac reports a conflict instead of silently replacing that work. Undo can also require edit permission.

`/undo` handles one recorded file edit at a time. It cannot reverse arbitrary shell commands, package installations, Git operations, or external effects. `/diff` is also limited to recorded faac file edits; use your normal Git tools to review the whole workspace.

Record a named checkpoint before a larger task:

```text
/checkpoint before-search-feature
```

List checkpoints:

```text
/checkpoint list
```

A checkpoint records file hashes and Git status. It is not a full backup, and there is no command to restore an entire checkpoint. Keep using Git for normal version control.

## 7. Models, free limits, and fallback

Usually, leave model selection on automatic:

```text
/models auto
```

To choose a preference, run `/models`, copy the full eligible model identifier, and use:

```text
/models PROVIDER/MODEL_ID
```

`PROVIDER/MODEL_ID` is a placeholder for an entry from your current list. Model availability changes, so use the listed identifier. Choosing a preferred model keeps free fallback enabled.

When a recoverable model or provider failure occurs, faac tries another eligible option and shows the reason. It keeps saved conversation, tool results, and completed work. A smaller-context model may require visible compaction: older detail remains saved locally but is not all sent to the new model.

Changing models does not create a fresh account allowance. OpenRouter free models share account limits. If every eligible option is unavailable, faac saves the task and pauses. Check `/status` for a known retry time, then use `/resume` when the service is available again. It never silently switches to paid models.

To add Groq as another provider:

```text
/connect groq
```

You need a Groq API key and a confirmed Free-plan account with paid billing and automatic overage disabled. faac asks for that confirmation because it cannot determine the billing plan from the model list.

After connecting both providers, set their priority:

If you previously selected a specific model, run `/models auto` first so provider priority decides. An explicit model preference takes precedence over the provider order.

```text
/route openrouter groq
```

Reverse the order to prefer Groq:

```text
/route groq openrouter
```

Only providers included in the route are considered. `/route` shows the current order, and `/providers` shows connection and adapter status.

Remove a connection:

```text
/disconnect groq
```

If its API key was set through your shell environment, unset that variable in your shell too.

## 8. Adjust model settings

Start with defaults. If you want to change them, inspect the available settings first:

```text
/params
```

Example: set temperature, also called heat, for this session:

```text
/params set heat 0.2
```

Example: set a persistent output-token limit:

```text
/params default max_tokens 4096
```

This limits output per model response, not the total size or number of steps in a coding task.

Remove that setting:

```text
/params reset max_tokens
```

`set` affects the session. `default` affects future use; session overrides take precedence. `reset` removes both session and persistent values for that parameter. Providers support different settings; faac validates them and reports capability changes during fallback. See `/help params` for argument syntax.

## 9. Run a single request from your shell

Use `-p` to send one request and exit afterward:

```bash
faac -C /path/to/project -p "Explain this project's folder structure. Do not edit files."
```

In a normal interactive terminal, faac can still ask for a vault passphrase or tool permission. An unattended run cannot answer those prompts.

For unattended use, make a credential available through your environment or secret manager. This Bash example reads an OpenRouter key without displaying it or putting the key itself in the command history:

```bash
read -rsp 'OpenRouter API key: ' OPENROUTER_API_KEY
printf '\n'
export OPENROUTER_API_KEY
```

Alternatively, an existing encrypted vault can be unlocked with `FAAC_VAULT_PASSWORD` supplied through your environment or secret manager. faac does not automatically load `.env` files.

Here is a one-request coding example for a disposable workspace:

```bash
faac -C "$HOME/code/faac-playground" \
  --allow-edit \
  --allow-command 'node --test sum.test.cjs' \
  -p 'Create sum.cjs and sum.test.cjs using CommonJS and node:test. Test addition, preserve unrelated files, and run exactly node --test sum.test.cjs.'
```

The command starts in the selected workspace; it does not need a `cd` prefix. Approval matches the exact command string. Repeat `--allow-command` to authorize more specific commands. A saved `shell deny` policy still blocks execution.

Both approval flags last for that launch only. Supply them again if resuming an unattended task that needs those actions.

For newline-delimited JSON events:

```bash
faac -C "$HOME/code/faac-playground" --no-sync --json -p "/status"
```

`--json` disables interactive prompts, including when run in a terminal. Each output line is a JSON event; the whole output is not one JSON document. Normal redirected output omits terminal colors and control sequences.

When finished with an environment key:

```bash
unset OPENROUTER_API_KEY
```

## 10. Project instructions

Inside faac:

```text
/init
```

This creates a starter `AGENTS.md` in the workspace, subject to edit permission. If the file already exists, faac preserves it.

Edit that file to describe your project's actual conventions. For example:

```markdown
# Project guidance

- Use the existing JavaScript style.
- Keep public function names unchanged unless requested.
- Run node --test sum.test.cjs after changing the arithmetic module.
- Do not add dependencies for this small project.
```

Use test commands that exist in your project. faac reads workspace instructions before modifying files.

## 11. Updates and troubleshooting

faac normally checks OmniRoute upstream at startup and polls while open. It uses its own cache and leaves the reference checkout alone.

Check for compatible catalog/adapter updates now:

```text
/sync
```

`/sync` and `/sync check` both fetch, validate, and automatically apply compatible updates. They are not preview-only commands.

Inspect the last result without starting a fetch:

```text
/sync status
```

Restore a previous adapter/catalog version if one is available:

```text
/sync rollback
```

This concerns provider integration data, not your coding edits. It does not install a new faac application release or clear unresolved quarantines. Unrecognized breaking upstream changes can quarantine an integration while healthy integrations remain available.

Skip automatic synchronization for one launch:

```bash
faac --no-sync
```

This does not make hosted inference work offline. Manual `/sync` remains available.

| Problem                          | What to do                                                                                                                            |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `faac: command not found`        | Use the direct Node command under installation below, or add `~/.local/bin` to `PATH`.                                                |
| Missing credential               | Run `/connect openrouter`. For unattended use, supply an environment key or vault passphrase.                                         |
| Vault cannot be unlocked         | Enter the passphrase used when saving the key. Your provider API key is not the vault passphrase.                                     |
| No eligible models               | Run `/providers`, `/models refresh`, and `/doctor`. Check your connection, provider route, and quarantine status.                     |
| Rate limit or quota exhausted    | Check `/status`. Wait for a reported retry time if present, then `/resume`. Switching within a shared pool does not bypass the limit. |
| Permission denied                | Inspect `/permissions`. In unattended runs, approve the exact shell command with `--allow-command`.                                   |
| File conflict                    | Read the current file. Ask faac to continue using its current contents; do not discard concurrent work merely to retry.               |
| Task reached its step limit      | Inspect the progress. Use `/resume` if the task still makes sense. `/config set maxSteps 60` changes the persistent per-run limit.    |
| Interrupted command is uncertain | Inspect its real effects, then use `/checkpoint resolve ACTION_ID` and `/resume`.                                                     |
| Workspace already in use         | Close the other faac instance working there, or choose a different workspace.                                                         |
| Colors or symbols look wrong     | Try `NO_COLOR=1 FAAC_ASCII=1 faac`. Choose the font in your terminal's settings.                                                      |

`/doctor` checks runtime and discovery. `/doctor live` also sends authenticated inference requests. `/help COMMAND` shows argument help, for example `/help sync`.

## 12. Keyboard and command reference

| Key                 | Action                                             |
| ------------------- | -------------------------------------------------- |
| Enter               | Send the current input                             |
| Ctrl-J or Alt-Enter | Insert a newline                                   |
| Tab                 | Complete or cycle slash commands                   |
| Up / Down           | Move between lines, then input history             |
| Ctrl-P / Ctrl-N     | Previous / next history entry                      |
| Ctrl-A / Ctrl-E     | Beginning / end of the current line                |
| Ctrl-W              | Delete the previous word                           |
| Ctrl-U              | Clear text before the cursor on the line           |
| Ctrl-C              | Cancel active work; at idle input, clear the draft |
| Ctrl-D              | Exit when input is empty                           |
| Ctrl-L              | Redraw the input                                   |

Type `/` to discover commands. These are the available commands:

| Command                | Use it to…                                             |
| ---------------------- | ------------------------------------------------------ |
| `/help`                | See commands and keyboard shortcuts                    |
| `/init`                | Create starter project instructions                    |
| `/cd DIRECTORY`        | Start a new workspace session                          |
| `/status`              | Inspect the current task, routing, and quotas          |
| `/models`              | List eligible models or choose a preference            |
| `/providers`           | Inspect provider connections and integration status    |
| `/connect PROVIDER`    | Configure provider credentials                         |
| `/disconnect PROVIDER` | Disable a connection and remove its saved key          |
| `/route`               | View or set provider priority                          |
| `/params`              | Inspect or change model settings                       |
| `/tools`               | Inspect available tool definitions                     |
| `/permissions`         | Inspect or change persistent tool policies             |
| `/sessions`            | Find saved sessions                                    |
| `/resume [SESSION_ID]` | Continue a saved task immediately                      |
| `/checkpoint [LABEL]`  | Record file hashes and Git status                      |
| `/diff`                | Review recorded faac file edits                        |
| `/undo`                | Reverse the latest reversible faac file edit           |
| `/sync`                | Fetch, validate, and apply compatible upstream updates |
| `/doctor`              | Diagnose setup and connectivity                        |
| `/config`              | Inspect persistent configuration                       |
| `/exit`                | Save and close                                         |

## 13. Installation and local files

Skip installation if `faac --version` already works.

The project requires Node.js 22 or newer, npm, and Git. Check your tools:

```bash
node --version
npm --version
git --version
```

Clone once, then install from that directory:

```bash
mkdir -p "$HOME/code"
git clone https://github.com/consciontologic/faac.git "$HOME/code/faac"
cd "$HOME/code/faac"
npm ci
npm run build
npm_config_prefix="$HOME/.local" npm link
export PATH="$HOME/.local/bin:$PATH"
faac --version
```

To keep the PATH entry in new Bash terminals, add this line to `~/.bashrc`:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

Or run directly without the `faac` command:

```bash
node "$HOME/code/faac/dist/cli.js" --cwd /path/to/project
```

| Location                | Contents                                                           |
| ----------------------- | ------------------------------------------------------------------ |
| `$HOME/code/faac`       | Application source and build                                       |
| Your selected workspace | The code faac reads and changes                                    |
| `~/.local/share/faac`   | Sessions, configuration, encrypted credentials, and upstream cache |

`FAAC_HOME` can select a different state directory. That creates a separate configuration/session store; it does not change the coding workspace. Keep the same state directory when you want to find earlier sessions.

For implementation details, see the [README](../../README.md). For actual test results and remaining verification limits, see [verification](../reports/VERIFICATION.md).
