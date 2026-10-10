# Security

## Reporting

Report a suspected vulnerability through GitHub's **Report a vulnerability** action on this repository's Security tab when private reporting is enabled. If unavailable, open an issue asking for a private contact without posting exploit details, credentials, or private user data. Maintainers will coordinate a private channel before sensitive material is shared.

The current `0.x` series is maintained through the latest release. No response-time guarantee or paid support agreement is implied.

## Boundaries

faac executes approved shell commands without a sandbox. Such commands can access external files and services. File tools validate workspace paths, permissions, and expected hashes, but shell approval grants the full authority of the command. Run the agent with the least account access needed.

Credentials belong in environment variables, a secret manager, or faac's passphrase-encrypted vault. Do not pass them in prompt arguments, commit them in configuration, or attach raw transcripts to reports. Redaction reduces accidental disclosure; it cannot prove an arbitrary document contains no secrets.

Upstream synchronization fetches into a faac-owned Git cache and parses a bounded subset of source as data. It never imports fetched TypeScript, installs upstream packages, or runs repository scripts. Unknown compatibility changes quarantine the affected integration.

## Repository automation

AI issue and PR workflows must run only within the authorized label/branch policy, with minimal token scopes, explicit model choice, and bounded budgets. PR text and source are untrusted inputs. Required checks and merge gates remain necessary even when implementation and review are delegated. See [DevOps](docs/guides/DEVOPS.md) for credential roles and trigger rules.

Rotate a credential through its provider when exposure is confirmed, remove it from active configuration, and review access logs. Removing a value from the latest Git revision does not remove it from history.
