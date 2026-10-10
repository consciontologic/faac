# Decision log

Project-level decisions are append-only. Architecture details live in [design](../design/README.md).

| ID   | Date       | Decision                                                                   | Reason and consequence                                                                                                                       | Owner        |
| ---- | ---------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| 0001 | 2026-10-10 | Use MIT licensing                                                          | Permit reuse while retaining required upstream notices.                                                                                      | Serhat Akbak |
| 0002 | 2026-10-10 | Enforce strict free-only inference                                         | Unknown prices, trials, and uncertain automatic overage cannot become fallback destinations.                                                 | Serhat Akbak |
| 0003 | 2026-10-10 | Start with official OpenRouter and Groq APIs                               | Keep endpoint, authentication, and capability contracts small enough to review and test.                                                     | Serhat Akbak |
| 0004 | 2026-10-10 | Keep state separate from install and working directories                   | Sessions survive upgrades and do not pollute user repositories.                                                                              | Serhat Akbak |
| 0005 | 2026-10-10 | Scaffold with agentic-workspace and adapt wfform DevOps practices          | Shared instructions, tracking, review, and release tooling replace one-off maintenance.                                                      | Serhat Akbak |
| 0006 | 2026-10-10 | Prefer an explicit inexpensive Copilot model for repository automation     | MAI-Code-1.1-Flash is the requested default; unavailable or unsupported models fail visibly instead of switching to Auto or a premium model. | Serhat Akbak |
| 0007 | 2026-10-10 | Delegate routine implementation and review through controlled PR workflows | AI output stays subject to deterministic checks, branch policy, permissions, and cost controls.                                              | Serhat Akbak |
