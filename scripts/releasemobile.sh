#!/bin/bash
set -euo pipefail

# Cairn — release the mobile (Expo/iOS) app to TestFlight.
#
# Usage: ./scripts/releasemobile.sh [patch|minor|major]
#        ./scripts/releasemobile.sh 2.4.0            # explicit version also works
#
# Mirrors scripts/release.sh (desktop): bumps the version, then pushes the tag
# that triggers CI. Here the tag is `mobile-v<version>` and CI runs EAS Build
# (iOS, production) + EAS Submit to TestFlight (.github/workflows/release-mobile.yml).
#
# The marketing version lives in mobile/app.json. The iOS BUILD NUMBER is
# auto-incremented by EAS (appVersionSource: remote in eas.json), so you only
# bump the marketing version here.
#
# For JS-only changes prefer an OTA update (scripts/publishupdate.sh) — it needs
# no new build. Use this script for native changes or a new store version.

ARG="${1:-}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_JSON="$REPO_ROOT/mobile/app.json"

if [ -z "$ARG" ]; then
    echo "Usage: ./scripts/releasemobile.sh [patch|minor|major]"
    echo "   or: ./scripts/releasemobile.sh <version>   e.g. 2.4.0"
    exit 1
fi

# Clean tree so we don't tag half-finished work.
if [ -n "$(git -C "$REPO_ROOT" status --porcelain)" ]; then
    echo "Error: working tree is not clean. Commit or stash changes first."
    exit 1
fi

CURRENT_VERSION="$(node -p "require('$APP_JSON').expo.version")"

# Resolve the target version: a bump keyword computes from the current version,
# otherwise treat the arg as an explicit semver.
case "$ARG" in
    patch|minor|major)
        VERSION="$(node -e "
          const [maj, min, pat] = '$CURRENT_VERSION'.split('.').map(Number);
          if ('$ARG' === 'major') process.stdout.write((maj+1)+'.0.0');
          else if ('$ARG' === 'minor') process.stdout.write(maj+'.'+(min+1)+'.0');
          else process.stdout.write(maj+'.'+min+'.'+(pat+1));
        ")"
        ;;
    *)
        if ! echo "$ARG" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'; then
            echo "Error: '$ARG' is not 'patch|minor|major' or a valid semver version (e.g. 2.4.0)."
            exit 1
        fi
        VERSION="$ARG"
        ;;
esac

TAG="mobile-v$VERSION"

# Tag must not already exist.
if git -C "$REPO_ROOT" tag -l "$TAG" | grep -q "$TAG"; then
    echo "Error: tag $TAG already exists."
    exit 1
fi

# Pre-flight gate: type-check + lint from mobile/ (the mirror of desktop's
# pre-release-check.sh). Cheap, and stops us from pushing a tag that would only
# fail once EAS starts the cloud build. Ensures @cairn/shared is linked first.
echo "▶ Pre-flight checks (mobile type-check + lint)…"
(
    cd "$REPO_ROOT/mobile"
    node scripts/link-shared.js >/dev/null 2>&1 || true
    echo "  · type-check"
    npx tsc --noEmit
    echo "  · lint"
    npm run lint
) || { echo "✗ Pre-flight checks failed — fix the above before releasing."; exit 1; }
echo "✓ Pre-flight checks passed."

echo "Bumping mobile version: $CURRENT_VERSION → $VERSION"
tmp="$(mktemp)"
jq --arg v "$VERSION" '.expo.version = $v' "$APP_JSON" > "$tmp"
mv "$tmp" "$APP_JSON"

if [ -n "$(git -C "$REPO_ROOT" status --porcelain mobile/app.json)" ]; then
    git -C "$REPO_ROOT" add mobile/app.json
    git -C "$REPO_ROOT" commit -m "chore(mobile): bump version to $VERSION"
fi

echo "Tagging $TAG and pushing…"
git -C "$REPO_ROOT" tag "$TAG"
git -C "$REPO_ROOT" push origin HEAD
git -C "$REPO_ROOT" push origin "$TAG"

echo ""
echo "✓ Pushed $TAG."
echo "  GitHub Actions → 'Release Mobile (TestFlight)' is now building on EAS."
echo "  Track it:  gh run watch  (or the Actions tab)"
echo "  When it finishes, the build appears in App Store Connect → TestFlight."
