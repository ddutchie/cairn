import { spawn, execSync, exec, ChildProcess } from "child_process";
import * as path from "path";
import * as fs from "fs";
import * as https from "https";
import * as http from "http";
import * as net from "net";
import { app, BrowserWindow } from "electron";

export interface ModelManifestEntry {
  id: string;
  name: string;
  filename: string;
  path: string;
  repo: string;
  quant: string;
  downloadUrl: string;
  sizeBytes: number;
  status: "not_downloaded" | "downloading" | "installed" | "error";
  downloadProgress: number; // 0 to 100
  downloadSpeed?: string;
  error?: string;
}

// Supported Gemma 4 model definitions
export const SUPPORTED_MODELS: Record<string, Omit<ModelManifestEntry, "status" | "downloadProgress" | "path">> = {
  "gemma-4-e2b-it-q4": {
    id: "gemma-4-e2b-it-q4",
    name: "Gemma 4 E2B IT (Q4_K_M)",
    filename: "gemma-4-E2B-it-Q4_K_M.gguf",
    repo: "ggml-org/gemma-4-E2B-it-GGUF",
    quant: "Q4_K_M",
    downloadUrl: "https://huggingface.co/ggml-org/gemma-4-E2B-it-GGUF/resolve/main/gemma-4-E2B-it-Q4_K_M.gguf",
    sizeBytes: 3350000000 // approx 3.35 GB
  },
  "gemma-4-e2b-it-q8": {
    id: "gemma-4-e2b-it-q8",
    name: "Gemma 4 E2B IT (Q8_0)",
    filename: "gemma-4-E2B-it-Q8_0.gguf",
    repo: "ggml-org/gemma-4-E2B-it-GGUF",
    quant: "Q8_0",
    downloadUrl: "https://huggingface.co/ggml-org/gemma-4-E2B-it-GGUF/resolve/main/gemma-4-E2B-it-Q8_0.gguf",
    sizeBytes: 5240000000 // approx 5.24 GB
  },
  "gemma-4-e4b-it-q4": {
    id: "gemma-4-e4b-it-q4",
    name: "Gemma 4 E4B IT (Q4_K_M)",
    filename: "gemma-4-E4B-it-Q4_K_M.gguf",
    repo: "ggml-org/gemma-4-E4B-it-GGUF",
    quant: "Q4_K_M",
    downloadUrl: "https://huggingface.co/ggml-org/gemma-4-E4B-it-GGUF/resolve/main/gemma-4-E4B-it-Q4_K_M.gguf",
    sizeBytes: 3350000000 // approx 3.35 GB
  },
  "gemma-4-e4b-it-q8": {
    id: "gemma-4-e4b-it-q8",
    name: "Gemma 4 E4B IT (Q8_0)",
    filename: "gemma-4-E4B-it-Q8_0.gguf",
    repo: "ggml-org/gemma-4-E4B-it-GGUF",
    quant: "Q8_0",
    downloadUrl: "https://huggingface.co/ggml-org/gemma-4-E4B-it-GGUF/resolve/main/gemma-4-E4B-it-Q8_0.gguf",
    sizeBytes: 5240000000 // approx 5.24 GB
  }
};

const MODELS_DIR = path.join(app.getPath("userData"), "llama-models");
const MANIFEST_PATH = path.join(MODELS_DIR, "manifest.json");

export const LOCAL_BIN_DIR = path.join(app.getPath("userData"), "llama-bin");
export const LOCAL_BIN_PATH = path.join(LOCAL_BIN_DIR, process.platform === "win32" ? "llama-server.exe" : "llama-server");

// Server state
let serverProcess: ChildProcess | null = null;
let serverPort: number | null = null;
let activeModelId: string | null = null;

// Download state
const activeRequests = new Map<string, https.ClientRequest>();
let isBinaryDownloading = false;

/**
 * Ensures the model directory exists and reads/initialises the manifest file.
 */
