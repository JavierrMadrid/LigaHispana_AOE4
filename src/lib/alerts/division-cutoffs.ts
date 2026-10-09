import { subdivisionIndex } from "@/lib/divisions";
import { isRecord } from "@/lib/json";

/**
 * Cortes rating → subdivisión, en memoria. **Módulo puro**: no lee de `Setting`
 * ni sale a la red, para que el motor de alertas (`compute.ts`) pueda usarlo sin
 * arrastrar ni la base de datos ni el cliente de AoE4World.
 *
 * ## Qué son y por qué hacen falta
 *
 * R5 compara **dos ratings de la misma partida de equipos** —el del jugador en
 * esa partida y la media del juego— y necesita saber a qué subdivisión
 * corresponde cada uno para contar los escalones que los separan. El rating es
 * un número y la subdivisión un `rank_level` (`gold_3`), así que hace falta
 * saber, para una ladder concreta, **a partir de qué rating empieza cada
 * subdivisión**.
 *
 * La API no lo publica: `rating_min`, `rating_max` y `rank_level` se ignoran en
 * silencio en `/leaderboards/:ladder` y siempre devuelven la página 1. La única
 * forma de averiguarlo es recorrer la ladder (ver `derive-cutoffs.ts`) y quedarse
 * con el rating más bajo de cada bloque, que es justo lo que se guarda aquí.
 *
 * ## Por qué hay cortes **por familia de ladder**
 *
 * Las dos magnitudes que compara R5 son elo de la **familia** de la partida
 * (`Match.mode`: para equipos, `rm_team`), así que los cortes que sirven son los
 * de esa familia, no los de `rm_solo`. Se busca por la familia resuelta y no por
 * el literal `Match.leaderboard` porque un ranked por equipos puede publicarse
 * como `rm_2v2`, `rm_3v3` o `rm_4v4`, y entonces el literal no coincidiría con la
 * clave cacheada. Comprobado
 * contra la API real en septiembre de 2026: un jugador con 252 de rating en la
 * ladder `rm_team` aparece con 337 de `mmr` en su partida de equipos, o sea que
 * las dos escalas son la misma, y `rank_level` sale del rating con umbrales
 * globales. Aun así se derivan y se cachean por familia, porque es lo que hace
 * que el dato sea **correcto por construcción** y no por una suposición sobre
 * los umbrales de AoE4World.
 */

/** Un corte: el rating más bajo que se ha visto en esa subdivisión. */
export type LadderCutoff = {
  /** `rank_level` de la subdivisión (`gold_2`). */
  rankLevel: string;
  /** Rating más bajo observado en esa subdivisión dentro de la ladder. */
  minRating: number;
};

export type LadderCutoffs = {
  /** Familia de ladder de la que salen los cortes (`rm_team`). */
  ladder: string;
  /** Instante de la derivación, ISO-8601. */
  derivedAt: string;
  /** Jugadores que tenía la ladder cuando se derivó. */
  totalCount: number;
  /**
   * Los 18 cortes, **de la más fuerte a la más débil**.
   *
   * Tiene que estar **completo**: si una subdivisión saliera vacía en la ladder,
   * las de detrás correrían un escalón y la cuenta de R5 sería falsa sin que nada
   * fallara. Por eso `derive-cutoffs.ts` se niega a cachear una derivación
   * incompleta.
   */
  cutoffs: LadderCutoff[];
  /** Peticiones a la API que costó derivarla, para poder comparar coste y resultado. */
  requests: number;
};

/** Los cortes de todas las familias de ladder derivadas, indexados por nombre de familia. */
export type LadderCutoffsTable = Record<string, LadderCutoffs>;

/** Forma guardada en `Setting["alerts.divisionCutoffs"]`. */
export type StoredDivisionCutoffs = {
  ladders: LadderCutoffsTable;
};

export type MatchedSubdivision = {
  /** Posición en `SUBDIVISION_RANK_LEVELS` (0 = `conqueror_3`). */
  index: number;
  rankLevel: string;
};

/**
 * A qué subdivisión pertenece un rating, con los cortes de una ladder.
 *
 * La búsqueda va de la más fuerte a la más débil y se queda con la **primera**
 * cuyo `minRating` no supere el rating: los bloques de la ladder son contiguos y
 * van de más rating a menos, así que el primer corte que el rating alcanza es
 * exactamente su bloque.
 *
 * Un rating **por debajo del corte de la última subdivisión** (es decir, por
 * debajo de bronce 1) se devuelve como `bronze_1`. Se recorta a propósito: por
 * debajo de bronce 1 la ladder no dice nada, y un `average_mmr` por debajo del
 * corte de bronce es un dato raro, no un comportamiento. Recortar solo puede
 * **reducir** la cuenta de escalones en un caso patológico (un jugador a un
 * escalón de bronce con una media imposible), y no cambia ninguna decisión cerca
 * del umbral de tres.
 *
 * `null` si la ladder no trae la subdivisión pedida, que es como se comporta una
 * caché de cortes a medio derivar.
 */
