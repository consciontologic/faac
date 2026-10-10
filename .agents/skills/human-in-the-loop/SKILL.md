---
name: human-in-the-loop
description: "Identify missing authorization or consequential ambiguity that requires human input."
---

# Human in the loop

## When to stop and ask

Stop the loop and ask the human when:

First check whether the user already authorized the specific action in this
session. Do not ask again for existing authorization. Never treat a skill as
permission to perform operations forbidden by AGENTS.md.

1. **System-level change** is needed (`apt`, `systemctl`, `/etc/**`,
   global git config). Always.
2. **Scope outside the allow-list** — the task asks for something the
   plan / charter explicitly excludes.
3. **Destructive operation without authorization** — deleting user data or
   dropping a database table. Forbidden Git operations remain forbidden.
4. **External-visible side effect without authorization** — commenting on a PR,
   sending a message or paying money. Agents never commit or push in this repo.
5. **Consequential ambiguity** that available context cannot resolve and where
   a wrong choice would be expensive to undo.

## When NOT to stop

- Mid-phase, between bullets, because "you'd feel better if the user
  confirmed". → [`phase-persistence`](../phase-persistence/SKILL.md).
- Before running tests, lints, type-checks — they're cheap and reversible.
- Before staging — staging is the agent's job. Pushing is the human's.
- After every tool call to summarise — the human reads the final message.

## Procedure (when you do stop)

1. **State the situation** in one paragraph.
2. **State your recommendation** in one sentence.
3. **State the trade-off** of the alternative in one sentence.
4. **Provide a yes/no or A/B response template.**

## Anti-patterns

- ❌ Asking for permission to do something inside the allow-list.
- ❌ Doing something outside the allow-list without asking.
- ❌ Asking a yes/no question with no recommendation — the human has less context than you do at that moment.