function getManifest(): Record<string, ModelManifestEntry> {
  if (!fs.existsSync(MODELS_DIR)) {
    fs.mkdirSync(MODELS_DIR, { recursive: true });
  }

  let manifest: Record<string, ModelManifestEntry> = {};
  if (fs.existsSync(MANIFEST_PATH)) {
    try {
      manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
    } catch (e) {
      console.error("[llama-server] Failed to parse manifest, resetting:", e);
    }
  }

  // Merge manifest with supported definitions, ensuring all supported ones are represented
  let updated = false;
  for (const [id, def] of Object.entries(SUPPORTED_MODELS)) {
    if (!manifest[id]) {
      manifest[id] = {
        ...def,
        path: path.join(MODELS_DIR, def.filename),
        status: "not_downloaded",
        downloadProgress: 0
      };
      updated = true;
    } else {
      // Sync names and details if updated in code
      manifest[id] = {
        ...manifest[id],
        name: def.name,
        filename: def.filename,
        repo: def.repo,
        quant: def.quant,
        downloadUrl: def.downloadUrl,
        sizeBytes: def.sizeBytes,
        path: path.join(MODELS_DIR, def.filename)
      };
    }

    // Double check file on disk
    const fileExists = fs.existsSync(manifest[id].path);
    if (fileExists && manifest[id].status !== "installed") {
      manifest[id].status = "installed";
      manifest[id].downloadProgress = 100;
      updated = true;
    } else if (!fileExists && manifest[id].status === "installed") {
      manifest[id].status = "not_downloaded";
      manifest[id].downloadProgress = 0;
      updated = true;
    }
  }

  if (updated) {
    saveManifest(manifest);
  }

  return manifest;
}

function saveManifest(manifest: Record<string, ModelManifestEntry>) {
  try {
    fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2), "utf8");
  } catch (e) {
    console.error("[llama-server] Failed to save manifest:", e);
  }
}

/**
 * Returns a list of all models and their current manifest details.
 */
export function listModels(): ModelManifestEntry[] {
  return Object.values(getManifest());
}

/**
 * Checks if the llama-server binary is installed and callable on the system.
 * Returns true if local prebuilt binary exists or if system-wide command is on PATH.
 */
export function isLlamaServerInstalled(): boolean {
  if (fs.existsSync(LOCAL_BIN_PATH)) {
    // If local binary exists, verify dynamic library on macOS
    if (process.platform === "darwin") {
      const dylib = path.join(LOCAL_BIN_DIR, "libllama-server-impl.dylib");
      if (!fs.existsSync(dylib)) return false; // Incomplete install
    }
    return true;
  }
  try {
    const cmd = process.platform === "win32" ? "where llama-server" : "which llama-server";
    execSync(cmd, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Dynamically finds an open TCP port on localhost.
 */
export async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = addr && typeof addr === "object" ? addr.port : 0;
      server.close(() => {
        if (port) resolve(port);
        else reject(new Error("No port obtained"));
      });
    });
    server.on("error", (err) => reject(err));
  });
}

/**
 * Initiates model download from Hugging Face with progress tracking and speed calculation.
 * Optionally rewrites Hugging Face URLs to High-Speed Mirror hf-mirror.com.
 */
