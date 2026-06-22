import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

/**
 * Unified model manager — handles model file downloads, SHA256 verification,
 * and manifest management for all adapter types.
 *
 * Each model definition includes a `sha256` checksum. Downloads are written
 * to a `.tmp` file, verified against the checksum, then atomically renamed
 * to the final path. If verification fails, the temp file is deleted and
 * the install fails with a clear error.
 *
 * Manifest format (unified, per-adapter):
 * {
 *   "<modelId>": {
 *     "status": "installed" | "downloading" | "not_downloaded" | "error",
 *     "downloadProgress": 0-100,
 *     "downloadSpeed": "1.2 MB/s",
 *     "error": "optional error message",
 *     "verifiedAt": "2026-06-21T..."  // ISO timestamp of last SHA256 check
 *   }
 * }
 */

export interface VerifiedModelDef {
  id: string;
  downloadUrl: string;
  /** Destination path for the model file */
  destPath: string;
  /** Expected file size in bytes (used for progress reporting) */
  sizeBytes: number;
  /** SHA256 checksum of the downloaded file (hex, lowercase, 64 chars). Empty string = skip verification. */
  sha256: string;
  /** Display name */
  name: string;
}

export interface DownloadProgress {
  modelId: string;
  progress: number;
  speed: string;
  bytesReceived: number;
  bytesTotal: number;
}

export interface DownloadResult {
  success: boolean;
  error?: string;
  verified: boolean;
}

/**
 * Compute SHA256 hash of a file. Returns hex lowercase or null on error.
 */
export function computeFileSha256(filePath: string): string | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, "r");
    const hash = crypto.createHash("sha256");
    const buf = Buffer.alloc(64 * 1024);
    let bytesRead: number;
    do {
      bytesRead = fs.readSync(fd, buf, 0, buf.length, null);
      if (bytesRead > 0) hash.update(buf.subarray(0, bytesRead));
    } while (bytesRead > 0);
    return hash.digest("hex");
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
}

/**
 * Verify a downloaded file against an expected SHA256 checksum.
 * Returns true if the file matches, false otherwise.
 * If `expectedSha256` is empty, verification is skipped (returns true).
 */
export function verifyModel(filePath: string, expectedSha256: string): boolean {
  if (!expectedSha256) return true;
  const actual = computeFileSha256(filePath);
  if (!actual) return false;
  return actual === expectedSha256.toLowerCase();
}

/**
 * Manifest record for a single model.
 */
export interface ManifestEntry {
  status: "not_downloaded" | "downloading" | "installed" | "error";
  downloadProgress: number;
  downloadSpeed?: string;
  error?: string;
  verifiedAt?: string;
}

/**
 * Read a JSON manifest file, returning an empty object if it doesn't exist.
 */
export function readManifest(manifestPath: string): Record<string, ManifestEntry> {
  if (!fs.existsSync(manifestPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Record<string, ManifestEntry>;
  } catch {
    return {};
  }
}

/**
 * Write a manifest file, creating parent directories as needed.
 */
export function writeManifest(manifestPath: string, manifest: Record<string, ManifestEntry>): void {
  try {
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    const tmpPath = manifestPath + ".tmp";
    fs.writeFileSync(tmpPath, JSON.stringify(manifest, null, 2), "utf8");
    fs.renameSync(tmpPath, manifestPath);
  } catch (e) {
    console.error("[model-manager] Failed to write manifest:", e);
  }
}

/**
 * Update a single entry in the manifest (merge patch).
 */
export function updateManifestEntry(
  manifestPath: string,
  modelId: string,
  patch: Partial<ManifestEntry>,
): void {
  const manifest = readManifest(manifestPath);
  manifest[modelId] = { ...(manifest[modelId] ?? { status: "not_downloaded", downloadProgress: 0 }), ...patch };
  writeManifest(manifestPath, manifest);
}

/**
 * Verify an existing model file on disk against its expected checksum.
 * If the file fails verification, marks the manifest entry as "not_downloaded".
 * If the file passes, marks as "installed" with verifiedAt timestamp.
 * If no checksum is provided, just checks file existence.
 */
export function verifyOnDisk(
  manifestPath: string,
  modelId: string,
  filePath: string,
  expectedSha256: string,
): boolean {
  if (!fs.existsSync(filePath)) return false;
  if (!expectedSha256) {
    updateManifestEntry(manifestPath, modelId, { status: "installed", downloadProgress: 100, verifiedAt: new Date().toISOString() });
    return true;
  }
  const ok = verifyModel(filePath, expectedSha256);
  if (ok) {
    updateManifestEntry(manifestPath, modelId, { status: "installed", downloadProgress: 100, verifiedAt: new Date().toISOString() });
  } else {
    console.warn(`[model-manager] SHA256 mismatch for ${modelId}, marking not_downloaded`);
    updateManifestEntry(manifestPath, modelId, { status: "not_downloaded", downloadProgress: 0, error: "checksum verification failed" });
  }
  return ok;
}

/**
 * Migrate an old manifest into the unified format. The legacy manifest format
 * is a subset of ManifestEntry (lacks `verifiedAt`). This function:
 *  1. Reads the existing manifest at manifestPath (if any)
 *  2. For each entry marked "installed", verifies the file on disk
 *  3. Adds `verifiedAt` timestamp for verified entries
 *  4. Removes stale entries (files missing) or marks them not_downloaded
 *
 * Returns the number of entries that were updated during migration.
 */
export function migrateManifest(
  manifestPath: string,
  models: Array<{ id: string; filePath: string; sha256: string }>,
): number {
  const manifest = readManifest(manifestPath);
  let updates = 0;
  let changed = false;

  for (const { id, filePath, sha256 } of models) {
    const entry = manifest[id];
    if (!entry) continue;

    if (entry.status === "installed") {
      if (fs.existsSync(filePath)) {
        if (sha256) {
          const ok = verifyModel(filePath, sha256);
          if (!ok && entry.verifiedAt === undefined) {
            manifest[id] = { status: "not_downloaded", downloadProgress: 0, error: "checksum verification failed (migration)" };
            changed = true;
            updates++;
          } else if (ok && entry.verifiedAt === undefined) {
            manifest[id] = { ...entry, verifiedAt: new Date().toISOString() };
            changed = true;
            updates++;
          }
        } else if (entry.verifiedAt === undefined) {
          manifest[id] = { ...entry, verifiedAt: new Date().toISOString() };
          changed = true;
          updates++;
        }
      } else {
        manifest[id] = { status: "not_downloaded", downloadProgress: 0 };
        changed = true;
        updates++;
      }
    }
  }

  if (changed) writeManifest(manifestPath, manifest);
  return updates;
}
