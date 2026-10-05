import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

/**
 * Runner de los tests.
 *
 * Los tests van **junto al código que prueban** (`src/lib/scoring.test.ts` al
 * lado de `src/lib/scoring.ts`), no en una carpeta central: el que retoca un
 * módulo tiene que ver, en el mismo `git diff`, qué se comprobó de él.
 */
export default defineConfig({
  resolve: {
    // El mismo alias que declara `tsconfig.json`, puesto a mano para no añadir
    // `vite-tsconfig-paths` por una sola entrada.
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    /**
     * `server-only` es el marcador que Next usa para impedir que un módulo de
     * servidor llegue a un Client Component, y su entrada por defecto **lanza** al
     * importarse. Varios de los módulos que se prueban aquí (`scoring.ts`,
     * `ranked-match.ts`, `objectives.ts`) lo llevan puesto, así que sin esto no se
     * podrían ni importar.
     *
     * Se apunta al `empty.js` que el propio paquete publica: es literalmente lo que
     * su `exports` devuelve con la condición `react-server`, la misma con la que
     * corren los scripts de `scripts/` (`tsx --conditions=react-server`). La ruta
     * es la de `node_modules` en la raíz, que es la que produce el `npm install` y
     * la que usan el `npm ci` de la CI y el de la imagen de Docker.
     */
    alias: {
      "server-only": fileURLToPath(new URL("./node_modules/server-only/empty.js", import.meta.url)),
    },
    /**
     * Solo se recogen tests del proyecto y bajo `src/`. Sin este `include`,
     * Vitest entraría también en `.open-next/`, donde el build de OpenNext copia
     * las dependencias con sus `*.test.js` (113 ficheros hoy): no son código
     * nuestro y no tienen nada que ver con el torneo.
     */
    include: ["src/**/*.test.ts"],
    /**
     * Los directorios de salida del proyecto se excluyen **explícitamente** y no
     * solo por acierto: se regeneran con cada build, y un cambio en ellos no
     * debe poder cambiar qué se ejecuta.
     */
    exclude: [
      ...configDefaults.exclude,
      "**/.open-next/**",
      "**/.next/**",
      "**/.wrangler/**",
      "scripts/**",
    ],
    /**
     * Sin DOM: los tests son funciones puras de `src/lib`, sin red, sin
     * temporizadores reales y sin variables de entorno.
     */
    environment: "node",
    /**
     * Cada fichero de test corre en su propio proceso: es el nivel de aislamiento
     * por defecto, y además lo que hace que un resultado no dependa de lo que otro
     * fichero deje a medias.
     */
    pool: "forks",
  },
});
