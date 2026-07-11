import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Standalone-Output für schlanke Docker-Images (P0-4 Staging-Deployment):
  // .next/standalone enthält server.js + minimale node_modules.
  output: "standalone",
};

export default nextConfig;
