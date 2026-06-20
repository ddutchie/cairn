#!/bin/bash
set -e

# Cairn release script
# Usage: ./scripts/release.sh [patch|minor|major]

VERSION_TYPE=$1

if [ -z "$VERSION_TYPE" ]; then
    echo "Usage: ./scripts/release.sh [patch|minor|major]"
    exit 1
fi

# 1. Ensure we are on the main or master branch
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "$CURRENT_BRANCH" != "main" ] && [ "$CURRENT_BRANCH" != "master" ]; then
    echo "Error: Releases must be created from the 'main' or 'master' branch."
    exit 1
fi

# 2. Check for uncommitted changes
if ! git diff-index --quiet HEAD --; then
    echo "Error: You have uncommitted changes. Please commit or stash them first."
    exit 1
fi

# 3. Pull latest changes
echo "Pulling latest changes..."
git pull origin $CURRENT_BRANCH

# 4. Check that a changelog exists for the next version before touching anything
CURRENT_VERSION=$(node -p "require('./package.json').version")
NEXT_VERSION=$(node -e "
  const [maj, min, pat] = '$CURRENT_VERSION'.split('.').map(Number);
  if ('$VERSION_TYPE' === 'major') process.stdout.write((maj+1)+'.0.0');
  else if ('$VERSION_TYPE' === 'minor') process.stdout.write(maj+'.'+(min+1)+'.0');
  else process.stdout.write(maj+'.'+min+'.'+(pat+1));
")
CHANGELOG="changelogs/v${NEXT_VERSION}.md"

if [ ! -f "$CHANGELOG" ]; then
    echo "Error: No changelog found for v${NEXT_VERSION}."
    echo "       Expected: $CHANGELOG"
    echo "       Create it before releasing."
    exit 1
fi

echo "Changelog found: $CHANGELOG"

# 5. Run the pre-release gate (compile + type-check + lint + tests + e2e).
#    Pass --skip-e2e only on urgent hotfixes with no UI changes.
echo "Running pre-release checks..."
./scripts/pre-release-check.sh

# 6. Bump version (this updates package.json and creates a git tag)
echo "Bumping version ($VERSION_TYPE)..."
NEW_VERSION=$(npm version $VERSION_TYPE -m "Release v%s")

# 7. Push changes and tags
echo "Pushing $NEW_VERSION to GitHub..."
git push origin $CURRENT_BRANCH --tags

echo "------------------------------------------------"
echo "Success! $NEW_VERSION has been pushed."
echo "GitHub Actions will now start the build process."
echo "------------------------------------------------"
