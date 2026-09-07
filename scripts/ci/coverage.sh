#!/bin/sh
# Rust line coverage for the workspace (AGENTS.md requirement 9).
#
# Uses the pinned `llvm-tools` component from rust-toolchain.toml and no
# crate: `cargo-llvm-cov` would be a dependency, and this repository has
# none. Prints RUST_LINE_COVERAGE=<n> and, when RUST_COVERAGE_FLOOR is set,
# exits non-zero below it. The floor only ever rises.
#
# Usage: scripts/ci/coverage.sh [RUST_COVERAGE_FLOOR=<percent>]
set -eu

root="$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)"
cd "$root"

host="$(rustc -vV | sed -n 's/^host: //p')"
sysroot="$(rustc --print sysroot)"
tools="${sysroot}/lib/rustlib/${host}/bin"
profdata="${tools}/llvm-profdata"
cov="${tools}/llvm-cov"

for tool in "$profdata" "$cov"; do
  if [ ! -x "$tool" ]; then
    printf 'coverage: %s is missing; install the llvm-tools component\n' "$tool" >&2
    exit 2
  fi
done

out="${root}/target/coverage"
rm -rf "$out"
mkdir -p "$out"

# Instrumented build and run. One profraw per process, merged below.
export RUSTFLAGS="-C instrument-coverage"
export LLVM_PROFILE_FILE="${out}/obsync-%p-%m.profraw"
cargo test --workspace --quiet >/dev/null

# The test binaries carry the coverage mapping; ask cargo which they are.
binaries="$(cargo test --workspace --no-run --message-format=json 2>/dev/null \
  | sed -n 's/.*"executable":"\([^"]*\)".*/\1/p' \
  | grep -v '^null$' \
  | sort -u)"
if [ -z "$binaries" ]; then
  printf 'coverage: no test binaries were produced\n' >&2
  exit 2
fi

objects=""
for binary in $binaries; do
  objects="${objects} -object ${binary}"
done

"$profdata" merge -sparse "${out}"/*.profraw -o "${out}/merged.profdata"

# Test code is excluded: measuring the tests would measure nothing.
ignore='(/\.cargo/registry/|/rustc/|/tests\.rs$|/testutil\.rs$|_test\.rs$)'

# shellcheck disable=SC2086
summary="$("$cov" export \
  --instr-profile "${out}/merged.profdata" \
  --ignore-filename-regex "$ignore" \
  --summary-only \
  $objects)"

percent="$(printf '%s' "$summary" | python3 -c '
import json, sys
totals = json.load(sys.stdin)["data"][0]["totals"]
print("%.2f" % totals["lines"]["percent"])
')"

# shellcheck disable=SC2086
"$cov" report \
  --instr-profile "${out}/merged.profdata" \
  --ignore-filename-regex "$ignore" \
  $objects

printf 'RUST_LINE_COVERAGE=%s\n' "$percent"

if [ -n "${RUST_COVERAGE_FLOOR:-}" ]; then
  if [ "$(printf '%s\n%s\n' "$percent" "$RUST_COVERAGE_FLOOR" | sort -g | head -1)" != "$RUST_COVERAGE_FLOOR" ] \
     && [ "$percent" != "$RUST_COVERAGE_FLOOR" ]; then
    printf 'coverage: %s%% is below the floor of %s%%\n' "$percent" "$RUST_COVERAGE_FLOOR" >&2
    exit 1
  fi
  printf 'coverage: %s%% meets the floor of %s%%\n' "$percent" "$RUST_COVERAGE_FLOOR"
fi
