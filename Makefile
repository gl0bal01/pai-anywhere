SHELL := /usr/bin/env bash

.PHONY: help deps typecheck test test-integration lint shell-tests-local check doctor verify test-install-container

help:
	@printf 'pai-anywhere development targets\n\n'
	@printf '  make deps                  Install Bun dependencies from lockfile\n'
	@printf '  make typecheck             Run TypeScript typecheck\n'
	@printf '  make test                  Run Bun test suite\n'
	@printf '  make lint                  Run shellcheck on shell entrypoints\n'
	@printf '  make shell-tests-local     Run non-root shell safety tests\n'
	@printf '  make check                 Run deps, typecheck, test, lint, shell-tests-local\n'
	@printf '  make test-install-container IMAGE=ubuntu:24.04\n'
	@printf '                             Run explicit container install smoke\n'
	@printf '  make doctor                Run local doctor\n'
	@printf '  make verify                Run post-install verifier\n'

deps:
	bun install --frozen-lockfile

typecheck:
	bun run typecheck

test:
	bun test

test-integration:
	bun run test:integration

lint:
	shellcheck -S warning install.sh uninstall.sh scripts/*.sh tests/*.sh extras/backup/pai-backup

shell-tests-local:
	bash tests/log-format.sh
	bash tests/pairing-code-leak.sh
	bash tests/reset-access-non-root.sh
	bash tests/sha256-mismatch.sh

check: deps typecheck test lint shell-tests-local

doctor:
	bun run doctor

verify:
	bun run verify

test-install-container:
	bash tests/container-install.sh $(IMAGE)
