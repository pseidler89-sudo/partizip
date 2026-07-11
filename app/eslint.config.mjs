import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
  // Konvention: mit `_` präfixierte Bindungen sind bewusst ungenutzt (z. B.
  // verworfene Destrukturierungen, Spy-Signaturen in Tests). Standard-Pattern,
  // damit absichtlich Ungenutztes nicht als Warnung rauscht und echte tote
  // Bindungen sichtbar bleiben.
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      // Barrierefreiheits-Gate (SIA Loop 3): eslint-config-next aktiviert nur einen
      // Teil der jsx-a11y-Regeln. Diese beiden adressieren reale, verifizierte
      // Befunde (Formular-Label↔Control-Verknüpfung; Interaktions-Handler auf
      // nicht-interaktiven Elementen) und laufen als harter Fehler. Erweiterung auf
      // die volle recommended-Liste ist ein Folgepunkt (Loop 4 / Report).
      "jsx-a11y/label-has-associated-control": ["error", { depth: 3 }],
      "jsx-a11y/no-noninteractive-element-interactions": "error",
    },
  },
]);

export default eslintConfig;
