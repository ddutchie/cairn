/**
 * Platform capability probes for tests. Windows only lets a process create
 * symlinks with admin rights or Developer Mode, so symlink tests probe once and
 * skip (`it.skipIf(!CAN_SYMLINK)`) where that is unavailable; POSIX always can.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function probeSymlink(): boolean {
  if (process.platform !== "win32") return true;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "symlink-probe-"));
  try {
    fs.writeFileSync(path.join(dir, "target"), "");
    fs.symlinkSync(path.join(dir, "target"), path.join(dir, "link"));
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export const CAN_SYMLINK = probeSymlink();
