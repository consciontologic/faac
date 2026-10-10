---
agent: ask
description: Peer-review the staged diff (or a commit range) and produce a categorized findings list.
---

# Review changes

Switch to the [`reviewer` custom agent](../agents/reviewer.agent.md).

## Inputs

- Default scope: the currently staged diff (`git diff --cached`).
- Override: a commit range (e.g. `origin/main..HEAD`) or a list of files
  the user provides.

## Steps

1. Load [`.agents/skills/code-review/SKILL.md`](../../.agents/skills/code-review/SKILL.md).
2. Read every changed file linearly.
3. Verify the plan (if there is one) was followed bullet-for-bullet.
4. Use existing test evidence for the reviewed changes or run the relevant gate in a fresh process when needed. Preserve the working tree.
5. Produce the categorized findings list (🚨 Blockers, ⚠️ Concerns, 💡 Suggestions).
6. For each finding: file path link + line, problem statement, suggested fix.

Do not edit files, do not stage, do not commit.
