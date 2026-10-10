# Verification

Recorded on 2026-10-10 with Node.js 22.22.1, npm 9.2.0, Git, and Linux. Tests use isolated temporary directories and preserve the installation and reference OmniRoute checkout.

## Reproduce

```bash
npm run check
npm run build
python3 scripts/ad-hoc/pty-smoke.py
```

`npm run check` runs TypeScript validation and deterministic tests. The optional Python PTY smoke requires `pexpect`, already available in the implementation environment. No provider credentials are needed for these checks. The installed `faac --version` command returned `faac 0.1.0`; the package is linked at `~/.local/bin/faac`, with a `~/.bun/bin/faac` symlink on this user's existing PATH.

## Evidence boundaries

| Layer                                     | Verification                                                                                                                                                                                                                                                                                                                  |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Terminal component                        | Real Node process in a pseudoterminal at 88 and 36 columns, resized to 28: autocomplete, multiline paste, cursor editing, Markdown/code rendering, diffs, fallback notice, hidden secret input, default-deny confirmation, NO_COLOR/ASCII, clean exit                                                                         |
| Actual CLI                                | Built `dist/cli.js`: launch directory, `--cwd`, quoted `/cd`, `/status`, `/init` create and preserve, `/checkpoint`, `/diff`, `/undo`, permissions, parameters, persistent configuration, saved-session resume, one-shot JSON (including inside a real TTY), and redirected requests                                          |
| Real filesystem                           | `/init` created guidance and `/undo` removed only its owned file; an existing sentinel file remained unchanged; saved sessions retained completed action records, edits, checkpoints, and session parameters                                                                                                                  |
| Coding/fallback tests                     | Scripted provider responses invoke actual tools and a real shell test in temporary workspaces; scenarios include streamed failures, transferred context/results, and preserved completed edits. These are deterministic simulations of provider behavior                                                                      |
| Provider adapter tests                    | HTTP/SSE fixtures cover rate limits, HTTP 503, network interruption, incomplete tools, cancellation, free-only requests, and capability validation. They are not live API tests                                                                                                                                               |
| Synchronization tests                     | Real local Git repositories and commits exercise compatible updates, changed eligibility, removals, endpoint validation, quarantine, nonexecution of untrusted source, rollback, and recovery                                                                                                                                 |
| Public catalog discovery                  | On 2026-10-10 the OpenRouter public catalog returned 458 entries, with 14 passing faac's free-only/tool-capability filter. These are dated discovery observations, not authenticated inference or a promise of availability                                                                                                   |
| Public Git synchronization                | A fresh faac-owned cache fetched and validated `7510677f2f8f5317f1947284dab650d01333915d` on the advertised `release/v3.8.52` branch in about 4.9 seconds. All 89 monitored files matched the inspected local reference revision `9362ed1973124cc207e77f5cbcf3e617562a9d39`; the reference checkout was unchanged             |
| Live provider inference                   | **Passed with user-supplied OpenRouter credentials:** actual CLI coding, shell tests, independent assertions, process restart, and session continuation. Models: `apodex/apodex-1.1-mini:free` and `dots-studio/dots-3-note-preview:free`                                                                                     |
| Live inference with injected interruption | **Passed:** after a real streamed Apodex text chunk, the harness injected one model-scoped 429; Dots completed the response using preserved user requests, tool results, test output, and actual file hashes. The failure was injected, not a natural quota event; both successful model responses came from hosted inference |

The deterministic suites also cover durable crash recovery, uncertain shell outcomes, smaller-context compaction, concurrent edit/undo conflicts, all-models-unavailable state, shared quotas, credential encryption/redaction, and parameter reconciliation. The implementation deliberately does not claim exactly-once shell execution or lossless context preservation.

