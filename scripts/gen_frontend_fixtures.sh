#!/usr/bin/env bash
# P1.2(iii): regenerate the frontend account fixtures from the real program
# build. The bytes are produced by `vault/program/tests/frontend_fixtures.rs`
# using the program's own `AccountSerialize` impl (never hand-written).
#
# CI runs this and fails if the committed fixture (`app/test/fixtures/accounts.json`)
# changes, so the frontend decoding tests can never drift from the program layout.
set -euo pipefail
exec cargo test -p arbswap --test frontend_fixtures -- --nocapture
