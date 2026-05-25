import { describe, it, expect, vi, beforeEach } from "vitest";
import * as path from "path";

// 1. Mock electron first to resolve module-level constants
vi.mock("electron", () => {
  return {
    app: {
      getPath: (key: string) => {
        if (key === "userData") {
          return "/tmp/llama-server-test-userdata";
        }
        return `/mock/${key}`;
      }
    },
    BrowserWindow: class {}
  };
});

// 2. Setup Virtual Filesystem for fs mock
let virtualFs: Record<string, string | boolean> = {};

vi.mock("fs", () => {
  return {
    existsSync: vi.fn((p: string) => {
      return !!virtualFs[p];
    }),
    readFileSync: vi.fn((p: string) => {
      if (virtualFs[p]) {
        return virtualFs[p] as string;
      }
      throw new Error(`ENOENT: no such file or directory, open '${p}'`);
    }),
    writeFileSync: vi.fn((p: string, content: string) => {
      virtualFs[p] = content;
    }),
    mkdirSync: vi.fn(),
    unlinkSync: vi.fn((p: string) => {
      delete virtualFs[p];
    }),
    statSync: vi.fn((p: string) => {
      if (virtualFs[p]) {
        return {
          isFile: () => true,
          isDirectory: () => false
        };
      }
      throw new Error(`ENOENT: no such file or directory, stat '${p}'`);
    })
  };
});

// 3. Mock child_process for command verification
let mockExecSyncShouldThrow = false;
let mockExecSyncResult = "";
let spawnedProcess: any = null;

vi.mock("child_process", () => {
  return {
    execSync: vi.fn(() => {
      if (mockExecSyncShouldThrow) throw new Error("Command failed");
      return mockExecSyncResult;
    }),
    exec: vi.fn((cmd, cb) => {
      cb(null, "success", "");
    }),
    spawn: vi.fn((bin, args) => {
      spawnedProcess = {
        kill: vi.fn((sig) => {
          spawnedProcess.killed = true;
          spawnedProcess.exitCode = 0;
        }),
        killed: false,
        exitCode: null,
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() }
      };
      return spawnedProcess;
    })
  };
});

// 4. Mock https to isolate network checks
let mockGitHubResponse: any = { tag_name: "b2984", assets: [] };

vi.mock("https", () => {
  return {
    get: vi.fn((url: string, options: any, callback: any) => {
      let cb = callback;
      if (typeof options === "function") {
        cb = options;
      }
      
      const res = {
        statusCode: 200,
        headers: {},
        on: (event: string, handler: any) => {
          if (event === "data") {
            handler(Buffer.from(JSON.stringify(mockGitHubResponse)));
          }
          if (event === "end") {
            handler();
          }
        }
      };
      cb(res);
      return { on: vi.fn() };
    })
  };
});

// 5. Mock http to intercept server health checks and make them succeed instantly
vi.mock("http", () => {
  return {
    get: vi.fn((url: string, options: any, callback: any) => {
      let cb = callback;
      if (typeof options === "function") {
        cb = options;
      }
      
      cb({
        statusCode: 200
      });
      return { on: vi.fn() };
    })
  };
});

import {
  listModels,
  isLlamaServerInstalled,
  findFreePort,
  checkLlamaUpdates,
  startServer,
  stopServerSync
} from "./llama-server";

const TEST_USER_DATA = "/tmp/llama-server-test-userdata";
const TEST_MANIFEST_PATH = path.join(TEST_USER_DATA, "llama-models", "manifest.json");
const TEST_LOCAL_BIN_PATH = path.join(TEST_USER_DATA, "llama-bin", process.platform === "win32" ? "llama-server.exe" : "llama-server");