The initial application verification pass completed **104 deterministic tests**, including fenced exclusive circuit-recovery probes, credential fragments crossing stream boundaries, actionable tool-validation errors, exact-command approvals, and pausing after repeated permission denials. An installed-command run also fetched and validated public upstream into isolated state, reached the official public model catalog, then correctly retained a blocked coding session when no credentials were available. Its pre-existing sentinel file remained unchanged. The earlier `npm audit --omit=dev --audit-level=high` reported no known vulnerabilities at verification time.

## Authenticated results

The initial live smoke exposed a real usability failure: missing `expectedHash` arguments produced vague errors, and the model repeatedly prefixed the approved test command with `cd`. The session reached its local request cap without running the tests. That failed run is not counted as success. Tool errors now identify missing fields; model context includes exact approved commands and the working directory; three consecutive permission denials pause durably instead of exhausting quota.

After rebuilding, an actual CLI process resumed that same session **without a new prompt**, preserved the previously created implementation, executed the approved test successfully, and completed in three additional hosted responses. Independent sum assertions also passed.

A fresh two-process CLI test then completed with 18 hosted responses and two successful shell test runs. The first process created a CommonJS sum module and tests. The second process resumed the same session from the installation directory, added a product module, extended tests using current hashes, and retained the original implementation. Independent positive, negative, zero, and decimal assertions passed. Existing dirty tracked content, an untracked note, workspace guidance, and the Git commit remained unchanged.

Finally, the controlled interruption test resumed the completed original task and injected one failure after real streamed text. A different free model continued its final response. No new user prompt was required, no tool from the interrupted response executed, and completed files retained their hashes. This run did not execute a new tool after fallback; deterministic tests separately cover tools and edits across fallback.

Sanitized reports are retained in [dated evidence](verification/2026-10-10-live.json). Full temporary workspaces/transcripts are at `/tmp/faac-live-coding-iTthEq`, `/tmp/faac-live-resume-kP2ET6`, `/tmp/faac-live-e2e-JC2OQu`, and `/tmp/faac-live-fallback-EHunzh` until normal temporary-directory cleanup. The credential was used in process memory/environment and was not saved to the project or connected to the user's persistent faac configuration.

## Reproduce authenticated tests

These tests are separate from the deterministic suite:

```bash
# Supply OPENROUTER_API_KEY through your environment or secret manager first.
FAAC_LIVE_TEST=1 npm run test:live
FAAC_LIVE_TEST=1 npm run test:e2e:live
```

The first is the minimal coding smoke. The second runs the two-process coding/follow-up test with independent assertions and existing dirty Git state. Both use actual hosted inference in isolated temporary workspaces, permit workspace edits and exactly `node --test sum.test.cjs`, and perform the normal public upstream check. Workspaces and sessions are retained for inspection.

`test:resume:live` resumes the retained minimal-smoke objective without a replacement prompt; `test:fallback:live` requires a completed minimal-smoke session and injects a clearly labeled failure into actual hosted inference. Supply `FAAC_RESUME_HOME` and `FAAC_RESUME_SESSION` from that smoke report in addition to `FAAC_LIVE_TEST=1` and the credential. The fallback test has a hard bound of eight real requests; CLI tests cap each process at 12 steps. These tests consume the account's free allowance.

Alternatively, run `node scripts/ad-hoc/live-key-runner.mjs tests/live/e2e.ts` from the installation directory to enter the test key through hidden input without putting it in shell history. The helper passes it only to the test process and redacts child output.

Without the opt-in or `OPENROUTER_API_KEY`, tests report `NOT RUN` and exit with status 2; that behavior was verified. All authenticated tests are excluded from `npm test`.

For interactive verification:

1. Run `faac` in a disposable workspace. Use `/connect openrouter`, enter a valid key through the hidden prompt, and choose a vault passphrase. Optionally connect a confirmed Groq Free-plan account with paid billing and automatic overage disabled.
2. Run `/models refresh`, `/providers`, and `/doctor live`. Record which provider/model actually completed the inference probe and its date. Listing a free model or discovering a catalog does not prove authentication.
3. Ask faac to create a small program and its test. Approve the specific edit and test command, inspect the generated files, and verify the actual exit status.
4. Resume the saved session and continue the task. Real fallback requires an actual recoverable provider failure plus another eligible available model/account. Deterministic failure injection is separately covered by the automated suite; do not report it as a live quota event.

