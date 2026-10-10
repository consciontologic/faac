# faac development, GitFlow, releases and explicit AI task helpers. Implementations live in xops/.
PYTHON ?= python3
.DEFAULT_GOAL := help
AGENT ?= codex
KIND ?= feature
NAME ?=
APPLY ?= 0
PROMPT_FILE ?=
RECEIPT ?=
RELEASE_VERSION ?=
HEAD_REF ?=
ACTION ?= note
STATUS ?= completed
SCOPE ?= general
SUMMARY ?=
REFS ?=
RUN_ID ?=
export AGENT KIND NAME APPLY PROMPT_FILE RECEIPT RELEASE_VERSION HEAD_REF ACTION STATUS SCOPE SUMMARY REFS RUN_ID

.PHONY: help verify check test test.ops docs.check build test.terminal package package.test image image.test git git.dry gitflow ai.plan ai.submit track.add track.list roadmap.status

## help              Show development and repository commands
help:
	@awk '/^## / { sub(/^## /,"  make "); print }' $(MAKEFILE_LIST)

## verify            Run application, operations, and documentation checks
verify: check

## check             Typecheck and test the app; validate GitFlow and docs
check:
	@npm run check
	@$(MAKE) test.ops docs.check

## test              Run deterministic application tests (no API key)
test:
	@npm test

## test.ops          Run Git publication, release evidence and AI task tests
test.ops:
	@$(PYTHON) -m unittest discover -s xops/makefile -p 'test_*.py'
	@$(PYTHON) -m unittest discover -s tests/devops -p 'test_*.py'

## docs.check        Check documentation links and filled scaffold documents
docs.check:
	@$(PYTHON) xops/agent/check_docs.py

## build             Compile the CLI
build:
	@npm run build

## test.terminal     Exercise the terminal and CLI in a real PTY
test.terminal:
	@npm run test:terminal

## package           Build the npm tarball, checksums and dependency inventory
package:
	@npm run package

## package.test      Build and install-test the npm tarball
package.test: package
	@npm run test:package

## image             Build faac:local
image:
	@docker build -t faac:local .

## image.test        Test workspace and durable-state mounts in the local image
image.test:
	@node xops/package/container-smoke.mjs faac:local

## git               Commit tracked work and push only its allowed work branch
git:
	@$(PYTHON) xops/makefile/git_ops.py push

## git.dry           Inspect pending tracked publication without changing Git
git.dry:
	@$(PYTHON) xops/makefile/git_ops.py dry

## gitflow           Plan a worktree: KIND=feature NAME=slug; add APPLY=1 to create
gitflow:
	@$(PYTHON) xops/agent/local_commands.py gitflow

## ai.plan           Preview an explicit-model task: KIND=feature PROMPT_FILE=file
ai.plan:
	@$(PYTHON) xops/agent/local_commands.py ai-plan

## ai.submit         Submit once with FAAC_COPILOT_TOKEN and a new RECEIPT path
ai.submit:
	@$(PYTHON) xops/agent/local_commands.py ai-submit

## track.add         Append a tracking row using ACTION STATUS SCOPE SUMMARY
track.add:
	@$(PYTHON) xops/agent/local_commands.py track

## track.list        Show recent tracking rows
track.list:
	@$(PYTHON) xops/makefile/track_ops.py list

## roadmap.status    Show roadmap checklist progress
roadmap.status:
	@$(PYTHON) xops/makefile/roadmap_ops.py status