describe("Local Llama Server Manager", () => {
  beforeEach(() => {
    virtualFs = {};
    mockExecSyncShouldThrow = false;
    mockExecSyncResult = "";
    spawnedProcess = null;
    vi.clearAllMocks();
  });

  describe("Manifest Manager (listModels)", () => {
    it("initializes a default manifest and list of supported models when manifest.json does not exist", () => {
      const models = listModels();
      expect(models.length).toBeGreaterThan(0);
      expect(models[0].status).toBe("not_downloaded");
      expect(virtualFs[TEST_MANIFEST_PATH]).toBeDefined();
    });

    it("restores active status for files that exist on disk", () => {
      // Simulate that a model file actually exists on disk
      const models = listModels();
      const firstModel = models[0];
      virtualFs[firstModel.path] = "gguf-file-mock-data";

      // Call listModels again, it should read and update its status
      const updatedModels = listModels();
      const updatedFirst = updatedModels.find(m => m.id === firstModel.id);
      expect(updatedFirst?.status).toBe("installed");
      expect(updatedFirst?.downloadProgress).toBe(100);
    });
  });

  describe("Installation Detector (isLlamaServerInstalled)", () => {
    it("returns true if local prebuilt binary exists (and shared library on macOS)", () => {
      virtualFs[TEST_LOCAL_BIN_PATH] = "binary-data";
      if (process.platform === "darwin") {
        const dylib = path.join(TEST_USER_DATA, "llama-bin", "libllama-server-impl.dylib");
        virtualFs[dylib] = "dylib-data";
      }

      expect(isLlamaServerInstalled()).toBe(true);
    });

    it("checks the system PATH if no local prebuilt binary exists", () => {
      mockExecSyncResult = "/usr/local/bin/llama-server";
      expect(isLlamaServerInstalled()).toBe(true);
    });

    it("returns false if neither local binary nor system commands exist", () => {
      mockExecSyncShouldThrow = true;
      expect(isLlamaServerInstalled()).toBe(false);
    });
  });

  describe("Port Finder (findFreePort)", () => {
    it("returns a valid dynamic TCP port", async () => {
      const port = await findFreePort();
      expect(port).toBeGreaterThan(0);
      expect(port).toBeLessThan(65536);
    });
  });

  describe("Update Checker (checkLlamaUpdates)", () => {
    it("detects when updates are available by comparing manifest versions", async () => {
      // Setup installed version metadata file
      const engineMetaPath = path.join(TEST_USER_DATA, "llama-bin", "engine.json");
      virtualFs[engineMetaPath] = JSON.stringify({ version: "b2900" });

      mockGitHubResponse = { tag_name: "b2984", assets: [] };

      const res = await checkLlamaUpdates();
      expect(res.updateAvailable).toBe(true);
      expect(res.currentVersion).toBe("b2900");
      expect(res.latestVersion).toBe("b2984");
    });

    it("reports no updates when local version matches GitHub releases", async () => {
      const engineMetaPath = path.join(TEST_USER_DATA, "llama-bin", "engine.json");
      virtualFs[engineMetaPath] = JSON.stringify({ version: "b2984" });

      mockGitHubResponse = { tag_name: "b2984", assets: [] };

      const res = await checkLlamaUpdates();
      expect(res.updateAvailable).toBe(false);
    });
  });

  describe("Server Process Lifecycle Controls", () => {
    it("starts and then kills the background process synchronously on app quit", async () => {
      // 1. Setup local environment structure
      virtualFs[TEST_LOCAL_BIN_PATH] = "binary-data";
      if (process.platform === "darwin") {
        const dylib = path.join(TEST_USER_DATA, "llama-bin", "libllama-server-impl.dylib");
        virtualFs[dylib] = "dylib-data";
      }

      // Add a model file to the virtual filesystem
      const models = listModels();
      const firstModel = models[0];
      virtualFs[firstModel.path] = "gguf-data";
      
      // Reload models list so that listModels picks up GGUF existence
      listModels();

      // 2. Start the local server process
      const port = await startServer(firstModel.id);
      expect(port).toBeGreaterThan(0);
      expect(spawnedProcess).toBeDefined();

      // 3. Trigger synchronous exit cleanup
      stopServerSync();

      expect(spawnedProcess.kill).toHaveBeenCalledWith("SIGKILL");
    });
  });
});