Groq and cross-provider authenticated fallback remain unverified because no Groq key from a confirmed Free-plan account was supplied. A naturally occurring quota-triggered fallback was not observed. Deterministic tests cover HTTP 503, network interruption, account/model scopes, and all-integrations-unavailable behavior. A live provider's current quota, availability, and upstream compatibility can change after these checks. Use `/status` and `/sync status` for the session's recorded evidence and adapter version.

## Earlier repository setup verification — 2026-10-10

The following records describe the earlier controller/push/manual-check configuration. They are retained as dated evidence, not instructions for the current repository. The owner subsequently removed the controller and selected PR-only quality jobs; see [current policy](../guides/GITFLOW.md).

After adopting the development scaffold and delivery tooling, the application suite passed **107 deterministic tests** and the Git publication suite passed **18 tests**. These are later local results; the earlier 104-test figure above belongs to the original application verification pass.

Local package verification built and installed a **51-file tarball**, exercised the installed CLI, and checked its distribution contents. Package output includes SHA-256 checksums and a CycloneDX inventory of locked production npm dependencies. The inventory does not cover operating-system packages.

A real Docker smoke test passed with a nonroot process, read-only container filesystem, disabled network, temporary `/tmp`, and explicit workspace/state mounts. It verified `/init`, an unchanged existing file, and saved-session continuation across separate container runs. Real PTY checks also passed. Workflow syntax/expressions were checked with `actionlint`, and the local secret scan passed with `gitleaks`.

The earlier AI controller, GitFlow policy, receipts, and authorization rules had deterministic tests. The then-current controller suite passed **33 tests**, including actual GitHub comparison response shapes, safe API-path handling, eligible workflow-event checks, head versus test-merge evidence, current-PR validation for work-branch pushes, and bare SemVer release naming. These tests do not establish Copilot model entitlement, a successful hosted task, or live native review.

