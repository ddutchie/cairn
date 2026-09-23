/**
 * Packaging bootstrap for dsh-subprocess-local's containment runner, bundled
 * to dist-electron/subprocess-runner.cjs by scripts/compile-electron.js.
 *
 * dsh wraps each subprocess in a runner (a Win32 Job on Windows, a systemd
 * scope on Linux) spawned as `[process.execPath, runner]`. Upstream's desktop
 * app runs its whole Host under ELECTRON_RUN_AS_NODE, so that spawn inherits
 * Node mode. Cairn runs Cordis in the Electron main process instead, so:
 *   - the main bundle's import.meta.resolve shim points the runner at this
 *     file, and
 *   - a build-time patch adds ELECTRON_RUN_AS_NODE=1 to the runner's own
 *     environment only (scripts/compile-electron.js).
 * The target command gets its environment explicitly from the launch request
 * (Win32 CreateProcess / Linux execve), so Node mode never reaches it.
 *
 * Mirrors upstream's `import.meta.main` block in dsh-subprocess-local's
 * runner.js, which doesn't fire once bundled to CJS.
 */
import { runSelectedSubprocessRunner } from "@deepseek-ai/dsh-subprocess-local/runner";

delete process.env.ELECTRON_RUN_AS_NODE;
const selection = process.env.DSH_SUBPROCESS_RUNNER;
delete process.env.DSH_SUBPROCESS_RUNNER;
if (selection === undefined) process.exitCode = 127;
else void runSelectedSubprocessRunner(selection);
