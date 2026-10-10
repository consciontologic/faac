# Agent engine

## Purpose and surface

`src/engine.ts` drives one durable user objective through hosted inference and validated local tools.

| Symbol                       | Role                                                                                                         |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `Engine`                     | Coordinates session state, provider client, router, tool runner, and event sink                              |
| `Engine.run(prompt, signal)` | Records a new prompt or resumes the retained objective; respects cancellation                                |
| `contextFor(...)`            | Builds a provider-neutral context with instructions, tool results, workspace state, and persisted compaction |
| `ProviderClient`             | Discovery and streaming completion contract in `src/types.ts`                                                |

## Execution

The loop obtains a validated adapter snapshot and eligible model, validates effective parameters, records a routing attempt, and consumes the response. Streamed text is persisted incrementally. Complete tool calls are validated and passed to `ToolRunner`; results join the canonical history. The router classifies failures and records bounded retry/cooldown state. Exhausted routes pause the session with the next retry time where known. Three consecutive permission denials pause rather than waste additional requests.

## Invariants

Completed edits survive provider changes. Incomplete tool calls are not executable. Ambiguous actions must be reconciled against actual state. Cancellation never activates fallback. Essential parameters exclude incompatible models rather than disappearing. The active workspace and exact preapproved shell commands appear in model context.

## Dependencies and tests

The engine depends on `Store`, `Router`, `ToolRunner`, `ProviderClient`, and the parameter registry. `tests/engine.test.ts` covers fallback, shared context, completed edits, compaction, exhaustion, cancellation, and permission failures. `tests/tools.test.ts` verifies actual filesystem conflicts and uncertain outcomes. `tests/live/` uses separately opted-in authenticated providers; it is excluded from `npm test`.

The [roadmap](../planning/ROADMAP.md) tracks live cross-provider verification. A deterministic provider implementation proves engine behavior, not real account access.
