/**
 * Despliega el Worker: `opennextjs-cloudflare build` y luego `deploy --keep-vars`.
 *
 * Existe por un motivo concreto. El binding `hyperdrive` de `wrangler.jsonc` obliga a
 * que `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE` esté en el entorno
 * cuando arranca el CLI, porque el `applyHyperdriveEnvVars` de wrangler lee esa
 * variable **solo de `process.env`** y no mira ningún fichero: tenerla en `.dev.vars`
 * no basta. El valor se guarda ahí —que no se versiona, lleva la contraseña— y este
 * script lo pasa al proceso hijo.
 *
 * Por qué un envoltorio y no `node --import`: el binario `opennextjs-cloudflare` es
 * un shim de npm en `node_modules/.bin`, no un módulo que `node` pueda resolver, así
 * que `node --import ... opennextjs-cloudflare` muere con `ERR_MODULE_NOT_FOUND`. Aquí
 * se invoca el punto de entrada real con el mismo `process.execPath`, que además
 * evita el `shell: true` que en Windows haría falta para los shims `.cmd`.
 *
 * `--keep-vars` es lo que OpenNext recomienda para que un despliegue no borre las
 * variables y secretos que están en el panel del Worker.
 */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const RAIZ = resolve(fileURLToPath(new URL("..", import.meta.url)));
const PREFIX = "CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_";

/** Lee un `.env`/`.dev.vars` sencillo: `CLAVE=valor`, `#` de comentario, comillas opcionales. */
function leerVars(path) {
  let raw;

  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return new Map();
  }

  const valores = new Map();

  for (const linea of raw.split("\n")) {
    const limpia = linea.trim();

    if (limpia === "" || limpia.startsWith("#")) {
      continue;
    }

    const separador = limpia.indexOf("=");

    if (separador === -1) {
      continue;
    }

    valores.set(
      limpia.slice(0, separador).trim(),
      limpia
        .slice(separador + 1)
        .trim()
        .replace(/^["']|["']$/g, ""),
    );
  }

  return valores;
}

for (const [nombre, valor] of leerVars(resolve(RAIZ, ".dev.vars"))) {
  // Una variable ya presente en el entorno gana, para poder fijarla sin tocar ficheros.
  if (nombre.startsWith(PREFIX) && process.env[nombre] === undefined) {
    process.env[nombre] = valor;
  }
}

if (process.env[`${PREFIX}HYPERDRIVE`] === undefined) {
  console.warn(
    `[deploy] No hay ninguna ${PREFIX}<BINDING> en .dev.vars ni en el entorno, y el bloque ` +
      "`hyperdrive` de wrangler.jsonc esta activo: el despliegue fallara al emular el binding.",
  );
}

/**
 * Punto de entrada del CLI, deducido del paquete instalado.
 *
 * Se pide el `bin` del propio `package.json` en vez de escribir `dist/cli/index.js` a
 * mano: el mapa de `exports` del paquete solo expone `.` y `./*` bajo `dist/api/`, así
 * que `require.resolve("@opennextjs/cloudflare/cli")` no resolvería, y una ruta fija
 * se quedaría obsoleta en cuanto el paquete moviera el fichero.
 */
const require = createRequire(import.meta.url);
const entrada = require.resolve("@opennextjs/cloudflare");
const raizPaquete = resolve(dirname(entrada), "..", "..");
const { bin } = JSON.parse(readFileSync(resolve(raizPaquete, "package.json"), "utf8"));
const cli = resolve(raizPaquete, bin["opennextjs-cloudflare"]);

const hijo = spawn(process.execPath, [cli, "deploy", "--keep-vars"], {
  cwd: RAIZ,
  stdio: "inherit",
  env: process.env,
});

hijo.on("error", (error) => {
  console.error(`[deploy] No se ha podido lanzar el CLI de OpenNext: ${error.message}`);
  process.exit(1);
});

hijo.on("exit", (codigo, senal) => {
  if (senal !== null) {
    console.error(`[deploy] El CLI de OpenNext ha terminado por ${senal}.`);
    process.exit(1);
  }

  process.exit(codigo ?? 1);
});
