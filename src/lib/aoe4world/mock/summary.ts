/**
 * Fixture del *summary* de una partida, para el mock de AoE4World.
 *
 * A diferencia de las demás fixtures, que imitan un endpoint de la API, esta
 * genera un payload **a partir del par `(profileId, gameId)`**: el summary no
 * viene de `/api/v0` y el resolutor de rutas de `mock/index.ts` no lo cubre, así
 * que se pide desde `fetchGameSummary()` cuando `AOE4WORLD_MOCK` está activo.
 *
 * Que sea una **generación** y no una tabla de datos tiene un motivo concreto: lo
 * que hay que ejercitar es el lector de `summary.ts` (`parseGameSummary`) y, con
 * él, los objetivos nuevos. Una fixture escrita a mano con los campos ya
 * resueltos pasaría por el motor sin tocar el parseo, y un cambio en la forma del
 * payload de la API no se notaría hasta producción.
 *
 * Es determinista por construcción: el mismo `(profileId, gameId)` da siempre el
 * mismo summary, así que `npm run mock:tournament` se puede repetir sin que las
 * métricas bailen entre pasadas y sin que ninguna partida parezca "sin summary"
 * unas veces y "con summary" otras.
 */

/** FNV-1a de 32 bits: el mismo hash que la huella del snapshot de objetivos. */
function hash(seed: string): number {
  let value = 0x811c9dc5;

  for (let index = 0; index < seed.length; index += 1) {
    value ^= seed.charCodeAt(index);
    value = Math.imul(value, 0x01000193);
  }

  return value >>> 0;
}

/** Un entero determinista en `[0, mod)`. */
function pick(seed: string, salt: string, mod: number): number {
  return hash(`${seed}:${salt}`) % mod;
}

/** Una entrada de `buildOrder` que se destruyó `count` veces. */
function destroyed(pbgid: number, count: number): Record<string, unknown> {
  return {
    id: `${pbgid}`,
    pbgid,
    type: "unit",
    constructed: [120],
    finished: [125],
    // `destroyed` con instantes repetidos es legítimo en la API (dos unidades en
    // el mismo segundo), y el recuento es la longitud de la lista.
    destroyed: Array.from({ length: count }, () => 600 + count),
  };
}

/**
 * El summary de una partida simulada, para el jugador `profileId`.
 *
 * Las cifras se reparten a propósito por bandas anchas —APM por encima y por
 * debajo de 120, feudal antes y después de 240 s, cero y varios aldeanos
 * perdidos— para que `npm run mock:tournament` enseñe los cinco objetivos nuevos
 * tanto conseguidos como sin conseguir, en vez de una foto plana.
 */
export function mockGameSummaryPayload(profileId: number, gameId: string): unknown {
  const seed = `${profileId}/${gameId}`;
  const apm = 90 + pick(seed, "apm", 70);
  const feudal = 140 + pick(seed, "feudal", 220);
  const castle = feudal + 120 + pick(seed, "castle", 420);
  const imperial = castle + 300 + pick(seed, "imperial", 700);

  return {
    gameId: Number(gameId),
    duration: 900 + pick(seed, "duration", 1800),
    players: [
      {
        profileId,
        name: `Jugador ${profileId}`,
        civilization: "english",
        team: 1,
        apm,
        result: pick(seed, "result", 2) === 0 ? "loss" : "win",
        actions: {
          feudalAge: [feudal],
          castleAge: [castle],
          // Solo una de cada cinco partidas llega al imperial: el umbral de 960 s
          // se cumple o no según cuándo se llegó, que es lo que mide el objetivo.
          imperialAge: pick(seed, "llegaimperial", 5) === 0 ? [imperial] : [],
        },
        // Los tres `pbgid` son de los conjuntos de `summary.ts` (aldeano, aldeano
        // dorado y aldeano montado) y el test del módulo comprueba que esta fixture
        // los reconoce: si alguno dejara de pertenecer al conjunto, la pérdida se
        // leería como cero y la prueba lo diría.
        buildOrder: [
          // Los aldeanos perdidos son 0..3: por debajo de 3 hay partida válida para
          // `defensor-del-pueblo`, y 3 o más la dejan fuera.
          destroyed(129272, pick(seed, "aldearanos", 4)),
          destroyed(2513732, pick(seed, "dorados", 2)),
          destroyed(9004039, pick(seed, "montados", 2)),
        ],
      },
    ],
  };
}
