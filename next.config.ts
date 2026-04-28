import type { NextConfig } from "next";

const isElectronBuild = process.env.ELECTRON_BUILD === "true";

const nextConfig: NextConfig = {
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
