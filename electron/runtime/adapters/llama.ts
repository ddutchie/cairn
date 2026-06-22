/* eslint-disable @typescript-eslint/no-explicit-any */
import { spawn, execFileSync, execFile, ChildProcess } from "child_process";
import * as path from "path";
import * as fs from "fs";
import * as https from "https";
import * as http from "http";
import * as net from "net";

import type {
  AdapterConfig,
  AdapterHealth,
  AdapterModelEntry,
  AdapterStatus,
  ModelManagingAdapter,
} from "./types";
import { findFreePort } from "../../embeddings/port";
import { verifyModel, verifyOnDisk } from "../model-manager";

export const SUPPORTED_LLM_MODELS: Record<
  string,
  Omit<AdapterModelEntry, "status" | "downloadProgress" | "downloadSpeed" | "error" | "meta"> & {
    meta: { filename: string; quant: string; downloadUrl: string; sha256: string };
  }
> = {
  "gemma-4-e2b-it-q4": {
    id: "gemma-4-e2b-it-q4",
    name: "Gemma 4 E2B IT (Q4_K_M)",
    repo: "unsloth/gemma-4-E2B-it-GGUF",
    sizeBytes: 3_106_736_256,
    meta: { filename: "gemma-4-E2B-it-Q4_K_M.gguf", quant: "Q4_K_M", downloadUrl: "https://huggingface.co/unsloth/gemma-4-E2B-it-GGUF/resolve/main/gemma-4-E2B-it-Q4_K_M.gguf", sha256: "9378bc471710229ef165709b62e34bfb62231420ddaf6d729e727305b5b8672d" },
  },
  "gemma-4-e2b-it-q8": {
    id: "gemma-4-e2b-it-q8",
    name: "Gemma 4 E2B IT (Q8_0)",
    repo: "ggml-org/gemma-4-E2B-it-GGUF",
    sizeBytes: 4_967_494_592,
    meta: { filename: "gemma-4-E2B-it-Q8_0.gguf", quant: "Q8_0", downloadUrl: "https://huggingface.co/ggml-org/gemma-4-E2B-it-GGUF/resolve/main/gemma-4-E2B-it-Q8_0.gguf", sha256: "e049411c01fb7a81161768c52e38828970e55a64e22738957adcbe51d20f1c8e" },
  },
  "gemma-4-e4b-it-q4": {
    id: "gemma-4-e4b-it-q4",
    name: "Gemma 4 E4B IT (Q4_K_M)",
    repo: "ggml-org/gemma-4-E4B-it-GGUF",
    sizeBytes: 5_335_289_824,
    meta: { filename: "gemma-4-E4B-it-Q4_K_M.gguf", quant: "Q4_K_M", downloadUrl: "https://huggingface.co/ggml-org/gemma-4-E4B-it-GGUF/resolve/main/gemma-4-E4B-it-Q4_K_M.gguf", sha256: "90ce98129eb3e8cc57e62433d500c97c624b1e3af1fcc85dd3b55ad7e0313e9f" },
  },
  "gemma-4-e4b-it-q8": {
    id: "gemma-4-e4b-it-q8",
    name: "Gemma 4 E4B IT (Q8_0)",
    repo: "ggml-org/gemma-4-E4B-it-GGUF",
    sizeBytes: 8_031_240_160,
    meta: { filename: "gemma-4-E4B-it-Q8_0.gguf", quant: "Q8_0", downloadUrl: "https://huggingface.co/ggml-org/gemma-4-E4B-it-GGUF/resolve/main/gemma-4-E4B-it-Q8_0.gguf", sha256: "fb8f0c032de00b18c710824af3c7e5777c71e5fb60b13f13575f0a9e92ddecd0" },
  },
};

export function isSupportedLLMModel(modelId: string): boolean {
  return modelId in SUPPORTED_LLM_MODELS;
}

export class LlamaAdapter implements ModelManagingAdapter {
  readonly id = "llama";
  readonly kind = "llm" as const;

  private config: AdapterConfig;
  private binDir: string;
  private binPath: string;
  private manifestPath: string;
  private defaultModelPath: string;

  private serverProcess: ChildProcess | null = null;
  private serverPort: number | null = null;
  private activeModelId: string | null = null;
  private bootError = "";
  private isBinaryDownloading = false;
  private activeDownloads = new Map<string, http.ClientRequest>();

