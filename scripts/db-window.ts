import "./load-env.mjs";

import { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { isRecord } from "@/lib/json";
import { parseWindow, rankedMatchWhere, readInstant, type ScoringWindow } from "@/lib/ranked-match";
import {
  DEFAULT_RULESET,
  SCORING_RULESET_KEY,
  readRuleset,
  recomputeScores,
} from "@/lib/scoring";

/**
 * Publicar la ventana de fechas del torneo en `Setting`, sin desplegar.
 *
 *   npm run db:window                                     # muestra la ventana activa
 *   npm run db:window -- --from 2026-09-01T00:00:00Z      # abierta por la derecha
 *   npm run db:window -- --from ... --to 2026-11-30T23:59:59Z
 *   npm run db:window -- --check                           # solo comprueba, no escribe
 *
 * Existe porque el `window` es lo único del ruleset que tiene fecha de caducidad
 * escrita en el código: `DEFAULT_RULESET.window` son las fechas **de prueba**
 * (15-sep-2026 a 15-oct-2026). Mientras `Setting` no traiga `window`, el torneo
 * puntúa con esas, y el 15 de octubre `startedAt < to` deja de cumplirse para
 * todo lo nuevo: la clasificación se congela en silencio, sin error ni aviso.
 *
 * Es un script y no una pantalla de `/admin` por lo mismo que `db:cron` y
 * `db:security`: escribir el ruleset cambia la clasificación de golpe, y eso pide
 * una orden explícita con su comprobación previa, no un campo de formulario.
 *
 * Dos decisiones que no son obvias:
 *
 * - **Solo se toca la clave `window`.** El documento de `scoring.ruleset` se lee y
 *   se devuelve con el resto intacto, aunque no exista: escribir el ruleset entero
 *   materializaría todos los valores por defecto dentro de la configuración y
 *   dejaría congelado en el panel lo que hoy se puede cambiar en el código.
 * - **Recalcula al terminar.** Mover la ventana cambia qué partidas cuentan, así que
 *   `PlayerScore` queda desfasada si no se rehace. Se muestra el antes y el después
 *   para que el cambio no sea a ciegas.
 */

/** Argumentos que llegan por consola, ya sin el prefijo `--`. */
type Args = {
  check: boolean;
  dryRun: boolean;
  help: boolean;
  from: string | null;
  to: string | null;
  open: boolean;
};

function readArgs(argv: readonly string[]): Args {
  const args: Args = {
    check: false,
    dryRun: false,
    help: false,
    from: null,
    to: null,
    open: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = (): string => {
      const value = argv[i + 1];

      if (value === undefined) {
        throw new Error(`A ${arg} le falta el valor.`);
      }

      i += 1;

      return value;
    };

    switch (arg) {
      case "--check":
        args.check = true;
        break;
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--help":
      case "-h":
        args.help = true;
        break;
      case "--open":
        args.open = true;
        break;
      case "--from":
        args.from = next();
        break;
      case "--to":
        args.to = next();
        break;
      default:
        throw new Error(`Opción desconocida: ${arg}`);
    }
  }

  return args;
}

const AYUDA = `
Ventana de fechas del torneo.

  npm run db:window
      Muestra la ventana que esta activa ahora mismo y de donde sale.

  npm run db:window -- --from <ISO> --to <ISO>
      Fija la ventana. Los instantes necesitan zona explicita (Z o +hh:mm).

  npm run db:window -- --from <ISO> --open
      Ventana abierta por la derecha: cuenta todo lo que se juegue desde \`from\`.

  npm run db:window -- --from <ISO> --to <ISO> --dry-run
      Ensena el antes y el despues, y cuantas partidas entran o salen, sin escribir.

  npm run db:window -- --check
      No escribe nada. Sale con 1 si la ventana activa no cuadra.
`.trim();

function formatWindow(window: ScoringWindow): string {
  return `${window.from} -> ${window.to ?? "abierta"}`;
}

/** Escribe la ventana en el documento, dejando el resto del ruleset intacto. */
async function writeWindow(window: ScoringWindow): Promise<void> {
  const actual = await db.setting.findUnique({ where: { key: SCORING_RULESET_KEY } });

  // El cast es el mismo que ya usa `ensureRuleset`: lo que viene es el JSON que
  // había en la base y lo único que se cambia es `window`, que `parseWindow` acaba
  // de validar. `Prisma.InputJsonObject` no admite `unknown`, y el valor de la
  // columna es `Json`, así que el tipo se ajusta en el borde y no antes.
  const value = {
    ...(isRecord(actual?.value) ? actual.value : {}),
    window: { from: window.from, to: window.to },
  } as Prisma.InputJsonObject;

  await db.setting.upsert({
    where: { key: SCORING_RULESET_KEY },
    create: { key: SCORING_RULESET_KEY, value },
    update: { value },
  });
}

/** Cuántas partidas y cuántos puntos entran con una ventana dada. */
async function impact(window: ScoringWindow): Promise<{ matches: number; wins: number }> {
  const where = rankedMatchWhere(DEFAULT_RULESET.modes, window);
  const rows = await db.match.findMany({
    where,
    select: { result: true, points: true },
  });

  return {
    matches: rows.length,
    wins: rows.filter((row) => row.result === "WIN").length,
  };
}

async function main(): Promise<void> {
  let args: Args;

  try {
    args = readArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(`\n${AYUDA}`);
    process.exit(1);

    return;
  }

  if (args.help) {
    console.log(AYUDA);
    return;
  }

  const stored = await db.setting.findUnique({
    where: { key: SCORING_RULESET_KEY },
    select: { value: true },
  });
  const guardada = isRecord(stored?.value) ? stored.value["window"] : undefined;
  const activa = await readRuleset();

  console.log("");
  console.log("--- Ventana del torneo ---");
  console.log(`Clave: ${SCORING_RULESET_KEY}`);
  console.log(`Guardada en Setting: ${guardada === undefined ? "no (se usa la del codigo)" : JSON.stringify(guardada)}`);
  console.log(`Activa:              ${formatWindow(activa.window)}`);
  console.log(`Viene de:            ${guardada === undefined ? "DEFAULT_RULESET (fechas de prueba)" : "Setting"}`);

  const delDocumento = (): string => (guardada === undefined ? "no esta publicada" : "esta publicada");

  if (args.check) {
    const caducada = activa.window.to !== null && Date.parse(activa.window.to) <= Date.now();
    const cuenta = await impact(activa.window);

    console.log(`Partidas clasificatorias dentro de la ventana: ${cuenta.matches} (${cuenta.wins} ganadas)`);
    console.log(`Estado: ${delDocumento()}${caducada ? " y CADUCADA: ya no cuenta ninguna partida nueva" : ""}`);

    if (guardada === undefined) {
      console.error("");
      console.error("La ventana activa son las fechas de prueba del codigo. Publica la real con --from/--to.");
      process.exit(1);
    }

    if (caducada) {
      console.error("");
      console.error("La ventana ya se ha cerrado: el torneo no puntua desde hace dias.");
      process.exit(1);
    }

    return;
  }

  if (args.from === null && !args.open && args.to === null) {
    console.log("");
    console.log("No hay nada que escribir. Pasa --from y --to, o --from y --open.");
    console.log(`\n${AYUDA}`);
    return;
  }

  if (args.from === null) {
    console.error("Falta --from: es obligatorio, la ventana siempre empieza en algún momento.");
    process.exit(1);
  }

  if (args.open && args.to !== null) {
    console.error("--open y --to son incompatibles: o la ventana se cierra en una fecha, o no se cierra.");
    process.exit(1);
  }

  const from = readInstant(args.from);

  if (from === null) {
    console.error(
      `--from no es un instante ISO-8601 con zona explicita: ${JSON.stringify(args.from)}`,
    );
    console.error("Por ejemplo: 2026-09-01T00:00:00Z");
    process.exit(1);
  }

  let to: Date | null = null;

  if (!args.open) {
    if (args.to === null) {
      console.error(
        "Falta --to. Si la ventana no se cierra, pidelo con --open: omitir --to no la abre, " +
          "hereda la fecha del documento por defecto, que es justo la trampa que avisa parseWindow.",
      );
      process.exit(1);

      return;
    }

    to = readInstant(args.to);

    if (to === null) {
      console.error(
        `--to no es un instante ISO-8601 con zona explicita: ${JSON.stringify(args.to)}`,
      );
      process.exit(1);

      return;
    }
  }

  const pedida: ScoringWindow = { from: from.toISOString(), to: to?.toISOString() ?? null };

  if (to !== null && to.getTime() <= from.getTime()) {
    console.error("--to es anterior o igual a --from: la ventana no puntuaria ninguna partida.");
    process.exit(1);
  }

  // Se pasa por el validador del motor y no por una comprobacion propia: asi el
  // script no puede publicar una ventana que `readRuleset` vaya a descartar.
  const validada = parseWindow({ from: pedida.from, to: pedida.to }, DEFAULT_RULESET.window);

  if (validada.warnings.length > 0) {
    console.error("El motor no aceptaria esa ventana:");
    for (const aviso of validada.warnings) {
      console.error(`  - ${aviso}`);
    }
    process.exit(1);
  }

  const antes = await impact(activa.window);
  const despues = await impact(validada.window);

  console.log("");
  console.log("--- Cambio ---");
  console.log(`De:  ${formatWindow(activa.window)}  (${antes.matches} partidas, ${antes.wins} ganadas)`);
  console.log(`A:   ${formatWindow(validada.window)}  (${despues.matches} partidas, ${despues.wins} ganadas)`);

  const diferencia = despues.matches - antes.matches;

  if (diferencia !== 0) {
    console.log(
      `La clasificacion cambiara en ${diferencia > 0 ? "+" : ""}${diferencia} ${
        diferencia === 1 || diferencia === -1 ? "partida" : "partidas"
      }.`,
    );
  } else {
    console.log("La clasificacion no cambia: las mismas partidas entran y salen.");
  }

  if (args.dryRun) {
    console.log("");
    console.log("Ensayo: no se escribe nada ni se recalcula la clasificacion.");
    return;
  }

  await writeWindow(validada.window);
  console.log("");
  console.log(`Publicada en Setting["${SCORING_RULESET_KEY}"].window.`);
  console.log("");
  console.log("--- Recalculando la clasificacion ---");

  const resultado = await recomputeScores();

  console.log(`Jugadores en la clasificacion: ${resultado.playersRanked}`);
  console.log(`Puntos totales: ${resultado.totalPoints}`);
  console.log(`Partidas con puntos actualizadas: ${resultado.matchesUpdated}`);
  console.log(`Puntos de objetivos: ${resultado.objectivesPoints}`);
  console.log("");
  console.log("No hace falta desplegar: la web relee el ruleset en cada peticion.");
  console.log("");
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
