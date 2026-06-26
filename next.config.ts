import type { NextConfig } from "next";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { version } = require("./package.json") as { version: string };

const isElectronBuild = process.env.ELECTRON_BUILD === "true";

const nextConfig: NextConfig = {
  env: {
    NEXT_PUBLIC_APP_VERSION: version,
  },
  typescript: {
    // Type checking is already handled in CI via 'npm run type-check:all'.
    // Disabling it during build speeds up packaging and avoids random TSC hangs on CI.
    ignoreBuildErrors: true,
  },
  // Static export for Electron — the main process loads index.html directly.
  // Only applied when building for Electron; web dev mode stays as-is.
  ...(isElectronBuild && {
    output: "export",
    // Static export can't use Next.js Image Optimization
    images: { unoptimized: true },
    // Electron loads files from disk, not a server — trailing slash keeps
    // relative asset paths working correctly.
    trailingSlash: true,
  }),
};

export default nextConfig;