The initial hosted diagnostic runs passed using manual workflow dispatch: [Quality and Package](https://github.com/consciontologic/faac/actions/runs/38038013850), [Container](https://github.com/consciontologic/faac/actions/runs/38038014958), and [Security](https://github.com/consciontologic/faac/actions/runs/38038016427). The first source commit was published to `main` and `develop`; both enforce PRs, current-branch checks, conversation resolution, and no force-push/deletion, including administrators.

A real [Copilot read-only audit](https://github.com/consciontologic/faac/tasks/3863aaa6-1308-49f4-81cf-5265160c94d2) completed successfully. GitHub reported the actual session model as `sweagent-capi:mai-code-1.1-flash`; no model fallback was used. This proves task access for this account on the recorded date, not permanent entitlement or free usage. GitHub creates a task branch even for a task that does not request a PR.

The [original `v0.1.0` release workflow](https://github.com/consciontologic/faac/actions/runs/38038079139) passed, published the npm tarball, CycloneDX inventory and checksums, and pushed the tested GHCR container with provenance. An independent anonymous pull succeeded with a fresh empty Docker configuration. Image digest: `sha256:b7ea0636769ed0473f00c75d6bc65ba3bf2a29fe48b4b7499921ee50c80f4a27`.

A real native Copilot review on [PR #1](https://github.com/consciontologic/faac/pull/1#pullrequestreview-5478322186) was **blocked by the account's review quota**. A `COMMENTED` status containing that failure is not completed review evidence. The controller change tested in PR #1 required a positive reviewed-files summary and stops without submitting another paid review or repair when the current-head review was not performed. That version was still on the open PR at this observation; the controller has since been removed from the requested policy. Built-in review was configured as Balanced by the account; choosing Lite remains an account setting.

Automatic push/PR workflow starts were not observed during this setup despite active workflows and correct event filters. Manual dispatch succeeded as a diagnostic only. At that stage, PR-event activation and eligible required-check completion remained unverified; required checks are not bypassed. The earlier controller would have required durable Actions credentials; that dependency is superseded by the controller removal. The temporary setup token was not saved as a repository secret. The remaining checks stay explicit in the [roadmap](../planning/ROADMAP.md).

Five diagnostic jobs passed on PR #1 commit `b562dac16616c95cb87b9d3b241e37f0a0d01639`: [Quality/Package](https://github.com/consciontologic/faac/actions/runs/38038434611), [Container](https://github.com/consciontologic/faac/actions/runs/38038436746), [Security](https://github.com/consciontologic/faac/actions/runs/38038438710), and [GitFlow](https://github.com/consciontologic/faac/actions/runs/38038440114). These were manually dispatched on the actual PR head. GitHub does not evaluate `workflow_dispatch` job checks as required PR checks, even for the exact head commit. [Official required-check rules](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks#checks-from-some-workflow-jobs-are-not-evaluated). **PR #1 was blocked pending eligible checks at this observation.** An independent coordinating AI review found no blockers; this is separate from the quota-blocked native review. The public artifact reproduction report is retained in [release evidence](verification/2026-10-10-release.json).

The original release evidence above predates the naming-policy change to bare semantic versions. Its archived JSON, original filenames, and recorded hashes remain historical evidence. The live release was subsequently renamed to [0.1.0](https://github.com/consciontologic/faac/releases/tag/0.1.0), with Git tag `0.1.0`, package `0.1.0.tgz`, inventory `0.1.0.cdx.json`, and an updated checksum manifest. The old `v0.1.0` tag was removed. Anonymous downloads verified unchanged application/inventory bytes; a fresh install from the renamed URL passed version and workspace-preservation checks without provider requests. See [naming migration evidence](verification/2026-10-10-naming.json).

The post-naming suite passed **109 application/packaging tests**, **18 Git publication tests**, and **33 DevOps tests**. The local rebuilt package installed successfully and workflow validation passed. The existing container remains `ghcr.io/consciontologic/faac:0.1.0`; earlier `latest` and `sha-...` convenience aliases remain in the registry, while the revised publisher creates only a SemVer image version tag. Registry provenance references are separate metadata.

At the earlier setup checkpoint, **Release** and **AI delivery** were disabled while trusted `main` still contained the old naming/review behavior. This is a historical state, not an instruction to restore the removed delivery workflow. Manual diagnostic results were not substituted for required PR checks.

## Current requested CI policy — 2026-10-10

The active policy removes the delivery workflow/controller and its label-triggered actions. Quality, package, container, and security jobs belong only to any PR into develop or a hotfix PR into main. A lightweight PR-only GitFlow gate validates ordinary develop-to-main promotion against exact-tree prior eligible PR evidence. No push, merge, schedule, or manual CI duplicate is intended.

Release remains an explicit version dispatch on main. It reuses prior PR results, builds artifacts, and validates archive contents, identity, checksums, and provenance. It does not rerun tests, package/container smokes, PTY checks, or scanners. Local one-shot MAI-Code-1.1-Flash delegation remains available.

Local verification of the revised policy passed **110 Node tests**, **18 Git publication tests**, and **19 DevOps tests** (147 total), typechecking, 38-document validation, actionlint, a production dependency audit with zero vulnerabilities, and a redacted Git-history secret scan. Actual package installation, PTY interaction, and container workspace/resume smoke tests passed without provider calls. Independent AI review found no blocking issues. Trigger tests evaluate the actual workflow conditions; evidence tests cover changed trees, missing or spoofed checks, cleared PR associations, later failures, partial reruns, and immutable publication.

These local results do not establish new hosted PR execution or a new release. Hosted acceptance remains in the [roadmap](../planning/ROADMAP.md). Earlier live inference, package, release, and naming-migration evidence and archived JSON remain unchanged.
