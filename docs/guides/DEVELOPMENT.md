# Develop faac

## Install and run locally

Use Node.js 22+, npm, Git, Bash, Python 3, and Make. The optional terminal test also needs Python `pexpect`. Docker is needed only for container checks.

```bash
git clone https://github.com/consciontologic/faac.git
cd faac
npm ci
make build
npm run dev -- --cwd /path/to/disposable/project --no-sync
```

`npm run dev` runs TypeScript directly. `npm run build` compiles the installed CLI to `dist/`. Keep application state outside the repository. Use a temporary `FAAC_HOME` for tests and never commit actual credentials.

## Check your change

```bash
make help
make check
make build
make test.terminal
make package.test
make image
make image.test
```

`make check` covers application types/tests and repository operations/documentation checks. Terminal tests launch actual pseudoterminals. Package tests install and exercise the tarball. Release asset filenames use only the version: `0.1.0.tgz` and `0.1.0.cdx.json`; Git tags and release names also use `0.1.0`. Container checks build and inspect the image. Missing optional test dependencies are a failed prerequisite, not evidence that the check passed.

For a small application change, begin with its focused test:

```bash
npx tsx --test tests/tools.test.ts
npx tsx --test tests/engine.test.ts
npx tsx --test tests/sync.test.ts
```

Then run the full gate. `npm test` never consumes provider credentials. Real hosted tests require an explicit opt-in and are described in [verification](../reports/VERIFICATION.md).

## Make a contribution

Read [AGENTS.md](../../AGENTS.md), [the architecture](../code/ARCHITECTURE.md), and [the roadmap](../planning/ROADMAP.md). Preserve existing changes and follow the nearest instructions. Put tests in `tests/`, temporary helpers in `scripts/ad-hoc/`, and operations tooling under `xops/`.

Use the guarded GitFlow and PR workflow in [DevOps](DEVOPS.md). Keep changes small enough to review. A behavior change needs a meaningful regression or feature test. Review the complete diff for secrets, copied credentials, unexpected generated files, and unsupported provider assumptions before publication.

## Adding a provider or parameter

Separate curated evidence, live discovery, authentication, execution, capabilities, failure scope, and shared quotas. An official API and documented recurring-free behavior are necessary but not sufficient: test its request/response contract, invalid input, streaming failures, cancellation, and tool handling. Unknown overage must stay ineligible.

Parameter definitions belong in the reviewed registry, with validation and capability reconciliation. Do not pass arbitrary advanced JSON through to a provider. A newly advertised parameter remains unsupported until reviewed. Update relevant documentation and the [design decision](../design/ADR-0001-standalone-free-routing.md) if the boundary changes.
