# ADR 0001: Standalone execution with strict free-only routing

- Status: accepted
- Date: 2026-10-10
- Owner: Serhat Akbak
- Supersedes: none

## Context

The terminal agent must run independently of OmniRoute while reusing relevant public metadata and surviving provider/model limits. Free catalog labels alone do not establish executable endpoints, tool support, current pricing, or an account's billing plan.

## Decision

Keep a small Node/TypeScript runtime with explicit official provider adapters, canonical durable sessions, reviewed capability contracts, and a separate validated Git synchronization layer.

## Consequences

- Installation requires no proxy server or local model.
- Free eligibility and account limits remain explicit routing gates.
- TypeScript AST parsing allows metadata extraction without executing upstream code.
- A narrow adapter set is maintainable, but adding providers requires contract review and tests.
- Unknown endpoint/schema changes quarantine integrations until a reviewed faac update.
- Smaller-context fallback preserves critical state but cannot promise lossless model context.

## Alternatives

Copying the entire OmniRoute application adds a web server and unrelated dependencies. Requiring a running proxy fails standalone use. Blindly executing updated upstream modules breaks the trust boundary. Treating all free-labeled models as interchangeable ignores tool, context, account, and billing differences.
