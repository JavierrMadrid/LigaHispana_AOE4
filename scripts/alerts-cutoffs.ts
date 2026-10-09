import "./load-env.mjs";

import { refreshDivisionCutoffs } from "@/lib/alerts/derive-cutoffs";
import { readDivisionCutoffs } from "@/lib/alerts/settings";
import { createAoe4WorldClient } from "@/lib/aoe4world/client";

/**
 * Derivar (o refrescar) los cortes rating → subdivisión que necesita la regla R5.
 *
 *   npm run alerts:cutoffs                     # rm_team
 *   npm run alerts:cutoffs -- --ladder=rm_team # una familia concreta
 *   npm run alerts:cutoffs -- --show           # solo enseña lo que hay cacheado
 *
 * ## Por qué es un script y no parte del sincronizador
 *
 * R5 compara **dos ratings de una misma partida de equipos** (el del jugador en
 * esa partida y la media de rating de la partida, `average_rating`), y para eso
 * hace falta saber, en la familia **de esa partida** (`rm_team`), a partir de qué
 * rating empieza cada subdivisión. La API no lo publica: `rating_min`,
 * `rating_max` y `rank_level` los ignora en silencio, así que hay que recorrer la
 * ladder con `?page=N` y quedarse con el rating más bajo de cada bloque (el final
 * del bloque, no su principio; ver `derive-cutoffs.ts`).
 *
 * Con búsqueda binaria son del orden de 130 llamadas por familia, y el
 * sincronizador corre cada 5 minutos: 288 × 130 peticiones al día por una tabla
 * que solo cambia cuando cambia el reparto de la temporada. Los cortes se
 * derivan una vez, se cachean en `Setting["alerts.divisionCutoffs"]` y se
 * refrescan a mano. **El motor nunca sale a la red**: sin cortes, R5 se omite con
 * un aviso y las otras siete reglas funcionan igual.
 *
 * ## Por qué solo `rm_team`
 *
 * R5 solo mira partidas de equipo, así que la única familia que necesita cortes
 * es `rm_team`. El `rm_solo` se derivaba antes, cuando R5 comparaba con el
 * `rank_level` 1v1 del jugador; hoy no lo lee nadie y no se deriva. La caché se
 * reescribe como un retrato de esta llamada, así que una entrada vieja de
 * `rm_solo` se poda en la siguiente ejecución.
 *
 * Los cortes guardados incluyen la fecha y el número de peticiones, y son
 * visibles con `--show`, para que nadie los tome por un dato que se recalcula solo.
 */

/** Familias de ladder de las que se derivan cortes si no se dice otra cosa. */
const DEFAULT_LADDERS = ["rm_team"];

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
    console.log(`  --ladder=<nombre>  Familia de ladder de la que derivar los cortes. Repetible.`);
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

  // Plazo generoso a propósito: son ~130 llamadas por familia con la separación
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
