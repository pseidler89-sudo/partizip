import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    // Gebietsbaum-Provisioning-Netz für die Test-DB freigeben (Gate-B MINOR):
    // in Produktion ist das Netz per GUC aus, Tests brauchen es aber.
    setupFiles: ["./vitest.setup.ts"],
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
    // Sequentielle Ausführung: Integrationstests teilen dieselbe Test-DB
    // und würden sich bei paralleler Ausführung gegenseitig beim Schema-Reset stören.
    pool: "forks",
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
