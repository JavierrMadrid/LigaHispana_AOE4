/**
 * Fixture del *summary* de una partida, para el mock de AoE4World.
 *
 * A diferencia de las demás fixtures, que imitan un endpoint de la API, esta
 * genera un payload **a partir del par `(profileId, gameId)`**: el summary no
 * viene de `/api/v0` y el resolutor de rutas de `mock/index.ts` no lo cubre, así
 * que se pide desde `fetchGameSummary()` cuando `AOE4WORLD_MOCK` está activo.
 *
 * Que sea una **generación** y no una tabla de datos tiene un motivo concreto: lo
 * que hay que ejercitar es el lector de `summary.ts` (`parseGameSummary`) y el de
 * `summary-anomalies.ts` (`parseSummaryAnomalies`) y, con ellos, los objetivos y
 * las alertas nuevas. Una fixture escrita a mano con los campos ya resueltos pasaría
 * por el motor sin tocar el parseo, y un cambio en la forma del payload de la API no
 * se notaría hasta producción.
 *
 * Es determinista por construcción: el mismo `(profileId, gameId)` da siempre el
 * mismo summary, así que `npm run mock:tournament` se puede repetir sin que las
 * métricas bailen entre pasadas y sin que ninguna partida parezca "sin summary"
 * unas veces y "con summary" otras.
 *
 * ## Las series del resumen
 *
 * `resources` imita lo que publica la API: `timestamps` cada 20 s hasta la duración
 * de la partida y, en paralelo, `military` (una **puntuación**, no existencias) y
 * los cuatro `*Gathered` (acumulados). Se reparten por bandas anchas —algunas
 * partidas con aldeanos creados a los 21 s y otras con solo los iniciales; unas con
 * la puntuación militar subiendo y otras plana; unas con la economía subiendo y
 * otras con un tramo de 3 minutos congelado— para que la simulación enseñe las tres
 * alertas por partida tanto disparadas como no. Ver `summary-anomalies.ts` para el
 * criterio con el que se leen.
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

/**
 * Una entrada de `buildOrder` que se destruyó `count` veces.
 *
 * Las pérdidas son aldeanos **iniciales**: por eso su `finished` es `[0]`, que el
 * lector de anomalías no cuenta como "creó un aldeano". Los creados de verdad van
 * en su propia entrada.
 */
function destroyed(pbgid: number, count: number): Record<string, unknown> {
  return {
    id: `${pbgid}`,
    pbgid,
    type: "unit",
    constructed: [0],
    finished: [0],
    // `destroyed` con instantes repetidos es legítimo en la API (dos unidades en
    // el mismo segundo), y el recuento es la longitud de la lista.
    destroyed: Array.from({ length: count }, () => 600 + count),
  };
}

/** Una entrada de `buildOrder` para los aldeanos que se van creando. */
function created(pbgid: number, seconds: number[]): Record<string, unknown> {
  return {
    id: `creados-${pbgid}`,
    pbgid,
    type: "unit",
    constructed: seconds.map((second) => Math.max(0, second - 15)),
    finished: seconds,
  };
}

/**
 * Retrasa un índice durante un tramo: lo usan las series congeladas.
 *
 * Entre `from` y `to` devuelve siempre `from`, de modo que el acumulado se queda
 * quieto; después sigue donde lo dejó. Así un tramo plano es un silencio de
 * verdad, no una serie que se reinicia.
 */
function stalledIndex(index: number, from: number, to: number): number {
  if (index <= from) {
    return index;
  }

  if (index <= to) {
    return from;
  }

  return index - (to - from);
}

/**
 * El summary de una partida simulada, para el jugador `profileId`.
 *
 * Las cifras se reparten a propósito por bandas anchas —APM por encima y por
 * debajo de 120, feudal antes y después de 240 s, cero y varios aldeanos
 * perdidos— para que `npm run mock:tournament` enseñe los cinco objetivos del
 * resumen tanto conseguidos como sin conseguir, en vez de una foto plana. Y las
 * series hacen lo mismo con las tres alertas por partida.
 */
export function mockGameSummaryPayload(profileId: number, gameId: string): unknown {
  const seed = `${profileId}/${gameId}`;
  const apm = 90 + pick(seed, "apm", 70);
  const feudal = 140 + pick(seed, "feudal", 220);
  const castle = feudal + 120 + pick(seed, "castle", 420);
  const imperial = castle + 300 + pick(seed, "imperial", 700);
  const duration = 900 + pick(seed, "duration", 1800);

  // Un punto cada 20 s, como en el resumen real, hasta el final de la partida.
  const timestamps = Array.from(
    { length: Math.floor(duration / 20) + 1 },
    (_, index) => index * 20,
  );

  // Militar: una de cada tres partidas con la puntuación **plana** (empieza en 13
  // por el explorador y no hace ningún máximo nuevo); el resto, subiendo.
  const militarPlano = pick(seed, "militar", 3) === 0;
  const military = timestamps.map((_, index) => (militarPlano ? 13 : 13 + index * 2));

  // Recursos: una de cada tres con la economía congelada 3 minutos a mitad de
  // partida, que es un tramo de sobra para `NO_RESOURCES_GAP`.
  const recursosPlanos = pick(seed, "recursos", 3) === 0;
  const planoDesde = 5 + pick(seed, "planodesde", 8);
  const planoHasta = planoDesde + 9;

  const gathered = (base: number, rate: number) =>
    timestamps.map((_, index) =>
      base + rate * (recursosPlanos ? stalledIndex(index, planoDesde, planoHasta) : index),
    );

  // Aldeanos: unas partidas los crean desde los 21 s y otras solo tienen los
  // iniciales a 0, que es el caso que dispara `NO_VILLAGERS_FIRST_MINUTES`.
  const creaAldeanos = pick(seed, "arranque", 2) === 0;
  const creados = creaAldeanos ? [0, 21, 41, 62, 83, 104, 125, 146, 167] : [0];

  return {
    gameId: Number(gameId),
    duration,
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
        // Los tres `pbgid` son de los conjuntos de `summary-anomalies.ts` (aldeano,
        // aldeano dorado y aldeano montado) y el test del módulo comprueba que esta
        // fixture los reconoce: si alguno dejara de pertenecer al conjunto, la
        // pérdida se leería como cero y la prueba lo diría.
        buildOrder: [
          // Los aldeanos perdidos son 0..3: por debajo de 3 hay partida válida para
          // `defensor-del-pueblo`, y 3 o más la dejan fuera.
          destroyed(129272, pick(seed, "aldearanos", 4)),
          destroyed(2513732, pick(seed, "dorados", 2)),
          destroyed(9004039, pick(seed, "montados", 2)),
          // Y aparte, los que se crean: es lo que lee `firstVillagerSeconds`.
          created(129272, creados),
        ],
        resources: {
          timestamps,
          military,
          foodGathered: gathered(40, 6 + pick(seed, "ritmocomida", 6)),
          woodGathered: gathered(20, 4 + pick(seed, "ritmomadera", 5)),
          goldGathered: gathered(0, 2 + pick(seed, "ritmooro", 4)),
          stoneGathered: gathered(0, pick(seed, "ritmopiedra", 3)),
          // Existencias: se mandan porque el payload real las trae, pero **no** las
          // lee la regla de recursos (suben y bajan con cada gasto).
          food: timestamps.map((_, index) => 100 + (index % 7) * 10),
          wood: timestamps.map((_, index) => 80 + (index % 5) * 10),
          gold: timestamps.map((_, index) => 50 + (index % 3) * 10),
          stone: timestamps.map((_, index) => 20 + (index % 2) * 10),
        },
      },
    ],
  };
}
