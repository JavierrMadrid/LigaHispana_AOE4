import "./load-env.mjs";

import { refreshDivisionCutoffs } from "@/lib/alerts/derive-cutoffs";
import { readDivisionCutoffs } from "@/lib/alerts/settings";
import { createAoe4WorldClient } from "@/lib/aoe4world/client";
import { DEFAULT_LEADERBOARD } from "@/lib/aoe4world/types";

/**
 * Derivar (o refrescar) los cortes rating → subdivisión que necesita la regla R5.
 *
 *   npm run alerts:cutoffs                     # rm_solo y rm_team
 *   npm run alerts:cutoffs -- --ladder=rm_team # solo una
 *   npm run alerts:cutoffs -- --show           # solo enseña lo que hay cacheado
 *
 * ## Por qué es un script y no parte del sincronizador
 *
 * R5 compara la media de elo de una partida de equipos con la división 1v1 del
 * jugador, y para eso hace falta saber, en la ladder **de esa partida**, a partir
 * de qué rating empieza cada subdivisión. La API no lo publica: `rating_min`,
 * `rating_max` y `rank_level` los ignora en silencio, así que hay que recorrer la
 * ladder con `?page=N` y quedarse con el rating más bajo de cada bloque.
 *
 * Con búsqueda binaria son del orden de 130 llamadas por ladder, y el
 * sincronizador corre cada 5 minutos: 288 × 130 peticiones al día por una tabla
 * que solo cambia cuando cambia el reparto de la temporada. Los cortes se
 * derivan una vez, se cachean en `Setting["alerts.divisionCutoffs"]` y se
 * refrescan a mano. **El motor nunca sale a la red**: sin cortes, R5 se omite con
 * un aviso y las otras siete reglas funcionan igual.
 *
 * ## Por qué las dos ladders
 *
 * Hoy solo R5 los necesita, y R5 solo mira partidas de equipo, así que la que
 * hace falta es `rm_team`. Se deriva también `rm_solo` porque es la ladder de la
 * que sale `Player.rankLevel` y tener las dos hace que la caché sea completa y
 * auditable. La derivación **acumula**: pedir una no borra la otra.
 *
 * Los cortes guardados incluyen la fecha y el número de peticiones, y son
 * visibles con `--show`, para que nadie los tome por un dato que se recalcula solo.
 */

/** Ladders de las que se derivan cortes si no se dice otra cosa. */
const DEFAULT_LADDERS = [DEFAULT_LEADERBOARD, "rm_team"];

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : `Error desconocido: ${String(error)}`;
}

function show(): Promise<void> {
  return readDivisionCutoffs().then((cutoffs) => {
    if (cutoffs === null) {
      console.log("No hay cortes cacheados. Derívalos con `npm run alerts:cutoffs`.");
      return;
    }

    for (const ladder of Object.keys(cutoffs).sort()) {
      const entry = cutoffs[ladder];

      if (entry === undefined) {
        continue;
      }

      console.log("");
      console.log(
        `${ladder}: ${entry.totalCount} jugadores, derivado el ${entry.derivedAt} ` +
          `con ${entry.requests} peticiones`,
      );

      for (const cutoff of entry.cutoffs) {
        console.log(`  ${cutoff.rankLevel.padEnd(14)} desde ${cutoff.minRating} de elo`);
      }
    }
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    console.log("Uso: npm run alerts:cutoffs [-- --ladder=<nombre>] [-- --show]");
    console.log("");
    console.log(`  --ladder=<nombre>  Ladder de la que derivar los cortes. Repetible.`);
    console.log(`                     Por defecto: ${DEFAULT_LADDERS.join(", ")}`);
    console.log("  --show             Solo enseña los cortes cacheados y sale.");
    return;
  }

  if (args.includes("--show")) {
    await show();
    return;
  }

  const ladders = args.flatMap((argument) => {
    const match = /^--ladder=(.+)$/.exec(argument);

    return match === null ? [] : [match[1].trim()];
  });

  const objetivo = ladders.length === 0 ? DEFAULT_LADDERS : ladders;
  const client = createAoe4WorldClient();

  console.log(`Derivando los cortes de: ${objetivo.join(", ")}`);

  // Plazo generoso a propósito: son ~130 llamadas por ladder con la separación
  // mínima entre peticiones de `http.ts`, y un cron que se queda a medias
  // desperdicia todo el trabajo.
  const signal = AbortSignal.timeout(15 * 60_000);

  try {
    const table = await refreshDivisionCutoffs(objetivo, {
      client,
      signal,
      onProgress: (message) => console.log(message),
    });

    console.log("");
    console.log(
      `Guardados en Setting["alerts.divisionCutoffs"]: ${Object.keys(table).sort().join(", ")}`,
    );
    console.log("Ahora `npm run alerts:check` ya evaluará también R5.");
  } catch (error) {
    console.error(`No se han podido derivar los cortes: ${toErrorMessage(error)}`);
    process.exitCode = 1;
  }
}

void main();
