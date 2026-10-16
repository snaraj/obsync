#!/usr/bin/env bash
# Offline harness regressions and broken controls; never native acceptance.
set -euo pipefail
export OBSYNC_ORACLE_SOURCE="${OBSYNC_ORACLE_SOURCE:-$PWD}"
python3 -B -m unittest discover -s scripts/validation -p 'test_*.py'
node --test scripts/validation/android-journey.test.mjs scripts/validation/mobile/*.test.mjs
node scripts/validation/mobile/desktop-guard-mutations.mjs
node scripts/validation/mobile/ciphertext-oracle-mutations.mjs
node scripts/validation/mobile/native-confidentiality-scan-mutations.mjs
python3 -B scripts/validation/recovery_refusal_mutations.py
python3 -B scripts/validation/selected-retention-mutations.py --node "$(command -v node)"
python3 -B scripts/validation/android-home-mutations.py
python3 -B scripts/validation/android-trust-apk-mutations.py
python3 -B scripts/validation/android-note-read-mutations.py --node "$(command -v node)"
python3 -B scripts/validation/android-folder-observation-mutations.py --node "$(command -v node)"
python3 -B scripts/validation/android-scope-save-mutations.py --node "$(command -v node)"
python3 -B scripts/validation/mobile/native-checkpoint-mutations.py --node "$(command -v node)" --source "$OBSYNC_ORACLE_SOURCE"
python3 -B scripts/validation/mobile/native-ciphertext-capture-mutations.py --node "$(command -v node)" --source "$OBSYNC_ORACLE_SOURCE"
python3 -B scripts/validation/android-cdp-lifecycle-mutations.py --node "$(command -v node)"
python3 -B scripts/validation/mobile/rotation-consent-mutations.py --node "$(command -v node)" --source "$OBSYNC_ORACLE_SOURCE"
