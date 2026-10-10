# Copilot instructions for faac

Read [AGENTS.md](../AGENTS.md) first. faac is a Node.js 22+ / TypeScript
terminal coding agent; its application routes only to verified hosted free
models. Development Copilot subscriptions are a separate cost boundary.

- Inspect the workspace and preserve concurrent edits. Read
  [architecture](../docs/code/ARCHITECTURE.md), [GitFlow](../docs/guides/GITFLOW.md)
  and [DevOps](../docs/guides/DEVOPS.md) before changing those areas.
- Run `make verify`. Keep deterministic tests separate from authenticated live
  tests; never claim mocked output proves provider access.
- Protect incremental sessions, complete-tool-call execution, hash conflicts,
  uncertain side effects, cancellation and strict free-only routing.
- Never modify the reference OmniRoute checkout. Update via faac's validated
  Git cache; do not execute downloaded upstream source.
- Use the explicit `mai-code-1.1-flash` cloud task model. Do not select Auto,
  switch to a more expensive model, or retry an uncertain task submission.
  Native Copilot review controls its own model; its model cannot be pinned.
- Copilot cloud agent may commit/push its assigned `copilot/*` branch and open
  the requested PR. Local coordinating agents publish validated work with
  `make git`; subagents return evidence to their parent. Never bypass checks,
  merge your own PR, push protected branches, alter secrets or change model policy.
- Load relevant skills from [the skill library](../.agents/skills/README.md).
  MCP is disabled; use local source/search tools without installing integrations.
- Keep tracking concise, use Conventional Commits, and update the existing
  documentation for a topic rather than adding duplicate guides.

Custom roles are [planner](agents/planner.agent.md),
[implementer](agents/implementer.agent.md), [reviewer](agents/reviewer.agent.md)
and [verifier](agents/verifier.agent.md). IDE prompts in [prompts](prompts/)
are task helpers, distinct from faac's own terminal slash commands.
