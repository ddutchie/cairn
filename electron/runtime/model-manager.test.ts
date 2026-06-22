import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  computeFileSha256,
  verifyModel,
  readManifest,
  writeManifest,
  updateManifestEntry,
  verifyOnDisk,
} from "./model-manager";
import { migrateManifest } from "./model-manager";

describe("model-manager", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-mm-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("computeFileSha256", () => {
    it("computes SHA256 hash of a file", () => {
      const filePath = path.join(tmpDir, "test.bin");
      const content = Buffer.from("hello world");
      fs.writeFileSync(filePath, content);
      const expected = crypto.createHash("sha256").update(content).digest("hex");
      expect(computeFileSha256(filePath)).toBe(expected);
    });

    it("returns null for non-existent file", () => {
      expect(computeFileSha256(path.join(tmpDir, "nope.bin"))).toBeNull();
    });

    it("handles large files with chunked reads", () => {
      const filePath = path.join(tmpDir, "large.bin");
      // Write 256KB file (larger than 64KB read buffer)
      const content = Buffer.alloc(256 * 1024, 0x42);
      fs.writeFileSync(filePath, content);
      const expected = crypto.createHash("sha256").update(content).digest("hex");
      expect(computeFileSha256(filePath)).toBe(expected);
    });
  });

  describe("verifyModel", () => {
    it("returns true when checksum matches", () => {
      const filePath = path.join(tmpDir, "model.gguf");
      const content = Buffer.from("model data");
      fs.writeFileSync(filePath, content);
      const hash = crypto.createHash("sha256").update(content).digest("hex");
      expect(verifyModel(filePath, hash)).toBe(true);
    });

    it("returns false when checksum does not match", () => {
      const filePath = path.join(tmpDir, "model.gguf");
      fs.writeFileSync(filePath, "different data");
      expect(verifyModel(filePath, "0".repeat(64))).toBe(false);
    });

    it("skips verification when expectedSha256 is empty", () => {
      const filePath = path.join(tmpDir, "model.gguf");
      fs.writeFileSync(filePath, "anything");
      expect(verifyModel(filePath, "")).toBe(true);
    });

    it("is case-insensitive for hex checksum", () => {
      const filePath = path.join(tmpDir, "model.gguf");
      const content = Buffer.from("test");
      fs.writeFileSync(filePath, content);
      const hash = crypto.createHash("sha256").update(content).digest("hex");
      const upperHash = hash.toUpperCase();
      expect(verifyModel(filePath, upperHash)).toBe(true);
    });
  });

  describe("manifest operations", () => {
    it("readManifest returns empty object for non-existent file", () => {
      expect(readManifest(path.join(tmpDir, "manifest.json"))).toEqual({});
    });

    it("readManifest returns parsed object for existing file", () => {
      const manifestPath = path.join(tmpDir, "manifest.json");
      const data = { "model-1": { status: "installed", downloadProgress: 100 } };
      fs.writeFileSync(manifestPath, JSON.stringify(data));
      expect(readManifest(manifestPath)).toEqual(data);
    });

    it("readManifest returns empty object for invalid JSON", () => {
      const manifestPath = path.join(tmpDir, "manifest.json");
      fs.writeFileSync(manifestPath, "{ invalid json }");
      expect(readManifest(manifestPath)).toEqual({});
    });

    it("writeManifest creates parent directories", () => {
      const manifestPath = path.join(tmpDir, "sub", "dir", "manifest.json");
      writeManifest(manifestPath, { "model-1": { status: "installed", downloadProgress: 100 } });
      expect(fs.existsSync(manifestPath)).toBe(true);
    });

    it("updateManifestEntry merges patch into existing entry", () => {
      const manifestPath = path.join(tmpDir, "manifest.json");
      writeManifest(manifestPath, { "model-1": { status: "downloading", downloadProgress: 50 } });
      updateManifestEntry(manifestPath, "model-1", { status: "installed", downloadProgress: 100 });
      const manifest = readManifest(manifestPath);
      expect(manifest["model-1"]).toEqual({ status: "installed", downloadProgress: 100 });
    });

    it("updateManifestEntry creates entry if it does not exist", () => {
      const manifestPath = path.join(tmpDir, "manifest.json");
      updateManifestEntry(manifestPath, "model-new", { status: "installed", downloadProgress: 100 });
      const manifest = readManifest(manifestPath);
      expect(manifest["model-new"]).toEqual({ status: "installed", downloadProgress: 100 });
    });
  });

  describe("verifyOnDisk", () => {
    it("returns true and marks installed when file exists and checksum matches", () => {
      const manifestPath = path.join(tmpDir, "manifest.json");
      const modelPath = path.join(tmpDir, "model.gguf");
      const content = Buffer.from("model content");
      fs.writeFileSync(modelPath, content);
      const hash = crypto.createHash("sha256").update(content).digest("hex");
      const result = verifyOnDisk(manifestPath, "model-1", modelPath, hash);
      expect(result).toBe(true);
      const manifest = readManifest(manifestPath);
      expect(manifest["model-1"].status).toBe("installed");
      expect(manifest["model-1"].downloadProgress).toBe(100);
      expect(manifest["model-1"].verifiedAt).toBeDefined();
    });

    it("returns false and marks not_downloaded when checksum does not match", () => {
      const manifestPath = path.join(tmpDir, "manifest.json");
      const modelPath = path.join(tmpDir, "model.gguf");
      fs.writeFileSync(modelPath, "wrong content");
      const result = verifyOnDisk(manifestPath, "model-1", modelPath, "0".repeat(64));
      expect(result).toBe(false);
      const manifest = readManifest(manifestPath);
      expect(manifest["model-1"].status).toBe("not_downloaded");
      expect(manifest["model-1"].error).toContain("checksum");
    });

    it("returns false when file does not exist", () => {
      const manifestPath = path.join(tmpDir, "manifest.json");
      const result = verifyOnDisk(manifestPath, "model-1", path.join(tmpDir, "nope.gguf"), "0".repeat(64));
      expect(result).toBe(false);
    });

    it("skips checksum when sha256 is empty, just checks existence", () => {
      const manifestPath = path.join(tmpDir, "manifest.json");
      const modelPath = path.join(tmpDir, "model.gguf");
      fs.writeFileSync(modelPath, "any content");
      const result = verifyOnDisk(manifestPath, "model-1", modelPath, "");
      expect(result).toBe(true);
      const manifest = readManifest(manifestPath);
      expect(manifest["model-1"].status).toBe("installed");
      expect(manifest["model-1"].verifiedAt).toBeDefined();
    });
  });

  describe("migrateManifest", () => {
    it("adds verifiedAt to installed entries without it", () => {
      const manifestPath = path.join(tmpDir, "manifest.json");
      const modelPath = path.join(tmpDir, "model.gguf");
      const content = Buffer.from("model data");
      fs.writeFileSync(modelPath, content);
      const hash = crypto.createHash("sha256").update(content).digest("hex");
      writeManifest(manifestPath, { "model-1": { status: "installed", downloadProgress: 100 } });
      const updates = migrateManifest(manifestPath, [{ id: "model-1", filePath: modelPath, sha256: hash }]);
      expect(updates).toBe(1);
      const manifest = readManifest(manifestPath);
      expect(manifest["model-1"].verifiedAt).toBeDefined();
    });

    it("marks not_downloaded when installed but file is missing", () => {
      const manifestPath = path.join(tmpDir, "manifest.json");
      writeManifest(manifestPath, { "model-1": { status: "installed", downloadProgress: 100 } });
      const updates = migrateManifest(manifestPath, [{ id: "model-1", filePath: path.join(tmpDir, "nope.gguf"), sha256: "" }]);
      expect(updates).toBe(1);
      const manifest = readManifest(manifestPath);
      expect(manifest["model-1"].status).toBe("not_downloaded");
    });

    it("marks not_downloaded when checksum fails", () => {
      const manifestPath = path.join(tmpDir, "manifest.json");
      const modelPath = path.join(tmpDir, "model.gguf");
      fs.writeFileSync(modelPath, "wrong content");
      writeManifest(manifestPath, { "model-1": { status: "installed", downloadProgress: 100 } });
      const updates = migrateManifest(manifestPath, [{ id: "model-1", filePath: modelPath, sha256: "0".repeat(64) }]);
      expect(updates).toBe(1);
      const manifest = readManifest(manifestPath);
      expect(manifest["model-1"].status).toBe("not_downloaded");
    });

    it("skips entries with no manifest entry", () => {
      const manifestPath = path.join(tmpDir, "manifest.json");
      // Empty manifest, no model-1 entry
      writeManifest(manifestPath, {});
      const updates = migrateManifest(manifestPath, [{ id: "model-1", filePath: "/tmp/nope.gguf", sha256: "" }]);
      expect(updates).toBe(0);
    });

    it("skips entries that already have verifiedAt", () => {
      const manifestPath = path.join(tmpDir, "manifest.json");
      const modelPath = path.join(tmpDir, "model.gguf");
      const content = Buffer.from("model data");
      fs.writeFileSync(modelPath, content);
      const hash = crypto.createHash("sha256").update(content).digest("hex");
      writeManifest(manifestPath, { "model-1": { status: "installed", downloadProgress: 100, verifiedAt: "2026-01-01T00:00:00.000Z" } });
      const updates = migrateManifest(manifestPath, [{ id: "model-1", filePath: modelPath, sha256: hash }]);
      expect(updates).toBe(0);
    });

    it("skips entries that are not installed (e.g. downloading)", () => {
      const manifestPath = path.join(tmpDir, "manifest.json");
      writeManifest(manifestPath, { "model-1": { status: "downloading", downloadProgress: 50 } });
      const updates = migrateManifest(manifestPath, [{ id: "model-1", filePath: "/tmp/nope.gguf", sha256: "" }]);
      expect(updates).toBe(0);
      const manifest = readManifest(manifestPath);
      expect(manifest["model-1"].status).toBe("downloading");
    });
  });
});
