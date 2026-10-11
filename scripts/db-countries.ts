import "./load-env.mjs";

import { readFile } from "node:fs/promises";
import path from "node:path";

import { db } from "@/lib/db";
import {
  REGISTRATION_COUNTRIES_KEY,
  mergeCountries,
  readCountries,
  writeCountries,
} from "@/lib/countries";

/**
 * Publicar en `Setting` la lista de países que admite el torneo.
 *
 *   npm run countries:seed               # siembra la lista de paises.txt
 *   npm run countries:seed -- --show     # solo enseña la lista vigente
 *   npm run countries:seed -- --dry-run  # enseña el cambio y no escribe
 *
 * ## De dónde sale la lista
 *
 * De `paises.txt` en la raíz del repositorio, un país por línea y en UTF-8. El
 * fichero es la fuente de verdad **para sembrar**: es lo que se versiona y lo que se
 * revisa en un *diff*, y el orden es el que ve la persona que se inscribe, así que
 * se respeta tal cual. `DEFAULT_COUNTRIES` lo replica como respaldo para cuando
 * todavía no se ha publicado nada (`npm run verify:sync` comprueba que los dos no
 * divergen).
 *
 * ## Por qué pasa por la validación del módulo
 *
 * Porque publicar una lista que `readCountries()` va a descartar solo mueve el
 * síntoma: el script habría salido con "publicado" y el fallo aparecería después en
 * el formulario de inscripción, como un país que no se puede elegir. El fichero se
 * valida con la **misma** función que usa la web (`mergeCountries()`), así que un
 * elemento que no es un texto o un país repetido salen aquí con su motivo y código
 * 1, sin escribir nada.
 *
 * ## Por qué es un script y no un campo de `/admin`
 *
 * Igual que `db:window`, `db:cron` y `db:security`: cambiar la lista admitida
 * cambia de golpe qué se puede validar en un formulario público, y eso pide una
 * orden explícita con su comprobación previa, no un campo de formulario.
 *
 * ## Idempotente
 *
 * Repetirla con el mismo `paises.txt` no escribe nada y sale con 0: se compara la
 * lista **publicada** con la del fichero y, si son iguales, no hay cambio que
 * hacer. Lo que se compara es la fila de `Setting`, no la lista vigente: mientras
 * no haya fila, `readCountries()` devuelve los países por defecto del código y una
 * comparación que solo mirara eso daría "no hay cambio" justamente en la primera
 * siembra, que es cuando más importa escribir.
 * `--show` enseña la lista vigente y **de dónde sale**, que es lo primero que hay
 * que mirar cuando el desplegable de `/participar` no ofrece lo que se espera.
 */

const ROOT = process.cwd();
const PAISES = path.join(ROOT, "paises.txt");

/** Argumentos que llegan por consola, ya sin el prefijo `--`. */
type Args = {
  show: boolean;
  dryRun: boolean;
  help: boolean;
};

function readArgs(argv: readonly string[]): Args {
  const args: Args = { show: false, dryRun: false, help: false };

  for (const arg of argv) {
    switch (arg) {
      case "--show":
        args.show = true;
        break;
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--help":
      case "-h":
        args.help = true;
        break;
      default:
        throw new Error(`Opción desconocida: ${arg}`);
    }
  }

  return args;
}

const AYUDA = `
Países que admite el torneo.

  npm run countries:seed
      Publica en Setting["${REGISTRATION_COUNTRIES_KEY}"] la lista de paises.txt.

  npm run countries:seed -- --show
      No escribe nada. Enseña la lista vigente y de dónde sale.

  npm run countries:seed -- --dry-run
      Enseña qué países entran y qué países salen, y no escribe.

  npm run countries:seed -- --help
      Esta ayuda.
`.trim();

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : `Error desconocido: ${String(error)}`;
}

/**
 * Las líneas de `paises.txt`, ya recortadas y sin las vacías.
 *
 * Los espacios de fuera se quitan y las líneas vacías se ignoran porque el
 * fichero lleva un salto de línea al final (y un editor de Windows lo escribe con
 * `\r\n`), y eso no puede convertir un fichero válido en una lista que la validación
 * rechaza. La marca de fin de fichero (`BOM`) que algunos editores de Windows
 * añaden también se quita: si se colara, el primer país se publicaría con un
 * carácter invisible delante y no se podría elegir en el desplegable.
 */
async function readPaisesFile(): Promise<string[]> {
  let texto: string;

  try {
    texto = await readFile(PAISES, "utf8");
  } catch (error) {
    throw new Error(`No se ha podido leer ${PAISES}: ${toErrorMessage(error)}`);
  }

  return texto
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((linea) => linea.trim())
    .filter((linea) => linea !== "");
}

/** Si hay documento en `Setting` o si se están usando los países por defecto. */
async function isPublished(): Promise<boolean> {
  const setting = await db.setting.findUnique({
    where: { key: REGISTRATION_COUNTRIES_KEY },
    select: { key: true },
  });

  return setting !== null;
}

/**
 * Lo que separa dos listas: primero lo que sale y luego lo que entra, cada uno en
 * el orden que tenía. Se comparan rótulos **exactos** a propósito: es la lista que
 * se va a escribir contra la que está escrita, y si solo se distinguieran en la
 * tilde el script daría un cambio por hecho donde en realidad lo que cambiaría es la
 * escritura de un rótulo que ya significaba lo mismo.
 */