export async function installModel(
  modelId: string,
  winGetter: () => BrowserWindow | null,
  useMirror?: boolean
): Promise<void> {
  const manifest = getManifest();
  const entry = manifest[modelId];
  if (!entry) {
    throw new Error(`Model ${modelId} is not supported.`);
  }

  if (entry.status === "downloading") {
    throw new Error(`Model ${modelId} is already downloading.`);
  }

  // Reset status
  entry.status = "downloading";
  entry.downloadProgress = 0;
  entry.error = undefined;
  saveManifest(manifest);

  const destPath = entry.path;
  const tempPath = `${destPath}.tmp`;

  // Start download in background
  const downloadPromise = new Promise<void>((resolve, reject) => {
    let lastBytes = 0;
    let lastTime = Date.now();
    let speed = "0 KB/s";

    function broadcastProgress(bytesReceived: number, bytesTotal: number) {
      const now = Date.now();
      const duration = (now - lastTime) / 1000;
      if (duration >= 1) {
        const delta = bytesReceived - lastBytes;
        lastBytes = bytesReceived;
        lastTime = now;

        const mbs = (delta / 1024 / 1024) / duration;
        speed = `${mbs.toFixed(1)} MB/s`;
      }

      const progress = bytesTotal > 0 ? Math.min(100, Math.round((bytesReceived / bytesTotal) * 100)) : 0;
      
      // Update local state in manifest
      const liveManifest = getManifest();
      if (liveManifest[modelId] && liveManifest[modelId].status === "downloading") {
        liveManifest[modelId].downloadProgress = progress;
        liveManifest[modelId].downloadSpeed = speed;
        saveManifest(liveManifest);
      }

      const win = winGetter();
      if (win && !win.isDestroyed()) {
        win.webContents.send("llama:download-progress", {
          modelId,
          progress,
          speed,
          bytesReceived,
          bytesTotal,
          status: "downloading"
        });
      }
    }

    function download(url: string) {
      const req = https.get(url, (res) => {
        // Handle HTTP Redirects
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          let redirectUrl = res.headers.location;
          if (useMirror) {
            // ONLY rewrite the CDN URLs to their hf-mirror equivalents, do not rewrite page-level resolvers
            if (redirectUrl.includes("cdn-lfs.huggingface.co")) {
              redirectUrl = redirectUrl.replace("cdn-lfs.huggingface.co", "cdn-lfs.hf-mirror.com");
            }
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
          broadcastProgress(receivedBytes, totalBytes);
        });

        res.on("end", () => {
          fileStream.end();
          resolve();
        });

        res.on("error", (err) => {
          fileStream.close();
          fs.unlink(tempPath, () => {});
          reject(err);
        });
      });

      req.on("error", (err) => {
        reject(err);
      });

      activeRequests.set(modelId, req);
    }

    const sourceUrl = useMirror
      ? entry.downloadUrl.replace("https://huggingface.co", "https://hf-mirror.com")
      : entry.downloadUrl;

    download(sourceUrl);
  });

  downloadPromise
    .then(() => {
      activeRequests.delete(modelId);
      
      // Move temp file to final destination
      if (fs.existsSync(tempPath)) {
        fs.renameSync(tempPath, destPath);
      }

      const liveManifest = getManifest();
      liveManifest[modelId].status = "installed";
      liveManifest[modelId].downloadProgress = 100;
      liveManifest[modelId].downloadSpeed = undefined;
      saveManifest(liveManifest);

      const win = winGetter();
      if (win && !win.isDestroyed()) {
        win.webContents.send("llama:download-progress", {
          modelId,
          progress: 100,
          status: "installed"
        });
      }
    })
    .catch((err) => {
      activeRequests.delete(modelId);
      
      // Clean up temp file
      if (fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath);
      }

      const liveManifest = getManifest();
      // If was aborted manually, change status to not_downloaded, otherwise error
      if (err.message === "aborted" || err.code === "ECONNRESET") {
        liveManifest[modelId].status = "not_downloaded";
        liveManifest[modelId].downloadProgress = 0;
      } else {
        liveManifest[modelId].status = "error";
        liveManifest[modelId].error = err.message;
      }
      liveManifest[modelId].downloadSpeed = undefined;
      saveManifest(liveManifest);

      const win = winGetter();
      if (win && !win.isDestroyed()) {
        win.webContents.send("llama:download-progress", {
          modelId,
          progress: 0,
          status: liveManifest[modelId].status,
          error: err.message
        });
      }
    });
}

/**
 * Removes a downloaded GGUF file from disk and updates the manifest.
 * Aborts download if active. Locks model if it is currently running.
 */
