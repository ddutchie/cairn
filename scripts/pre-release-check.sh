#!/bin/bash
#
# Cairn — pre-release gate
#
# Runs every check that must pass before tagging a release. Fails fast and
# exits non-zero on the first error, so a release can never proceed with a
# broken build.
#
# Usage:
#   ./scripts/pre-release-check.sh             # full gate (incl. e2e)
#   ./scripts/pre-release-check.sh --skip-e2e  # skip Playwright (slow CI runners)
#
# Used by scripts/release.sh before `npm version` is invoked. Can also be
# run manually before pushing a release tag.
#
# Exit codes:
#   0  all checks passed
#   1  one or more checks failed (see output above)
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

SKIP_E2E=0
for arg in "$@"; do
  case "$arg" in
    --skip-e2e) SKIP_E2E=1 ;;
    -h|--help)
      sed -n '2,16p' "$0"
      exit 0
      ;;
    *)
      echo "Unknown flag: $arg" >&2
      exit 1
      ;;
  esac
done

step() {
  echo ""
  echo "▶ $1"
}

fail() {
  echo ""
  echo "✗ pre-release check FAILED: $1" >&2
  exit 1
}

# 0. Sanity: working tree clean (release.sh also checks this, but we want to
#    fail before running the test suite against a stale tree)
if ! git diff-index --quiet HEAD --; then
  fail "working tree has uncommitted changes — commit or stash first"
fi

step "Rebuild Electron bundles (esbuild)"
# `npm test` already runs compile, but compile is cheap and we want a fresh
# bundle for the bundle-guard test even if a developer ran `npm run test:fast`
# mid-flight. Also produces dist-electron/main.js + embeddings-server.bundle.js
# for smoke-test.
npm run compile

step "Type check (renderer + electron)"
npm run type-check:all

step "Lint"
npm run lint

step "Unit tests (compile + vitest run)"
# Skip the opt-in live LLM experiment tests (prompt/tool-schema/tool-error) — they
# make real network calls to an LLM endpoint and must not gate a release. They
# still run in a normal local `vitest run` / `npm run test:fast`.
CAIRN_SKIP_LIVE_TESTS=1 npm test

step "Bundle self-containment guard"
# Already exercised by `npm test`, but re-run explicitly so a failure here
# surfaces with a clear label in CI logs — bundle bugs are release-blockers
# (v2.1.4 shipped with umap-js un-shipped because this guard was silently
# skipping when bundles were absent).
npx vitest run electron/bundle-guard.test.ts electron/native-deps-guard.test.ts

if [ "$SKIP_E2E" -eq 1 ]; then
  echo ""
  echo "⚠ --skip-e2e given; skipping Playwright E2E suite."
  echo "  Only use this flag on a branch with NO UI changes."
else
  step "E2E (Playwright)"
  npm run test:e2e
fi

echo ""
echo "✓ All pre-release checks passed."