function difference(antes: readonly string[], despues: readonly string[]): string[] {
  return [
    ...antes.filter((country) => !despues.includes(country)).map((country) => `- ${country}`),
    ...despues.filter((country) => !antes.includes(country)).map((country) => `+ ${country}`),
  ];
}

/** La lista, numerada: es el orden que ve quien se inscribe. */
function printCountries(countries: readonly string[]): void {
  countries.forEach((country, indice) => {
    console.log(`  ${String(indice + 1).padStart(2, " ")}. ${country}`);
  });
}

/** Las líneas de una diferencia, con su signo y sin numerar. */
function printChanges(lines: readonly string[]): void {
  for (const line of lines) {
    console.log(`  ${line}`);
  }
}

/** `--show`: qué lista está vigente y de dónde sale. No escribe nada. */
async function show(): Promise<void> {
  // Las dos lecturas son de `Setting` y no dependen la una de la otra: la lista
  // efectiva la da `readCountries()` —el mismo camino que sigue la web— y la fila
  // dice si hay documento publicado o se están usando los países por defecto.
  const [vigente, publicada] = await Promise.all([readCountries(), isPublished()]);

  console.log("");
  console.log("--- Países admitidos ---");
  console.log(`Clave: ${REGISTRATION_COUNTRIES_KEY}`);
  console.log(`Publicada en Setting: ${publicada ? "sí" : "no"}`);
  console.log(`Vigentes (${vigente.length}):`);
  printCountries(vigente);

  if (!publicada) {
    console.log("");
    console.log(
      "Se están usando los países por defecto del código. Publícalos con `npm run countries:seed`,",
    );
    console.log("así la organización podrá cambiarlos sin desplegar.");
  }
}

async function main(): Promise<void> {
  let args: Args;

  try {
    args = readArgs(process.argv.slice(2));
  } catch (error) {
    console.error(toErrorMessage(error));
    console.error(`\n${AYUDA}`);
    process.exitCode = 1;

    return;
  }

  if (args.help) {
    console.log(AYUDA);
    return;
  }

  if (args.show) {
    await show();
    return;
  }

  // El fichero se lee y se valida **antes** de tocar la base: si está mal, no se
  // gasta ni una consulta ni se deja la lista a medias.
  let leidos: string[];

  try {
    leidos = await readPaisesFile();
  } catch (error) {
    console.error(toErrorMessage(error));
    process.exitCode = 1;

    return;
  }

  const merged = mergeCountries(leidos);

  if (merged.warnings.length > 0) {
    console.error(`${path.relative(ROOT, PAISES)} no es una lista de países válida:`);
    for (const aviso of merged.warnings) {
      console.error(`  - ${aviso}`);
    }
    console.error("");
    console.error("No se escribe nada. Corrige el fichero y vuelve a intentarlo.");
    process.exitCode = 1;

    return;
  }

  const nueva = merged.countries;

  console.log("");
  console.log("--- Cambio ---");
  console.log(`Fichero: ${path.relative(ROOT, PAISES)} (${nueva.length} países)`);

  let actual: string[];

  try {
    actual = await readCountries();
  } catch (error) {
    console.error(`No se ha podido leer la lista vigente: ${toErrorMessage(error)}`);
    process.exitCode = 1;

    return;
  }

  console.log(`Vigentes: ${actual.length} países`);
  console.log("");

  const cambios = difference(actual, nueva);

  // **Publicada** y **vigente** no son lo mismo. `readCountries()` devuelve los
  // países por defecto cuando no hay fila en `Setting`, así que comparar solo las
  // listas daría "no hay cambio" en el caso en que más falta hace: la lista del
  // fichero y la del código son la misma y la fila **no existe**. El script
  // publicaría nunca, y con ella la promesa de que la organización puede cambiar
  // los países sin desplegar. Por eso la comparación va con `publicada`: si no
  // hay documento, hay que escribirlo, salga o no un cambio en el texto.
  const publicada = await isPublished();

  if (publicada && cambios.length === 0) {
    console.log("No hay cambio: la lista publicada ya es la del fichero.");
    return;
  }

  if (cambios.length === 0) {
    console.log("Mismo texto que la lista por defecto del código, pero no está publicado:");
    console.log(`se escribe para que la organización pueda cambiarlo en Setting["${REGISTRATION_COUNTRIES_KEY}"].`);
  } else {
    printChanges(cambios);
  }

  if (args.dryRun) {
    console.log("");
    console.log("Ensayo: no se escribe nada.");
    return;
  }

  try {
    await writeCountries(nueva);
  } catch (error) {
    console.error(`No se ha podido publicar la lista: ${toErrorMessage(error)}`);
    process.exitCode = 1;

    return;
  }

  console.log("");
  console.log(`Publicada en Setting["${REGISTRATION_COUNTRIES_KEY}"] (${nueva.length} países).`);
  console.log("");
  console.log("No hace falta desplegar: /participar y el panel la releen en cada petición.");
}

void main().catch((error: unknown) => {
  console.error(toErrorMessage(error));
  process.exitCode = 1;
});