export function removeModel(modelId: string): void {
  const manifest = getManifest();
  const entry = manifest[modelId];
  if (!entry) return;

  if (activeModelId === modelId && serverProcess) {
    throw new Error(`Model ${entry.name} is currently running and active. Stop the local server before deleting it.`);
  }

  // Cancel download if in progress
  const activeReq = activeRequests.get(modelId);
  if (activeReq) {
    activeReq.destroy();
    activeRequests.delete(modelId);
  }

  if (fs.existsSync(entry.path)) {
    fs.unlinkSync(entry.path);
  }

  const tempPath = `${entry.path}.tmp`;
  if (fs.existsSync(tempPath)) {
    fs.unlinkSync(tempPath);
  }

  entry.status = "not_downloaded";
  entry.downloadProgress = 0;
  entry.downloadSpeed = undefined;
  entry.error = undefined;
  saveManifest(manifest);
}

/**
 * Bulk clear all inactive GGUF files to reclaim disk space.
 */
export function clearInactiveModels(): void {
  const manifest = getManifest();
  for (const [id, entry] of Object.entries(manifest)) {
    if (entry.status === "installed" && id !== activeModelId) {
      removeModel(id);
    }
  }
}

/**
 * Shuts down the running llama-server process.
 */
export async function stopServer(): Promise<void> {
  if (serverProcess) {
    serverProcess.kill("SIGTERM");
    
    // Wait for process to exit
    await new Promise<void>((resolve) => {
      let limit = 15;
      const interval = setInterval(() => {
        if (!serverProcess || serverProcess.killed) {
          clearInterval(interval);
          resolve();
        } else if (limit-- <= 0) {
          serverProcess.kill("SIGKILL");
          clearInterval(interval);
          resolve();
        }
      }, 200);
    });

    serverProcess = null;
    serverPort = null;
    activeModelId = null;
    console.log("[llama-server] Stopped server process.");
  }
}

/**
 * Starts the llama-server child process on a dynamic port with the selected model.
 */
export async function startServer(modelId: string): Promise<number> {
  const manifest = getManifest();
  const entry = manifest[modelId];
  if (!entry || entry.status !== "installed") {
    throw new Error(`Model ${modelId} is not downloaded.`);
  }

  if (!isLlamaServerInstalled()) {
    throw new Error("llama-server is not installed on your system. Run 'brew install llama.cpp' or click Download Engine.");
  }

  // If already running on this model, just return the port
  if (serverProcess && activeModelId === modelId && serverPort) {
    // Check if truly healthy
    const healthy = await checkHealth(serverPort);
    if (healthy) return serverPort;
    // Otherwise clean up and reboot
    await stopServer();
  } else if (serverProcess) {
    // Stop server running a different model
    await stopServer();
  }

  const port = await findFreePort();
  console.log(`[llama-server] Starting llama-server with ${entry.name} on 127.0.0.1:${port}...`);

  const processArgs = [
    "-m", entry.path,
    "--port", port.toString(),
    "--host", "127.0.0.1",
    "-c", "32768", // default context size (32k)
    "--no-warmup"
  ];

  // Prefer local prebuilt binary if present
  const binaryPath = fs.existsSync(LOCAL_BIN_PATH) ? LOCAL_BIN_PATH : "llama-server";

  const child = spawn(binaryPath, processArgs, {
    stdio: ["ignore", "pipe", "pipe"],
    detached: false
  });

  let bootError = "";
  child.stderr.on("data", (data) => {
    bootError += data.toString();
  });

  child.stdout.on("data", (data) => {
    console.log("[llama-server stdout]:", data.toString().trim());
  });

  // Track state
  serverProcess = child;
  serverPort = port;
  activeModelId = modelId;

  // Wait for health check success
  let isHealthy = false;
  for (let i = 0; i < 300; i++) {
    if (child.killed || child.exitCode !== null) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    isHealthy = await checkHealth(port);
    if (isHealthy) break;
  }

  if (!isHealthy) {
    const code = child.exitCode;
    await stopServer();
    throw new Error(`llama-server failed to start (exit code ${code}). Stderr:\n${bootError.slice(-500)}`);
  }

  console.log("[llama-server] Server successfully started and healthy.");
  return port;
}

