#!/bin/bash
set -e

# Cairn — promote a draft release to public + latest
#
# Usage: ./scripts/promote-release.sh v2.1.6
#
# After CI finishes building and uploading the DMG/installers to the draft
# release, the developer downloads the packaged app, smoke-tests it, and then
# runs this script to make the release visible to auto-update.
#
# Before running: download the DMG from the GitHub releases page, open it,
# click around the app, and check the console (View > Toggle Developer Tools)
# for any errors. If everything looks good, promote.

TAG="${1:-}"

if [ -z "$TAG" ]; then
    echo "Usage: ./scripts/promote-release.sh v2.1.x"
    echo ""
    echo "Promotes a draft GitHub release to public + latest."
    echo "Auto-update will pick up the release immediately after promotion."
    exit 1
fi

# Ensure the tag exists locally
if ! git tag -l "$TAG" | grep -q "$TAG"; then
    echo "Error: tag $TAG not found. Fetch tags first: git fetch --tags"
    exit 1
fi

echo "Promoting release $TAG from draft → published + latest..."
gh release edit "$TAG" --draft=false --latest

echo ""
echo "✓ $TAG is now public and marked as latest."
echo "  Auto-update users will receive the update on their next launch."