export function subdivisionForRating(
  cutoffs: LadderCutoffs,
  rating: number,
): MatchedSubdivision | null {
  if (!Number.isFinite(rating)) {
    return null;
  }

  for (const cutoff of cutoffs.cutoffs) {
    if (rating < cutoff.minRating) {
      continue;
    }

    const index = subdivisionIndex(cutoff.rankLevel);

    return index === null ? null : { index, rankLevel: cutoff.rankLevel };
  }

  const ultimo = cutoffs.cutoffs.at(-1);
  const indiceUltimo = ultimo === undefined ? null : subdivisionIndex(ultimo.rankLevel);

  return ultimo === undefined || indiceUltimo === null
    ? null
    : { index: indiceUltimo, rankLevel: ultimo.rankLevel };
}

/**
 * Deja en la tabla **solo** las familias de ladder indicadas.
 *
 * La caché es un retrato de lo que el motor puede leer, no un histórico: cuando
 * una familia deja de derivarse —el `rm_solo`, que R5 ya no consulta— su entrada
 * queda obsoleta y no tiene por qué sobrevivir a la siguiente reescritura de
 * `Setting["alerts.divisionCutoffs"]`. Es pura para poder comprobar la poda sin
 * red ni base de datos.
 */
export function pruneCutoffsTable(
  table: LadderCutoffsTable,
  ladders: readonly string[],
): LadderCutoffsTable {
  const keep = new Set(ladders);
  const pruned: LadderCutoffsTable = {};

  for (const [ladder, cutoffs] of Object.entries(table)) {
    if (keep.has(ladder)) {
      pruned[ladder] = cutoffs;
    }
  }

  return pruned;
}

/* -------------------------------------------------------------------------- */
/* Lectura de lo cacheado                                                      */
/* -------------------------------------------------------------------------- */

function readCutoff(value: unknown): LadderCutoff | null {
  if (!isRecord(value)) {
    return null;
  }

  const { rankLevel, minRating } = value;

  if (typeof rankLevel !== "string" || rankLevel.trim() === "") {
    return null;
  }

  if (typeof minRating !== "number" || !Number.isFinite(minRating)) {
    return null;
  }

  // Un corte que caiga fuera del catálogo de subdivisiones no sirve ni como
  // dato: `subdivisionForRating` no lo encontraría y la ladder entera se
  // descartaría por culpa de una fila mala.
  if (subdivisionIndex(rankLevel) === null) {
    return null;
  }

  return { rankLevel, minRating };
}

/**
 * Valida el documento guardado en `Setting["alerts.divisionCutoffs"]` y devuelve
 * la tabla de cortes. **Nunca lanza**: una caché con una fila mala se pierde
 * (esa ladder) y el resto sigue sirviendo.
 *
 * Una ladder se **descarta entera** si le falta alguna subdivisión, porque con un
 * catálogo incompleto la cuenta de escalones de R5 saldría falseada sin aviso.
 * La lista de cuts viene ordenada de la más fuerte a la más débil y eso también
 * se comprueba: el orden es lo que hace que `subdivisionForRating` pueda parar en
 * el primer corte alcanzado.
 */
export function readCutoffsTable(stored: unknown): LadderCutoffsTable | null {
  if (!isRecord(stored) || !isRecord(stored.ladders)) {
    return null;
  }

  const table: LadderCutoffsTable = {};

  for (const [ladder, value] of Object.entries(stored.ladders)) {
    if (!isRecord(value) || !Array.isArray(value.cutoffs)) {
      continue;
    }

    const cutoffs = value.cutoffs.flatMap((cutoff) => {
      const leido = readCutoff(cutoff);

      return leido === null ? [] : [leido];
    });

    // Una fila que se ha descartado deja la lista incompleta, y una lista
    // incompleta es exactamente lo que este módulo no puede tolerar: se cae la
    // ladder entera en vez de servir unos cortes a medio camino.
    if (cutoffs.length !== value.cutoffs.length) {
      continue;
    }

    // La lista tiene que seguir el orden del catálogo de subdivisiones **y** tener
    // los cortes descendentes: son las dos cosas que hacen que
    // `subdivisionForRating` pueda parar en el primer corte alcanzado. Con cualquiera
    // de las dos rota, la ladder entera se descarta (mejor ningún corte que cortes
    // que situen la media de la partida en la división equivocada).
    const enOrden = cutoffs.every((cutoff, index) => {
      const anterior = cutoffs[index - 1];

      if (anterior === undefined) {
        return true;
      }

      const indiceAnterior = subdivisionIndex(anterior.rankLevel);
      const indiceActual = subdivisionIndex(cutoff.rankLevel);

      return (
        indiceAnterior !== null && indiceActual !== null && indiceActual > indiceAnterior
      );
    });

    const descendente = cutoffs.every((cutoff, index) => {
      const anterior = cutoffs[index - 1];

      return anterior === undefined || cutoff.minRating < anterior.minRating;
    });

    if (cutoffs.length === 0 || !enOrden || !descendente) {
      continue;
    }

    const derivedAt = typeof value.derivedAt === "string" ? value.derivedAt : null;
    const totalCount =
      typeof value.totalCount === "number" && Number.isInteger(value.totalCount)
        ? value.totalCount
        : 0;
    const requests =
      typeof value.requests === "number" && Number.isInteger(value.requests) ? value.requests : 0;

    table[ladder] = {
      ladder: typeof value.ladder === "string" ? value.ladder : ladder,
      derivedAt: derivedAt ?? "sin fecha",
      totalCount,
      cutoffs,
      requests,
    };
  }

  return Object.keys(table).length === 0 ? null : table;
}