/**
 * Tests if the llama-server is running and responding.
 */
async function checkHealth(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/health`, {
      timeout: 1000
    } as any, (res) => {
      resolve(res.statusCode === 200);
    });
    
    // Check http or net level
    req.on("error", () => {
      // Fallback direct socket test
      const socket = new net.Socket();
      socket.setTimeout(500);
      socket.connect(port, "127.0.0.1", () => {
        socket.destroy();
        resolve(true);
      });
      socket.on("error", () => {
        resolve(false);
      });
      socket.on("timeout", () => {
        socket.destroy();
        resolve(false);
      });
    });
  });
}

/**
 * Returns full status of the local server.
 */
export async function getServerStatus() {
  const running = serverProcess !== null && !serverProcess.killed;
  const isHealthy = running && serverPort ? await checkHealth(serverPort) : false;
  return {
    running: running && isHealthy,
    port: running && isHealthy ? serverPort : null,
    activeModelId: running && isHealthy ? activeModelId : null,
    installed: isLlamaServerInstalled(),
    error: null
  };
}

export function getLlamaServerPort(): number | null {
  return serverPort;
}

export function getActiveModelId(): string | null {
  return activeModelId;
}

/**
 * Automatically starts the server with the first available downloaded model if not already running.
 */
export async function ensureLlamaServerRunning(): Promise<number> {
  if (serverProcess && serverPort && activeModelId) {
    const isHealthy = await checkHealth(serverPort);
    if (isHealthy) return serverPort;
  }

  // Find first installed model
  const manifest = getManifest();
  const installedEntry = Object.values(manifest).find((entry) => entry.status === "installed");
  if (!installedEntry) {
    throw new Error("No local Gemma 4 models are downloaded. Please go to Settings → AI & Chat to download a model first.");
  }

  return await startServer(installedEntry.id);
}

/**
 * Automated prebuilt llama-server binary installer.
 * Pulls the latest asset from GitHub ggml-org/llama.cpp, unpacks tar.gz/zip natively,
 * makes it executable, and strips the macOS Gatekeeper quarantine tag.
 */
export async function installLlamaBinary(winGetter: () => BrowserWindow | null): Promise<void> {
  if (isBinaryDownloading) {
    throw new Error("Local Llama engine downloader is already active.");
  }

  if (!fs.existsSync(LOCAL_BIN_DIR)) {
    fs.mkdirSync(LOCAL_BIN_DIR, { recursive: true });
  }

  isBinaryDownloading = true;
  const win = winGetter();

  const sendProgress = (progress: number, speed: string, status: string, error?: string) => {
    if (win && !win.isDestroyed()) {
      win.webContents.send("llama:binary-progress", { progress, speed, status, error });
    }
  };

  sendProgress(0, "0 KB/s", "fetching_release");

  try {
    // 1. Fetch latest release assets list from GitHub API
    const releaseUrl = "https://api.github.com/repos/ggml-org/llama.cpp/releases/latest";
    const releaseData = await fetchGitHubJson<any>(releaseUrl);
    
    // 2. Resolve matching native compiled prebuilt binary package
    const assets: any[] = releaseData.assets || [];
    let regex: RegExp;
    let archiveExt: ".tar.gz" | ".zip";

    if (process.platform === "darwin") {
      archiveExt = ".tar.gz";
      if (process.arch === "arm64") {
        // Prefer apple silicon binary, bypass specialized aarch64 flavors
        regex = /llama-.*-bin-macos-arm64(?!-kleidiai)\.tar\.gz$/;
      } else {
        regex = /llama-.*-bin-macos-x64\.tar\.gz$/;
      }
    } else if (process.platform === "win32") {
      archiveExt = ".zip";
      regex = /llama-.*-bin-win-cpu-x64\.zip$/;
    } else {
      // Ubuntu / generic Linux fallback
      archiveExt = ".tar.gz";
      regex = /llama-.*-bin-ubuntu-x64\.tar\.gz$/;
    }

    const asset = assets.find((a) => regex.test(a.name));
    if (!asset) {
      throw new Error(`Could not find prebuilt llama-server for platform ${process.platform}-${process.arch} in ggml-org/llama.cpp releases.`);
    }

    const downloadUrl = asset.browser_download_url;
    const tempArchive = path.join(LOCAL_BIN_DIR, `temp${archiveExt}`);

    sendProgress(5, "0 KB/s", "downloading");

    // 3. Download the native prebuilt zip/tar.gz archive
    await new Promise<void>((resolve, reject) => {
      let lastBytes = 0;
      let lastTime = Date.now();
      let speed = "0 KB/s";

      function download(url: string) {
        const options: https.RequestOptions = {
          headers: {
            "User-Agent": "Cairn-Client/1.0"
          }
        };

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
            sendProgress(pct, speed, "downloading");
          });

          res.on("end", () => {
            fileStream.end();
            resolve();
          });

          res.on("error", (err) => {
            fileStream.close();
            fs.unlink(tempArchive, () => {});
            reject(err);
          });
        });

        req.on("error", (err) => {
          reject(err);
        });
      }

      download(downloadUrl);
    });

    sendProgress(90, "0 KB/s", "extracting");

    // 4. Extract archive to temporary folder
    const extractDir = path.join(LOCAL_BIN_DIR, "extracted");
    if (fs.existsSync(extractDir)) {
      fs.rmSync(extractDir, { recursive: true, force: true });
    }
    fs.mkdirSync(extractDir, { recursive: true });

    await new Promise<void>((resolve, reject) => {
      let command = "";
      if (process.platform === "win32") {
        command = `tar -xf "${tempArchive}" -C "${extractDir}"`;
      } else {
        command = `tar -xzf "${tempArchive}" -C "${extractDir}"`;
      }

      exec(command, (err) => {
        if (err) {
          if (process.platform === "win32") {
            // PowerShell extract fallback
            const psCommand = `powershell -Command "Expand-Archive -Path '${tempArchive}' -DestinationPath '${extractDir}' -Force"`;
            exec(psCommand, (psErr) => {
              if (psErr) reject(new Error(`Extraction failed: ${psErr.message}`));
              else resolve();
            });
          } else {
            reject(new Error(`Extraction failed: ${err.message}`));
          }
        } else {
          resolve();
        }
      });
    });

    // 5. Recursively search extracted files for the target llama-server executable
    const binaryName = process.platform === "win32" ? "llama-server.exe" : "llama-server";
    let foundPath: string | null = null;

    function searchDir(dir: string) {
      if (foundPath) return;
      const items = fs.readdirSync(dir);
      for (const item of items) {
        const full = path.join(dir, item);
        const stat = fs.statSync(full);
        if (stat.isDirectory()) {
          searchDir(full);
        } else if (item === binaryName) {
          foundPath = full;
          return;
        }
      }
    }

    searchDir(extractDir);

    if (!foundPath) {
      throw new Error(`Could not find ${binaryName} inside downloaded archive.`);
    }

    // 5.1 Copy all adjacent files (shared libraries .dylib / .so / .dll) to LOCAL_BIN_DIR
    const binParentDir = path.dirname(foundPath);
    const files = fs.readdirSync(binParentDir);
    
    for (const file of files) {
      const srcPath = path.join(binParentDir, file);
      const destPath = path.join(LOCAL_BIN_DIR, file);
      
      const stat = fs.statSync(srcPath);
      if (stat.isFile()) {
        if (fs.existsSync(destPath)) {
          fs.unlinkSync(destPath);
        }
        fs.copyFileSync(srcPath, destPath);
        
        // 6. Set execute permissions on Unix and strip macOS Gatekeeper quarantine tag
        if (process.platform !== "win32") {
          fs.chmodSync(destPath, "755");
          if (process.platform === "darwin") {
            try {
              execSync(`xattr -rd com.apple.quarantine "${destPath}"`, { stdio: "ignore" });
            } catch (xattrErr) {
              console.warn(`[llama-server] Failed to clear macOS quarantine attribute on ${file}:`, xattrErr);
            }
          }
        }
      }
    }

    // 7. Write engine metadata
    const engineMetaPath = path.join(LOCAL_BIN_DIR, "engine.json");
    fs.writeFileSync(engineMetaPath, JSON.stringify({
      version: releaseData.tag_name || "unknown",
      installedAt: new Date().toISOString()
    }, null, 2), "utf8");

    // 8. Cleanup temp files
    fs.unlinkSync(tempArchive);
    fs.rmSync(extractDir, { recursive: true, force: true });

    isBinaryDownloading = false;
    sendProgress(100, "", "installed");
    console.log(`[llama-server] Native Local Engine installed successfully at: ${LOCAL_BIN_PATH}`);
  } catch (err: any) {
    isBinaryDownloading = false;
    sendProgress(0, "", "error", err.message);
    console.error("[llama-server] Native prebuilt installer failed:", err);
    throw err;
  }
}

/**
 * Standard HTTP JSON GET helper. Set User-Agent as required by GitHub API.
 */
async function fetchGitHubJson<T>(url: string): Promise<T> {
  return new Promise((resolve, reject) => {
    function get(currentUrl: string) {
      const options: https.RequestOptions = {
        headers: {
          "User-Agent": "Cairn-Client/1.0",
          "Accept": "application/json"
        }
      };

      https.get(currentUrl, options, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          get(res.headers.location);
          return;
        }

        if (res.statusCode !== 200) {
          reject(new Error(`GitHub responded with status ${res.statusCode}`));
          return;
        }

        let body = "";
        res.on("data", (chunk) => body += chunk);
        res.on("end", () => {
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(e);
          }
        });
      }).on("error", (err) => reject(err));
    }
    get(url);
  });
}

/**
 * Reads local engine.json metadata.
 */
export function getInstalledLlamaVersion(): string | null {
  const engineMetaPath = path.join(LOCAL_BIN_DIR, "engine.json");
  if (fs.existsSync(engineMetaPath)) {
    try {
      const meta = JSON.parse(fs.readFileSync(engineMetaPath, "utf8"));
      return meta.version || null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Contacts GitHub to check if a new llama-server release is available.
 */
export async function checkLlamaUpdates(): Promise<{ updateAvailable: boolean; currentVersion: string | null; latestVersion: string | null }> {
  const currentVersion = getInstalledLlamaVersion();
  try {
    const releaseUrl = "https://api.github.com/repos/ggml-org/llama.cpp/releases/latest";
    const releaseData = await fetchGitHubJson<any>(releaseUrl);
    const latestVersion = releaseData.tag_name || null;
    
    if (!latestVersion) {
      return { updateAvailable: false, currentVersion, latestVersion: null };
    }
    
    // If not installed, or versions differ
    const updateAvailable = !currentVersion || currentVersion !== latestVersion;
    
    return {
      updateAvailable,
      currentVersion,
      latestVersion
    };
  } catch (err) {
    console.error("[llama-server] Failed to check for engine updates:", err);
    return {
      updateAvailable: false,
      currentVersion,
      latestVersion: null
    };
  }
}

/**
 * Stops the llama-server process synchronously on app exit.
 */
export function stopServerSync(): void {
  if (serverProcess) {
    try {
      serverProcess.kill("SIGKILL");
      console.log("[llama-server] Stopped server process synchronously on app exit.");
    } catch (e) {
      console.error("[llama-server] Failed to stop server process synchronously:", e);
    }
    serverProcess = null;
    serverPort = null;
    activeModelId = null;
  }
}
