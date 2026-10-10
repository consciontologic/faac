# CLI contract

## Interface

The supported public interface is the `faac` command and slash commands. There is no local REST server. Node module exports are implementation details for now.

```bash
faac --help
faac --cwd ./project
faac -C ./project -p 'Explain this repository' --no-sync
faac -C ./project -p 'Fix the tests' --allow-edit --allow-command 'npm test'
faac --resume SESSION_ID
faac -C ./project -p '/status' --json --no-sync
```

`SESSION_ID` is an existing ID from `/sessions`. `--cwd` and `-C` choose the workspace; without them the launch directory is used. `-p` runs one request and exits. Piped standard input supplies a request when neither `-p` nor `--resume` is given. Input is bounded to 1 MB. `--no-sync` disables automatic checks for that process, not manual `/sync`.

## Authentication and authorization

Inference uses `OPENROUTER_API_KEY` or `GROQ_API_KEY`, or the encrypted `/connect` vault. `FAAC_VAULT_PASSWORD` can unlock a saved vault noninteractively. Groq additionally requires Free-plan confirmation. Keys never belong in prompt arguments. Environment values are not loaded automatically from `.env` files.

File edits, shell commands, sensitive reads, and out-of-workspace access follow tool policy. `--allow-edit` permits workspace file edits for that launch. Repeated `--allow-command` flags allow exact shell commands, not arbitrary command prefixes. Noninteractive runs deny an action when confirmation would be needed.

## Output

Normal interactive output is formatted for a terminal. Redirected output has no cursor controls. `--json` emits one JSON object per event with `type` and `text` fields. Types are `text`, `status`, `fallback`, `warning`, `compaction`, `tool`, `diff`, and `model`. Consumers should ignore unknown future event types. Error diagnostics go to standard error.

## Exit status

| Code | Meaning                                                                 |
| ---- | ----------------------------------------------------------------------- |
| `0`  | Invocation completed normally; inspect events for command details       |
| `1`  | Argument, runtime, configuration, or uncaught operation error           |
| `2`  | A noninteractive coding task is blocked or cancelled and may be resumed |

A successful `/models` or `/doctor` invocation does not prove authenticated inference. Use `/doctor live` for a small actual request and a coding test for end-to-end proof.

## Compatibility and limits

The package uses semantic versions. During `0.x`, consumers should pin a version and test upgrades; state files include schema/version information and are not intended as a stable third-party database API. Unknown parameters fail validation. Provider quotas, the configured step limit, context windows, file-size bounds, and capability changes can stop a task durably. No unlimited quota, lossless compaction, or exactly-once external side effect is promised.

The full [usage guide](../guides/USAGE.md) lists slash-command arguments and working examples.
