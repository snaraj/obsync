# obsync canonical gate. CI runs exactly this battery (AGENTS.md, "Build, test,
# and release flows"), and scripts/ci/makefile-invariants.sh proves it: every
# canonical command below must also appear in .github/workflows/pr-gate.yml, so
# "it passed locally" and "it passed in CI" cannot come to mean different
# things.
.PHONY: help check fmt lint test coverage plugin dashboard chart contracts secrets build image release-check

# Requirement 9's ratchet-only floor. It is 0 until the first server PR
# measures it; the same number lives in pr-gate.yml's workflow env, and the two
# move together.
RUST_COVERAGE_FLOOR ?= 0
# The base an outgoing range is measured against. Overridable so a lane working
# from a declared predecessor branch can scan and classify its own range.
BASE ?= origin/main

help: ## List targets
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*?## "}{printf "  %-14s %s\n", $$1, $$2}'

check: fmt lint test coverage plugin dashboard chart contracts secrets ## The full local gate

fmt: ## rustfmt check
	cargo fmt --all --check

lint: ## clippy, warnings are errors
	cargo clippy --workspace --all-targets -- -D warnings

test: ## Rust tests
	cargo test --workspace

coverage: ## Rust line coverage against RUST_COVERAGE_FLOOR (llvm-tools component, no crate)
	RUST_COVERAGE_FLOOR=$(RUST_COVERAGE_FLOOR) ./scripts/ci/coverage.sh

plugin: ## Build and test the plugin
	cd plugin && npm ci --ignore-scripts --no-audit --no-fund && npm run build && npm test

dashboard: ## Test the dashboard's pure functions
	node --test dashboard/test/

chart: ## Helm lint, render, and the rendered pins
	helm lint chart
	helm template smoke chart --kube-version v1.36.0 >/dev/null
	python3 -B scripts/ci/chart_pins.py all

contracts: ## Repository contract suites
	python3 -B -m unittest discover -s scripts/ci -p 'test_*.py'

secrets: ## Pinned gitleaks over the working tree and the outgoing range
	@version="$$(awk -F= '/^GITLEAKS_VERSION=/{print substr($$2, 2)}' scripts/ci/install-tools.sh)"; \
	command -v gitleaks >/dev/null || { \
	  printf 'gitleaks is not installed. CI installs the pinned %s with a verified checksum via scripts/ci/install-tools.sh.\n' "$$version" >&2; \
	  exit 1; \
	}; \
	installed="$$(gitleaks version)"; \
	test "$$installed" = "$$version" || { \
	  printf 'gitleaks %s is installed but this repository pins %s (scripts/ci/install-tools.sh).\n' "$$installed" "$$version" >&2; \
	  exit 1; \
	}; \
	gitleaks dir --no-banner --redact .; \
	if git rev-parse --verify --quiet "$(BASE)" >/dev/null; then \
	  gitleaks git --no-banner --redact --max-target-megabytes=2 --log-opts="$(BASE)..HEAD" .; \
	else \
	  printf 'no %s to measure against; scanning the complete history instead\n' "$(BASE)" >&2; \
	  gitleaks git --no-banner --redact --max-target-megabytes=2 .; \
	fi

build: ## Release binary for the host
	cargo build --release --locked -p obsyncd

image: ## Build the shipped image locally for this host architecture
	docker build --tag obsync:$$(cat VERSION) .

release-check: ## Classify the outgoing range and walk the seven locks
	python3 -B scripts/ci/release_contract.py transition --repository . \
	  --base "$$(git rev-parse $(BASE))" --head "$$(git rev-parse HEAD)"