  constructor(config: AdapterConfig) {
    this.config = config;
    this.binDir = config.binDir;
    this.binPath = path.join(
      this.binDir,
      process.platform === "win32" ? "llama-server.exe" : "llama-server",
    );
    this.manifestPath = path.join(config.modelsDir, "manifest.json");
    this.defaultModelPath = path.join(config.modelsDir, "default-model.json");
  }

  // ── Model management ──────────────────────────────────────────

  listModels(): AdapterModelEntry[] {
    const manifest = this.readManifest();
    const result: AdapterModelEntry[] = [];
    for (const [id, def] of Object.entries(SUPPORTED_LLM_MODELS)) {
      const entry = manifest[id] ?? { status: "not_downloaded" as const, downloadProgress: 0 };
      const modelPath = this.modelPath(id);
      const fileExists = fs.existsSync(modelPath);
      // If file exists but manifest says not installed, verify checksum and update
      let status = entry.status;
      if (fileExists && status !== "installed") {
        status = verifyOnDisk(this.manifestPath, id, modelPath, def.meta.sha256) ? "installed" : "not_downloaded";
      } else if (!fileExists && status === "installed") {
        status = "not_downloaded";
        this.updateManifestEntry(id, { status: "not_downloaded", downloadProgress: 0 });
      }
      result.push({
        id,
        name: def.name,
        repo: def.repo,
        sizeBytes: def.sizeBytes,
        status,
        downloadProgress: status === "installed" ? 100 : entry.downloadProgress,
        downloadSpeed: entry.downloadSpeed,
        error: entry.error,
        meta: def.meta,
      });
    }
    return result;
  }

  isModelInstalled(modelId: string): boolean {
    const def = SUPPORTED_LLM_MODELS[modelId];
    if (!def) return false;
    const modelPath = this.modelPath(modelId);
    if (!fs.existsSync(modelPath)) return false;
    // Verify checksum if defined
    return verifyOnDisk(this.manifestPath, modelId, modelPath, def.meta.sha256);
  }

  async installModel(modelId: string, useMirror?: boolean): Promise<void> {
    const def = SUPPORTED_LLM_MODELS[modelId];
    if (!def) throw new Error(`Model ${modelId} is not supported.`);

    const manifest = this.readManifest();
    const entry = manifest[modelId];
    if (entry?.status === "downloading") throw new Error(`Model ${modelId} is already downloading.`);

    if (!entry || entry.status !== "installed") {
      this.updateManifestEntry(modelId, { status: "downloading", downloadProgress: 0, error: undefined });
    }

    const destPath = this.modelPath(modelId);
    const tempPath = `${destPath}.tmp`;
    const downloadUrl = def.meta.downloadUrl;

    const sourceUrl = useMirror
      ? downloadUrl.replace("https://huggingface.co", "https://hf-mirror.com")
      : downloadUrl;

    await new Promise<void>((resolve, reject) => {
      let lastBytes = 0;
      let lastTime = Date.now();
      let speed = "0 KB/s";
      let lastBroadcastTime = 0;

      const broadcastProgress = (bytesReceived: number, bytesTotal: number, force = false) => {
        const now = Date.now();
        const duration = (now - lastTime) / 1000;
        if (duration >= 1) {
          const delta = bytesReceived - lastBytes;
          lastBytes = bytesReceived;
          lastTime = now;
          speed = `${((delta / 1024 / 1024) / duration).toFixed(1)} MB/s`;
        }
        if (!force && now - lastBroadcastTime < 300) return;
        lastBroadcastTime = now;
        const progress = bytesTotal > 0 ? Math.min(100, Math.round((bytesReceived / bytesTotal) * 100)) : 0;
        this.updateManifestEntry(modelId, { downloadProgress: progress, downloadSpeed: speed });
        this.config.onProgress?.({
          type: "download",
          modelId,
          progress,
          speed,
          status: "downloading",
        });
      };

      const download = (url: string) => {
        const req = https.get(url, (res) => {
          if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            let redirectUrl = res.headers.location;
            if (useMirror && /cdn-lfs[-a-zA-Z0-9]*\.huggingface\.co/.test(redirectUrl)) {
              redirectUrl = redirectUrl.replace(/cdn-lfs[-a-zA-Z0-9]*\.huggingface\.co/g, "cdn-lfs.hf-mirror.com");
            }
            download(redirectUrl);
            return;
          }
          if (res.statusCode !== 200) {
            reject(new Error(`Server responded with status code ${res.statusCode}`));
            return;
          }
          const totalBytes = parseInt(res.headers["content-length"] || "0", 10);
          let receivedBytes = 0;
          const fileStream = fs.createWriteStream(tempPath);
          res.on("data", (chunk) => {
            receivedBytes += chunk.length;
            fileStream.write(chunk);
            broadcastProgress(receivedBytes, totalBytes, false);
          });
          res.on("end", () => {
            fileStream.end();
            broadcastProgress(receivedBytes, totalBytes, true);
            resolve();
          });
          res.on("error", (err) => {
            fileStream.close();
            fs.unlink(tempPath, () => {});
            reject(err);
          });
        });
        req.on("error", (err) => reject(err));
        this.activeDownloads.set(modelId, req);
      };

      download(sourceUrl);
    });

