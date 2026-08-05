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
    // Setup-Hooks der Integrationstests werfen das Schema weg und fahren die
    // gesamte Migrationskette neu hoch. Deren Dauer wächst mit jeder Migration,
    // der Standard-Timeout von 10 s aber nicht — email-change.test.ts lief
    // deshalb sporadisch in einen beforeAll-Timeout, einzeln aber grün. Ein
    // roter Lauf ohne echten Fehler ist teurer als eine großzügige Schranke:
    // Er wird beim nächsten Mal weggeklickt, und dann fällt ein echter Fehler
    // auch nicht mehr auf.
    hookTimeout: 60_000,
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
