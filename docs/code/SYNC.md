# Upstream synchronization

faac reads a dedicated, bare partial Git repository under its application data directory at `upstream/repository.git`. It never pulls into the user's OmniRoute checkout, checks out upstream files, runs upstream scripts, installs upstream dependencies, or evaluates fetched TypeScript. Only Git commit/tree metadata and the monitored source blobs are fetched; unrelated binary assets are omitted. Git must be installed. HTTPS is supported for production remotes; absolute local repository paths support offline mirrors and deterministic tests. Credential-bearing URLs and executable Git remote protocols are rejected.

The inspected reference remote is `https://github.com/diegosouzapw/OmniRoute.git`. Its advertised default branch was verified as `release/v3.8.52` on 2026-10-10. The bundled snapshot records the reviewed public commit `7510677f2f8f5317f1947284dab650d01333915d` and the initially inspected local reference commit in `data/baseline.json`. All 89 monitored files were byte-identical between those two revisions. By default, every check resolves the remote's advertised default branch anew. A configured `sync.branch` pins a branch intentionally.

The CLI checks at startup and supports `/sync`, `/sync status`, and `/sync rollback`. Polling uses `sync.intervalMinutes` while the process runs and `sync.enabled` controls automatic checks. The status records the active adapter version, upstream commit, last check, last successful fetch/validation, changed files, model changes, and provider quarantine reasons. A successful check can result in quarantine: it means the revision was inspected, not that every adapter is usable. Polling is not a separate operating-system daemon.

## The trust boundary

The three required catalog files are monitored:

- `open-sse/config/freeModelCatalog.data.ts`
- `src/lib/catalog/openrouterCatalog.ts`
- `src/shared/utils/freeModels.ts`

Monitoring also starts from the supported provider registries, registry aggregation/types, base executor, headers and reasoning helpers, authentication selection, account fallback, OpenRouter quota window, strict zero-cost rules, and Groq field reconciliation. Static local imports and re-exports are followed transitively within the explicitly adapted catalog, API, authentication, quota and error-handling boundary in `src/sync.ts`. Application DB/UI, combo strategy engines, browser integrations, and concrete registry files for unsupported providers are excluded because faac does not execute or adapt those subsystems. Shared helpers inside the supported boundary are watched conservatively. Unsupported provider additions in the registry aggregate do not invalidate the supported provider entries. The exact dependency manifest and provider scope are in the bundled baseline. New imports change the importing file's structural fingerprint and require review. Conservative shared dependencies can quarantine both supported integrations even if a human later finds the change harmless.

TypeScript's parser reads syntax only. A bounded literal decoder accepts explicit objects, arrays, strings, finite numbers, booleans, and null. Calls, property accesses, spreads, computed keys, duplicate properties, executable initializers, and unknown catalog fields are rejected. Catalog rows use a closed schema that distinguishes recurring allowances, keyless models, one-time credit, and discontinued tiers. Display metadata alone never establishes runtime free eligibility; live discovery and the provider's free-only contract still apply.

Reviewed automatic transformations are deliberately narrow:

1. Literal catalog additions, removals, known eligibility changes, quota/pool metadata, and curation dates, after schema validation.
2. Equivalent HTTPS endpoint changes on `openrouter.ai/api/v1/{models,chat/completions}` or `api.groq.com/openai/v1/{models,chat/completions}`, with equivalent spellings such as a trailing slash canonicalized back to the reviewed URL. No host, authentication scheme, protocol version, request shape, or response shape is guessed.
3. Comments and formatting do not change structural fingerprints.

Every other semantic change in monitored request, response, authentication, capability, or dependency code quarantines the affected integration. Its endpoint and catalog data are never executable code. Healthy integrations remain eligible. Quarantine comparisons always use the reviewed bundled baseline, so a second check cannot accidentally bless an unreviewed change. Restoring a compatible upstream revision clears the quarantine. A new reviewed adapter contract requires a faac application update; faac does not promise autonomous repair of arbitrary APIs.

## Activation and recovery

Validated snapshots live under `upstream/versions/<version>/snapshot.json`. Files are written to private temporary files, fsynced, atomically renamed, and followed by an atomic activation pointer. The previous version and a last-known-good version remain on disk. Requests hold a cloned adapter snapshot; background activation cannot mutate an in-flight request. The next routing attempt obtains the current snapshot and revalidates eligibility.

A process lock serializes updates across faac instances. Dead PID locks can be reclaimed; a live owner is respected. Empty locks left before a crashed process wrote its PID expire after one minute. Failed fetches retain the active snapshot. If an active version is unreadable, startup restores the last-known-good content while preserving quarantine from the activation pointer. `/sync rollback` restores prior validated data but deliberately retains unresolved upstream quarantine. Undoing a known incompatibility would not make an old integration safe.

No live provider requests are executed as part of synchronization. The contract gate is static schema/endpoint validation plus the deterministic adapter and synchronization tests shipped with faac. Authenticated connectivity is a separate `/doctor` and live-provider verification concern. Free catalog entries are evidence, not a claim of successful API testing.

## Tests

Run `npx tsx --test tests/sync.test.ts`. Tests create independent local Git remotes, commit changes, fetch into faac-owned bare caches, and exercise default-branch discovery, additions/removals, changed eligibility, compatible URL changes, schema and transitive-dependency quarantine, nonexecution of malicious expressions, pinned snapshots, locking, persisted reload, rollback, failed fetches, and corrupt-version recovery. They do not access provider credentials or claim live hosted-model access.
