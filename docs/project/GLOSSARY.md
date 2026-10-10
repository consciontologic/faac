# Glossary

| Term             | Meaning                                                                                 |
| ---------------- | --------------------------------------------------------------------------------------- |
| Adapter snapshot | Versioned endpoint and curated metadata used consistently during one request.           |
| Ambiguous action | A tool intent was persisted, but its final outcome cannot yet be established.           |
| Checkpoint       | Recorded file hashes and Git status; not a full filesystem backup.                      |
| Compaction       | Persisted reduction of the context sent to a smaller model; full history stays on disk. |
| Connection       | The configured credential and account eligibility for one provider.                     |
| Free eligibility | Evidence that an inference route meets faac's recurring-free requirements.              |
| Listed as free   | Catalog evidence; distinct from a successful authenticated request.                     |
| Pool             | A quota shared by models or by one provider account.                                    |
| Quarantine       | An integration is excluded after an unreviewed compatibility change.                    |
| Session          | Durable objective, messages, tool actions, edits, checkpoints, and routing attempts.    |
| Strict free-only | Paid, unknown-price, trial, and uncertain-overage routes are excluded.                  |
| Tool intent      | A durable record created before execution, used for recovery and reconciliation.        |
| Tracking row     | Contributor activity recorded in the repository CSV; separate from a user session.      |
| Workspace        | The directory faac is authorized to operate in, separate from its installation.         |
