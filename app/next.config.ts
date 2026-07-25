import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Standalone-Output für schlanke Docker-Images (P0-4 Staging-Deployment):
  // .next/standalone enthält server.js + minimale node_modules.
  output: "standalone",

  // Statisches Pitch-Deck unter /praesentation (app/public/praesentation/):
  // Ohne diese Umschreibung würde der extensionslose Pfad `/praesentation`
  // von der dynamischen Root-Route `[tenant]` als Tenant-Slug verschluckt
  // (und liefe ins Leere). `beforeFiles` greift VOR dem Dateisystem und den
  // dynamischen Routen und liefert dafür die statische index.html aus.
  // (Die Middleware lässt `praesentation` bereits aus dem Subdomain-Rewrite
  //  aus — beide Änderungen zusammen machen das Deck tenant-unabhängig.)
  async rewrites() {
    return {
      beforeFiles: [
        {
          source: "/praesentation",
          destination: "/praesentation/index.html",
        },
      ],
      afterFiles: [],
      fallback: [],
    };
  },
};

export default nextConfig;
