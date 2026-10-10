# Source reuse and integration boundaries

faac adapts free-model catalog data and architecture concepts from [OmniRoute](https://github.com/diegosouzapw/OmniRoute), Copyright (c) 2026 diegosouzapw, distributed under the MIT license. The original notice is preserved in [THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md). The bundled baseline records its exact source commit, file hashes, semantic dependency fingerprints, curation date, and extracted rows.

The implementation explicitly inspected `open-sse/config/freeModelCatalog.data.ts`, `src/lib/catalog/openrouterCatalog.ts`, and `src/shared/utils/freeModels.ts`. Further references included `freeModelCatalog.ts`, `payloadFreeEvidence.ts`, `providerRegistry.ts`, the Groq/OpenRouter registries, registry capability types, base executor/header/authentication code, `providerFieldStrips.ts`, `src/sse/services/auth.ts`, `accountFallback.ts`, `openrouterFreeWindow.ts`, and `autoCombo/strictZeroCostFilter.ts`.

The curated catalog is static metadata. Live `/models` discovery, API-key authentication, official HTTPS request execution, runtime availability, and shared quota tracking are separate parts of faac. The maintained runtime is a small standalone implementation, not a copy of OmniRoute's Next.js application. No local models or running OmniRoute service are required.

The initial integrations are official OpenRouter and Groq APIs. No website scraping, browser session token extraction, or unofficial website chat integrations are implemented. Unsupported providers can appear in the attributed catalog as research metadata; they are never automatically executable routing destinations. One-time credits, trials, unknown pricing, and uncertain overage billing are not equivalent to recurring free access.

OmniRoute's optional Radar client was inspected through `docs/frameworks/RADAR.md`. Its private hosted research and backend implementation is not distributed in that checkout, was not extracted, and is not part of faac. Git synchronization monitors the public repository only and does not reproduce Radar's hosted research service.

## Development scaffold and delivery tooling

The repository development scaffold is adapted from [agentic-workspace](https://github.com/consciontologic/agentic-workspace), Copyright (c) 2026 Serhat Akbak, MIT licensed. Reused material includes shared agent rules, skills, prompts, role adapters, tracking, recovery scripts, and operations helpers. Project documentation templates were filled for faac and removed. Generated examples are not treated as proof that optional integrations are installed.

Git publication and AI delivery practices are adapted from [wfform](https://github.com/consciontologic/wfform), Copyright (c) 2026 Serhat Akbak, MIT licensed, then specialized for faac's Node CLI, protected branches, inexpensive explicit Copilot model, and release artifacts. The reference checkouts are not runtime dependencies. Full notices are retained in [third-party notices](../../THIRD_PARTY_NOTICES.md).
