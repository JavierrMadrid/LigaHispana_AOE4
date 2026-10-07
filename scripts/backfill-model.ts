import "./load-env.mjs";

import { db } from "@/lib/db";

/**
 * Relleno de `Match.mode` y `Match.civRandomized` en las partidas ya guardadas.
 *
 *   npm run backfill:model
 *
 * Son los *backfills* 3a y 3b de `docs/MODELO-DATOS.md` §8.1. Las dos columnas
 * las escribe el worker con cada partida nueva, así que esto solo hace falta para
 * las filas que ya había en la base de datos cuando se añadieron.
 *
 * Los dos son idempotentes y se pueden repetir sin miedo:
 * - `mode` solo toca filas a `null`.
 * - `civRandomized` se recalcula siempre desde `rawJson`, así que repetirlo es un
 *   no-op cuando ya está bien.
 *
 * El 3b lee el mismo dato que el código (`civilization_randomized` del jugador con
 * nuestro `profileId`), pero desde `rawJson` y no desde `teams` normalizado, porque
 * aquí el punto de partida es la tabla y no la respuesta de la API.
 */

type CountRow = { count: bigint };

async function count(sql: string): Promise<number> {
  const rows = await db.$queryRawUnsafe<CountRow[]>(sql);
  return Number(rows[0]?.count ?? 0);
}

async function main(): Promise<void> {
  // Comprobación 0.4 del modelo de datos: con qué nombres publica la API las
  // ladders. Si apareciera un valor inesperado, el mapeo de `mode` de
  // `normalize.ts` necesita una línea nueva.
  const leaderboards = await db.$queryRawUnsafe<{ leaderboard: string; total: bigint }[]>(
    `select "leaderboard", count(*)::bigint as total from "Match" group by 1 order by 2 desc`,
  );

  console.log("Ladders guardadas:");
  for (const row of leaderboards) {
    console.log(`  ${row.leaderboard}: ${Number(row.total)}`);
  }

  const before = {
    modeNull: await count(`select count(*) from "Match" where "mode" is null`),
    notRandomized: await count(
      `select count(*) from "Match" where "rawJson" -> 'teams' is not null and "civRandomized" = false`,
    ),
  };

  console.log("");
  console.log("--- Backfill 3a: familia de ladder ---");
  const modeRows = await db.$executeRawUnsafe(`
    update "Match"
    set "mode" = case
      when "leaderboard" = 'rm_1v1' then 'rm_solo'
      when "leaderboard" in ('rm_2v2', 'rm_3v3', 'rm_4v4') then 'rm_team'
      else "leaderboard"
    end
    where "mode" is null
  `);
  console.log(`Filas actualizadas: ${modeRows}`);

  console.log("");
  console.log("--- Backfill 3b: civilización aleatoria ---");
  const civRows = await db.$executeRawUnsafe(`
    update "Match" m
    set "civRandomized" = coalesce((
      select coalesce(
               p.ent -> 'player' ->> 'civilization_randomized',
               p.ent ->> 'civilization_randomized'
             ) = 'true'
      from jsonb_array_elements(m."rawJson" -> 'teams') as equipo,
           lateral jsonb_array_elements(equipo) as p(ent)
      where coalesce(
              p.ent -> 'player' ->> 'profile_id',
              p.ent ->> 'profile_id'
            ) = pl."profileId"::text
      limit 1
    ), false)
    from "Player" pl
    where pl."id" = m."playerId"
  `);
  console.log(`Filas actualizadas: ${civRows}`);

  const after = {
    modeNull: await count(`select count(*) from "Match" where "mode" is null`),
    notRandomized: await count(
      `select count(*) from "Match" where "rawJson" -> 'teams' is not null and "civRandomized" = false`,
    ),
  };

  console.log("");
  console.log("--- Verificación ---");
  // La primera tiene que ser 0: si no, alguna fila se ha quedado sin resolver.
  console.log(`Filas con "mode" a null: ${after.modeNull} (${after.modeNull === 0 ? "correcto" : "REVISAR"})`);

  // La segunda no tiene que ser 0: sirve para comprobar que el 3b ha tocado lo que
  // tocaba. Si el 3b fallara en silencio, este número no se movería.
  console.log(
    `Filas con equipos y "civRandomized" a false: ${before.notRandomized} -> ${after.notRandomized}`,
  );

  if (after.notRandomized === before.notRandomized) {
    console.log(
      "  Aviso: la cuenta no se ha movido. O no había nada que rellenar, o el 3b no ha encontrado las claves esperadas en rawJson.",
    );
  }
}

void main();
