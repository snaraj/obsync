#!/usr/bin/env bash
# Offline harness regressions and broken controls; never native acceptance.
set -euo pipefail
export OBSYNC_ORACLE_SOURCE="${OBSYNC_ORACLE_SOURCE:-$PWD}"
python3 -B -m unittest discover -s scripts/validation -p 'test_*.py'
node --test scripts/validation/android-journey.test.mjs scripts/validation/mobile/*.test.mjs
node scripts/validation/mobile/desktop-guard-mutations.mjs
node scripts/validation/mobile/ciphertext-oracle-mutations.mjs
node scripts/validation/mobile/native-confidentiality-scan-mutations.mjs
