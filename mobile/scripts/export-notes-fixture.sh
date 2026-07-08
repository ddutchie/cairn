#!/usr/bin/env bash
#
# Export your real Cairn notes into the SwiftPM live-test fixture so the
# real-corpus semantic-search tests can run against actual data.
#
# The fixture (real_notes.json) is gitignored — it contains your private note
# content and is never committed. Run this once locally before:
#
#   cd modules/apple-embeddings/tests && swift test
#
# The real-corpus tests (testRealCorpus*) skip gracefully if the fixture is
# absent, so CI / other machines still pass without it.
#
# Usage:
#   ./scripts/export-notes-fixture.sh [path/to/cairn.db]
#
# Defaults to ~/Documents/Cairn/cairn.db (the desktop app's data dir).

set -euo pipefail

DB="${1:-$HOME/Documents/Cairn/cairn.db}"
OUT="$(cd "$(dirname "$0")/.." && pwd)/modules/apple-embeddings/tests/Tests/EmbeddingLiveTests/Fixtures/real_notes.json"

if [ ! -f "$DB" ]; then
  echo "error: database not found at: $DB" >&2
  echo "pass the path explicitly: $0 /path/to/cairn.db" >&2
  exit 1
fi

mkdir -p "$(dirname "$OUT")"

# Live, non-conflict notes with markdown content (matches listEmbeddableNotes).
sqlite3 "$DB" \
  "SELECT json_group_array(json_object('id', id, 'title', title, 'content', content))
   FROM notes
   WHERE deleted_at IS NULL AND type = 'note' AND content IS NOT NULL AND content != '';" \
  > "$OUT"

COUNT="$(sqlite3 "$DB" \
  "SELECT COUNT(*) FROM notes WHERE deleted_at IS NULL AND type = 'note' AND content IS NOT NULL AND content != '';")"

echo "exported $COUNT notes → $OUT"
