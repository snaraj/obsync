# obsync canonical gate. CI runs exactly this battery (AGENTS.md, "Build, test,
# and release flows"), and scripts/ci/makefile-invariants.sh proves it: every
# canonical command below must also appear in .github/workflows/pr-gate.yml, so
# "it passed locally" and "it passed in CI" cannot come to mean different
# things.
.PHONY: help check fmt lint test coverage plugin dashboard chart contracts secrets build image image-isolated release-check

# Requirement 9's ratchet-only floor, set at the first measured value on the
# composed bootstrap wave (89.80 %, 2026-09-07). The same number lives in
# AGENTS.md and in pr-gate.yml's workflow env; the three move together, and
# scripts/ci/test_coverage_floor.py fails the gate if they disagree.
RUST_COVERAGE_FLOOR ?= 89
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
	# The GLOB, not the directory: on the pinned Node 24.19.0 a directory
	# argument is run as a module rather than searched, so `node --test
	# dashboard/test/` fails with MODULE_NOT_FOUND. Verified in the pinned
	# node:24.19.0-trixie-slim image, 2026-09-07.
	node --test dashboard/test/*.test.mjs

chart: ## Helm lint, render, and the rendered pins
	helm lint chart
	helm template smoke chart --kube-version v1.36.0 >/dev/null
	python3 -B scripts/ci/chart_pins.py all

contracts: ## Repository contract suites
	python3 -B -m unittest discover -s scripts/ci -p 'test_*.py'

# BOTH scans decide this target. The working-tree scan used to end in `;`, so a
# `leaks found` verdict on it was discarded and `make secrets` -- and therefore
# `make check` -- exited on the RANGE scan alone. That is a secret scan that
# cannot fail on anything already written to disk, which is the half a leak
# arrives through first. `&&` is the whole fix and `.gitleaks.toml` is the other
# half: the git-ignored mirrors it now allowlists are what made the dir scan
# noisy enough to be worth silencing in the first place. `--verbose` is the
# third: without it gitleaks prints `leaks found: 1` and stops, so the failure
# named a count and not a file (requirement 12). The secret itself stays
# redacted.
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
	gitleaks dir --no-banner --redact --verbose . && \
	if git rev-parse --verify --quiet "$(BASE)" >/dev/null; then \
	  gitleaks git --no-banner --redact --max-target-megabytes=2 --verbose --log-opts="$(BASE)..HEAD" .; \
	else \
	  printf 'no %s to measure against; scanning the complete history instead\n' "$(BASE)" >&2; \
	  gitleaks git --no-banner --redact --max-target-megabytes=2 --verbose .; \
	fi

build: ## Release binary for the host
	cargo build --release --locked -p obsyncd

# The gate's `container` job, reproducible before the push: the same two native
# builds in the same order, so the cached server stage serves the full image
# exactly as it does in CI, then the same smoke against the image that build
# just produced. Not a prerequisite of `check`, which must stay runnable with
# no container runtime at all -- run this one when the Dockerfile, the plugin
# build, or the dashboard changes.
#
# The smoke is where "the image builds" becomes "the image serves": it runs the
# built bytes with two FRESH named volumes, which is the README's own quick
# start and the one shape that catches a mount point the runtime uid cannot
# write. Both builds can be green while that path cannot complete once.
#
# The SECOND smoke runs the other install path README.md offers -- `deploy/
# compose` with its own TLS terminator, for a deployer with no provider and no
# Kubernetes. It needs ports 80 and 443 on this host and pulls Caddy by digest
# from Docker Hub; it refuses with a named reason rather than a puzzle if
# either is unavailable.
#
# On a host whose Docker declares a `credsStore`, run `make image-isolated`:
# an empty configuration directory is what keeps a credential helper out of
# anonymous, digest-pinned base-image pulls, and is what the gate points
# DOCKER_CONFIG at.
image: ## Build the release stages locally, exactly as the gate's container job does
	docker build --target server --tag obsync-server:$$(cat VERSION) .
	docker build --tag obsync:$$(cat VERSION) .
	./scripts/ci/image-smoke.sh obsync:$$(cat VERSION)
	./scripts/ci/compose-smoke.sh obsync:$$(cat VERSION)

# Emptying DOCKER_CONFIG also drops the CONTEXT it selects, and on Docker
# Desktop the context is the only thing that names the daemon socket: an
# emptied configuration falls back to /var/run/docker.sock, which that
# installation does not create, so the isolated build fails on a machine whose
# daemon is healthy. Resolve the endpoint FIRST, under the caller's real
# configuration, and carry it in explicitly. An endpoint the caller already
# chose wins.
image-isolated: ## make image with an empty Docker config, keeping this daemon
	DOCKER_HOST="$${DOCKER_HOST:-$$(docker context inspect -f '{{.Endpoints.docker.Host}}')}" \
	DOCKER_CONFIG="$$(mktemp -d)" $(MAKE) image

release-check: ## Classify the outgoing range and walk the seven locks
	python3 -B scripts/ci/release_contract.py transition --repository . \
	  --base "$$(git rev-parse $(BASE))" --head "$$(git rev-parse HEAD)"
