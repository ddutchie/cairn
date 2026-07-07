#!/bin/bash
set -euo pipefail

# Cairn — publish an over-the-air (OTA) JS/asset update via EAS Update.
#
# Usage: ./scripts/publishupdate.sh "message describing the change"
#        ./scripts/publishupdate.sh "fix note editor crash" preview
#
# This ships JS + asset changes to already-installed builds WITHOUT a new
# TestFlight submission — far cheaper/faster than scripts/releasemobile.sh.
#
# IMPORTANT: OTA updates only reach builds with a matching runtimeVersion
# (policy: "appVersion" in app.json). Anything that changes native code — a new
# native module, a config-plugin change, a bumped SDK, new permissions — needs a
# full build + submit (scripts/releasemobile.sh), NOT an OTA update. If you push
# JS that depends on native changes to an old build, it will crash.
#
# Channel defaults to "production" (the channel the TestFlight build subscribes
# to, per eas.json). Pass "preview" as the 2nd arg for internal builds.

MESSAGE="${1:-}"
CHANNEL="${2:-production}"
MOBILE_DIR="$(cd "$(dirname "$0")/.." && pwd)/mobile"

if [ -z "$MESSAGE" ]; then
    echo "Usage: ./scripts/publishupdate.sh \"what changed\" [channel]"
    echo ""
    echo "Publishes an OTA update to the given EAS Update channel (default:"
    echo "production). Only for JS/asset changes — native changes need a full"
    echo "build via scripts/releasemobile.sh."
    exit 1
fi

cd "$MOBILE_DIR"

echo "Publishing OTA update to channel '$CHANNEL'…"
# --environment is required in non-interactive mode; our channels + EAS
# environments share the same names (production / preview).
# Publish per native platform: this is a native-only app (no react-native-web),
# so --platform=all fails trying to bundle for web, and the CLI rejects a
# comma list — so run ios and android separately.
for plat in ios android; do
  echo "  → $plat"
  eas update --channel "$CHANNEL" --environment "$CHANNEL" --platform "$plat" --message "$MESSAGE" --non-interactive
done

echo ""
echo "✓ Update published to '$CHANNEL'."
echo "  Installed apps on a matching runtimeVersion will download it in the"
echo "  background and show the 'Restart' banner on next launch/resume."