    this.activeDownloads.delete(modelId);
    if (fs.existsSync(tempPath)) {
      // Verify SHA256 checksum before promoting temp file to final path
      if (def.meta.sha256 && !verifyModel(tempPath, def.meta.sha256)) {
        fs.unlink(tempPath, () => { /* ignore */ });
        const errMsg = `SHA256 checksum verification failed for ${modelId}. Download may be corrupted.`;
        this.updateManifestEntry(modelId, { status: "error", downloadProgress: 0, downloadSpeed: undefined, error: errMsg });
        this.config.onProgress?.({ type: "download", modelId, progress: 0, status: "error", error: errMsg });
        throw new Error(errMsg);
      }
      fs.renameSync(tempPath, destPath);
    }
    verifyOnDisk(this.manifestPath, modelId, destPath, def.meta.sha256);
    this.config.onProgress?.({ type: "download", modelId, progress: 100, status: "installed" });
  }

  removeModel(modelId: string): void {
    const def = SUPPORTED_LLM_MODELS[modelId];
    if (!def) return;
    if (this.activeModelId === modelId && this.serverProcess) {
      throw new Error("Model is currently running. Stop the server before deleting it.");
    }
    const activeReq = this.activeDownloads.get(modelId);
    if (activeReq) {
      activeReq.destroy();
      this.activeDownloads.delete(modelId);
    }
    const modelPath = this.modelPath(modelId);
    if (fs.existsSync(modelPath)) fs.unlinkSync(modelPath);
    const tempPath = `${modelPath}.tmp`;
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    this.updateManifestEntry(modelId, { status: "not_downloaded", downloadProgress: 0, downloadSpeed: undefined, error: undefined });
  }

  /** Remove all downloaded models except the one currently running. */
  clearInactiveModels(): void {
    const manifest = this.readManifest();
    for (const [id, entry] of Object.entries(manifest)) {
      if (entry.status === "installed" && id !== this.activeModelId) {
        this.removeModel(id);
      }
    }
  }

  getDefaultModelId(): string | null {
    if (fs.existsSync(this.defaultModelPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(this.defaultModelPath, "utf8"));
        return data.defaultModelId || null;
      } catch {
        return null;
      }
    }
    return null;
  }

  setDefaultModelId(modelId: string): void {
    try {
      fs.mkdirSync(path.dirname(this.defaultModelPath), { recursive: true });
      fs.writeFileSync(this.defaultModelPath, JSON.stringify({ defaultModelId: modelId }), "utf8");
    } catch (e) {
      console.error("[llama-adapter] Failed to save default model:", e);
    }
  }

  // ── Server lifecycle ──────────────────────────────────────────

  async start(modelId: string, opts?: { contextLimit?: number }): Promise<{ port: number }> {
    const def = SUPPORTED_LLM_MODELS[modelId];
    if (!def || !this.isModelInstalled(modelId)) {
      throw new Error(`Model ${modelId} is not downloaded.`);
    }
    if (!this.isBinaryInstalled()) {
      throw new Error("llama-server binary is not installed.");
    }

    if (this.serverProcess && this.activeModelId === modelId && this.serverPort) {
      if (await this.checkHealth(this.serverPort)) return { port: this.serverPort };
      await this.stop();
    } else if (this.serverProcess) {
      await this.stop();
    }

    const port = await findFreePort();
    const requestedContext = opts?.contextLimit ?? 16384;
    const contextSize = requestedContext > 32768 ? 16384 : requestedContext;

    const processArgs = [
      "-m", this.modelPath(modelId),
      "--port", port.toString(),
      "--host", "127.0.0.1",
      "-c", contextSize.toString(),
      "-np", "1",
      "--no-warmup",
    ];

    const binaryPath = fs.existsSync(this.binPath) ? this.binPath : "llama-server";
    const child = spawn(binaryPath, processArgs, {
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    });

    let bootError = "";
    child.stderr?.on("data", (data) => { bootError += data.toString(); });
    child.stdout?.on("data", (data) => {
      console.log("[llama-adapter stdout]:", data.toString().trim());
    });

    this.serverProcess = child;
    this.serverPort = port;
    this.activeModelId = modelId;

    let isHealthy = false;
    for (let i = 0; i < 300; i++) {
      if (child.killed || child.exitCode !== null) break;
      await new Promise((r) => setTimeout(r, 200));
      isHealthy = await this.checkHealth(port);
      if (isHealthy) break;
    }

    if (!isHealthy) {
      await this.stop();
      throw new Error(`llama-server failed to start. Stderr:\n${bootError.slice(-500)}`);
    }

    this.setDefaultModelId(modelId);
    return { port };
  }

  async stop(_opts?: { force?: boolean }): Promise<void> {
    if (!this.serverProcess) return;
    const proc = this.serverProcess;
    this.serverProcess = null;
    this.serverPort = null;
    this.activeModelId = null;
    try {
      proc.kill("SIGTERM");
    } catch { /* ignore */ }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try { proc.kill("SIGKILL"); } catch { /* ignore */ }
        resolve();
      }, 2000);
      proc.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  async health(): Promise<AdapterHealth> {
    if (!this.serverProcess || !this.serverPort) {
      return { healthy: false, model: null, loaded: false };
    }
    const healthy = await this.checkHealth(this.serverPort);
    return { healthy, model: this.activeModelId, loaded: healthy };
  }

  status(): AdapterStatus {
    return {
      kind: this.kind,
      running: this.serverProcess !== null && !this.serverProcess.killed,
      model: this.activeModelId,
      port: this.serverPort,
      error: this.bootError || null,
    };
  }

  async dispose(): Promise<void> {
    await this.stop({ force: true });
    for (const [, req] of this.activeDownloads) {
      try { req.destroy(); } catch { /* ignore */ }
    }
    this.activeDownloads.clear();
  }

  stopSync(): void {
    if (this.serverProcess) {
      try { this.serverProcess.kill("SIGKILL"); } catch { /* ignore */ }
      this.serverProcess = null;
      this.serverPort = null;
      this.activeModelId = null;
    }
  }

  // ── Binary management ────────────────────────────────────────

  isBinaryInstalled(): boolean {
    if (fs.existsSync(this.binPath)) {
      if (process.platform === "darwin") {
        const dylib = path.join(this.binDir, "libllama-server-impl.dylib");
        if (!fs.existsSync(dylib)) return false;
      }
      return true;
    }
    try {
      execFileSync(process.platform === "win32" ? "where" : "which", [process.platform === "win32" ? "llama-server" : "llama-server"], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  }

  getBinaryVersion(): string | null {
    const engineMetaPath = path.join(this.binDir, "engine.json");
    if (fs.existsSync(engineMetaPath)) {
      try {
        const meta = JSON.parse(fs.readFileSync(engineMetaPath, "utf8"));
        return meta.version || null;
      } catch { return null; }
    }
    return null;
  }

  async installBinary(onProgress?: (progress: number, speed: string, status: string, error?: string) => void): Promise<void> {
    if (this.isBinaryDownloading) throw new Error("Local Llama engine downloader is already active.");
    if (!fs.existsSync(this.binDir)) fs.mkdirSync(this.binDir, { recursive: true });
    this.isBinaryDownloading = true;

    const sendProgress = (progress: number, speed: string, status: string, error?: string, force = false) => {
      if (!force && status === "downloading") return;
      onProgress?.(progress, speed, status, error);
    };

    sendProgress(0, "0 KB/s", "fetching_release");

    try {
      const releaseUrl = "https://api.github.com/repos/ggml-org/llama.cpp/releases/latest";
      const releaseData = await this.fetchGitHubJson<any>(releaseUrl);
      const assets: any[] = releaseData.assets || [];

      let regex: RegExp;
      let archiveExt: ".tar.gz" | ".zip";

      if (process.platform === "darwin") {
        archiveExt = ".tar.gz";
        regex = process.arch === "arm64"
          ? /llama-.*-bin-macos-arm64(?!-kleidiai)\.tar\.gz$/
          : /llama-.*-bin-macos-x64\.tar\.gz$/;
      } else if (process.platform === "win32") {
        archiveExt = ".zip";
        regex = /llama-.*-bin-win-cpu-x64\.zip$/;
      } else {
        archiveExt = ".tar.gz";
        regex = /llama-.*-bin-ubuntu-x64\.tar\.gz$/;
      }

      const asset = assets.find((a) => regex.test(a.name));
      if (!asset) {
        throw new Error(`Could not find prebuilt llama-server for platform ${process.platform}-${process.arch}.`);
      }

      const downloadUrl = asset.browser_download_url;
      const tempArchive = path.join(this.binDir, `temp${archiveExt}`);

      sendProgress(5, "0 KB/s", "downloading");

      await new Promise<void>((resolve, reject) => {
        let lastBytes = 0;
        let lastTime = Date.now();
        let speed = "0 KB/s";
        const download = (url: string) => {
          const options: https.RequestOptions = { headers: { "User-Agent": "Cairn-Client/1.0" } };
          const req = https.get(url, options, (res) => {
            if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
              download(res.headers.location);
              return;
            }
            if (res.statusCode !== 200) {
              reject(new Error(`Server responded with status code ${res.statusCode}`));
              return;
            }
            const totalBytes = parseInt(res.headers["content-length"] || "0", 10);
            let receivedBytes = 0;
            const fileStream = fs.createWriteStream(tempArchive);
            res.on("data", (chunk) => {
              receivedBytes += chunk.length;
              fileStream.write(chunk);
              const now = Date.now();
              const duration = (now - lastTime) / 1000;
              if (duration >= 1) {
                const delta = receivedBytes - lastBytes;
                lastBytes = receivedBytes;
                lastTime = now;
                speed = `${((delta / 1024 / 1024) / duration).toFixed(1)} MB/s`;
              }
              const pct = Math.min(100, Math.round((receivedBytes / totalBytes) * 100));
              sendProgress(pct, speed, "downloading", undefined, false);
            });
            res.on("end", () => {
              fileStream.end();
              sendProgress(100, speed, "downloading", undefined, true);
              resolve();
            });
            res.on("error", (err) => {
              fileStream.close();
              fs.unlink(tempArchive, () => {});
              reject(err);
            });
          });
          req.on("error", (err) => reject(err));
        };
        download(downloadUrl);
      });

      sendProgress(90, "0 KB/s", "extracting");

      const extractDir = path.join(this.binDir, "extracted");
      if (fs.existsSync(extractDir)) fs.rmSync(extractDir, { recursive: true, force: true });
      fs.mkdirSync(extractDir, { recursive: true });

      await new Promise<void>((resolve, reject) => {
        const tarArgs = process.platform === "win32"
          ? ["-xf", tempArchive, "-C", extractDir]
          : ["-xzf", tempArchive, "-C", extractDir];
        execFile("tar", tarArgs, (err) => {
          if (err) {
            if (process.platform === "win32") {
              const psArgs = ["-Command", `Expand-Archive -Path '${tempArchive}' -DestinationPath '${extractDir}' -Force`];
              execFile("powershell", psArgs, (psErr) => {
                if (psErr) reject(new Error(`Extraction failed: ${psErr.message}`));
                else resolve();
              });
            } else {
              reject(new Error(`Extraction failed: ${err.message}`));
            }
          } else { resolve(); }
        });
      });

      const binaryName = process.platform === "win32" ? "llama-server.exe" : "llama-server";
      let foundPath: string | null = null;

      const searchDir = (dir: string) => {
        if (foundPath) return;
        const items = fs.readdirSync(dir);
        for (const item of items) {
          const full = path.join(dir, item);
          const stat = fs.statSync(full);
          if (stat.isDirectory()) { searchDir(full); }
          else if (item === binaryName) { foundPath = full; return; }
        }
      };
      searchDir(extractDir);

      if (!foundPath) throw new Error(`Could not find ${binaryName} inside downloaded archive.`);

      const binParentDir = path.dirname(foundPath);
      const files = fs.readdirSync(binParentDir);
      for (const file of files) {
        const srcPath = path.join(binParentDir, file);
        const destPath = path.join(this.binDir, file);
        const stat = fs.statSync(srcPath);
        if (stat.isFile()) {
          if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
          fs.copyFileSync(srcPath, destPath);
          if (process.platform !== "win32") {
            fs.chmodSync(destPath, "755");
            if (process.platform === "darwin") {
              try { execFileSync("xattr", ["-rd", "com.apple.quarantine", destPath], { stdio: "ignore" }); } catch { /* ignore */ }
            }
          }
        }
      }

      const engineMetaPath = path.join(this.binDir, "engine.json");
      fs.writeFileSync(engineMetaPath, JSON.stringify({
        version: releaseData.tag_name || "unknown",
        installedAt: new Date().toISOString(),
      }, null, 2), "utf8");

      fs.unlinkSync(tempArchive);
      fs.rmSync(extractDir, { recursive: true, force: true });

      this.isBinaryDownloading = false;
      sendProgress(100, "", "installed");
    } catch (err: any) {
      this.isBinaryDownloading = false;
      sendProgress(0, "", "error", err.message);
      throw err;
    }
  }

  async checkBinaryUpdate(): Promise<{ updateAvailable: boolean; currentVersion: string | null; latestVersion: string | null }> {
    const currentVersion = this.getBinaryVersion();
    try {
      const releaseUrl = "https://api.github.com/repos/ggml-org/llama.cpp/releases/latest";
      const releaseData = await this.fetchGitHubJson<any>(releaseUrl);
      const latestVersion = releaseData.tag_name || null;
      if (!latestVersion) return { updateAvailable: false, currentVersion, latestVersion: null };
      const updateAvailable = !currentVersion || currentVersion !== latestVersion;
      return { updateAvailable, currentVersion, latestVersion };
    } catch {
      return { updateAvailable: false, currentVersion, latestVersion: null };
    }
  }

  // ── Helpers ───────────────────────────────────────────────────

  private modelPath(modelId: string): string {
    const def = SUPPORTED_LLM_MODELS[modelId];
    return path.join(this.config.modelsDir, def?.meta.filename ?? modelId);
  }

  private async checkHealth(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const req = http.get(`http://127.0.0.1:${port}/health`, { timeout: 1000 } as any, (res) => {
        resolve(res.statusCode === 200);
      });
      req.on("error", () => {
        const socket = new net.Socket();
        socket.setTimeout(500);
        socket.connect(port, "127.0.0.1", () => { socket.destroy(); resolve(true); });
        socket.on("error", () => resolve(false));
        socket.on("timeout", () => { socket.destroy(); resolve(false); });
      });
    });
  }

  private async fetchGitHubJson<T>(url: string): Promise<T> {
    return new Promise((resolve, reject) => {
      const get = (currentUrl: string) => {
        const options: https.RequestOptions = {
          headers: { "User-Agent": "Cairn-Client/1.0", Accept: "application/json" },
        };
        https.get(currentUrl, options, (res) => {
          if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            get(res.headers.location);
            return;
          }
          if (res.statusCode !== 200) { reject(new Error(`GitHub responded with status ${res.statusCode}`)); return; }
          let body = "";
          res.on("data", (chunk) => { body += chunk; });
          res.on("end", () => {
            try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
          });
        }).on("error", (err) => reject(err));
      };
      get(url);
    });
  }

  // ── Manifest helpers ─────────────────────────────────────────

  private readManifest(): Record<string, any> {
    if (!fs.existsSync(this.manifestPath)) return {};
    try {
      return JSON.parse(fs.readFileSync(this.manifestPath, "utf8"));
    } catch {
      return {};
    }
  }

  private writeManifest(manifest: Record<string, unknown>): void {
    try {
      fs.mkdirSync(path.dirname(this.manifestPath), { recursive: true });
      fs.writeFileSync(this.manifestPath, JSON.stringify(manifest, null, 2), "utf8");
    } catch (e) {
      console.error("[llama-adapter] Failed to write manifest:", e);
    }
  }

  private updateManifestEntry(modelId: string, patch: Record<string, unknown>): void {
    const manifest = this.readManifest();
    manifest[modelId] = { ...(manifest[modelId] ?? {}), ...patch };
    this.writeManifest(manifest);
  }
}
