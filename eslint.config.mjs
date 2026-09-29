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
    // Salida de `opennextjs-cloudflare build` (preview/deploy): bundle de terceros,
    // no código del proyecto.
    ".open-next/**",
    // Cache de `wrangler dev` / `npm run preview`: bundles intermedios de terceros
    // que wrangler deja en el árbol de trabajo.
    ".wrangler/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Bundles de skills de agentes: markdown y binarios de terceros, no código del proyecto.
    ".agents/**",
    ".opencode/**",
    // Ficheros `.cjs` sueltos en `scripts/`: helpers de ejecución (`--require`),
    // no código del proyecto; no pasan por el linter de TypeScript.
    "scripts/**/*.cjs",
  ]),
]);

export default eslintConfig;
