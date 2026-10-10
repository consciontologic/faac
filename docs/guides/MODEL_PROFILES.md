# Model selection and cost

There are two independent model systems:

- **faac runtime:** OpenRouter/Groq models that pass strict free-only routing. Configure them with `/models`, `/route`, and `/params`.
- **Explicit repository delegation:** GitHub Copilot performs assigned development tasks and separately requested reviews. Its account access and billing are separate from faac's free-only policy.

## Repository task model

The configured choice is **MAI-Code-1.1-Flash**, API model ID `mai-code-1.1-flash`. The local task helper uses an explicit allowlist and does not fall back to `Auto` or an arbitrary premium model. If the account, endpoint, or task cannot use it, the helper stops visibly.

GitHub's [2026-08-11 availability announcement](https://github.blog/changelog/2026-08-11-mai-code-1-1-flash-available-in-github-copilot/) describes a 73% lower list price than MAI-Code-1-Flash and a 0.25× premium-request multiplier for annual subscribers; usage-based accounts use provider list pricing. This is the reason for the inexpensive default, checked on 2026-10-10. It is not a fixed per-task bill.

Availability and billing can change. Before submitting a task, verify the model is available to the account and examine GitHub's current pricing. “Cheap” does not mean anonymous, unlimited, or guaranteed free. Each helper invocation submits one explicitly requested task. There is no automatic delivery controller, repair purchaser, or scheduled retry. [DevOps](DEVOPS.md) describes the request and receipt flow.

## Reviews

GitHub's native Copilot code review chooses its own model mix. Selecting the task model does not select a review model. Where the account exposes review effort, choose the Lite setting for inexpensive routine review, then inspect GitHub's reported usage. Never claim a cost setting is applied just because it appears in this document.

## Local agents

Codex roles inherit the user's selected model. Scaffold prompts and roles do not authorize an automatic premium upgrade. If a task needs a stronger model, keep the current work and report the concrete limitation. Keep prompts scoped, include failing test output and relevant files, and avoid resubmitting unchanged large histories.

Public pricing and availability are external facts; the repository's policy is the durable constraint: explicit choice, bounded work, visible failure, no silent costly fallback.
