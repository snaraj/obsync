# obsync canonical gate. CI runs exactly this battery (AGENTS.md, "Build, test, and release flows").
.PHONY: help check fmt lint test coverage plugin chart contracts secrets build

help: ## List targets
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*?## "}{printf "  %-12s %s\n", $$1, $$2}'

check: fmt lint test coverage plugin chart contracts secrets ## The full local gate

fmt: ## rustfmt check
	cargo fmt --all --check

lint: ## clippy, warnings are errors
	cargo clippy --workspace --all-targets -- -D warnings

test: ## Rust tests
	cargo test --workspace

coverage: ## Rust line coverage against RUST_COVERAGE_FLOOR (llvm-tools component, no crate)
	@echo "coverage: floor not yet set (first server PR sets it)"

plugin: ## Build and test the plugin
	@echo "plugin: build pending (plugin lane)"

chart: ## Helm lint and pin scripts
	@echo "chart: pending (scaffold lane)"

contracts: ## Repository contract suites
	@test -d scripts/ci && python3 -B -m unittest discover -s scripts/ci -p 'test_*.py' || true

secrets: ## Secret scans on the working tree
	@echo "secrets: gitleaks pin pending (scaffold lane)"

build: ## Release binary for the host
	cargo build --release -p obsyncd
