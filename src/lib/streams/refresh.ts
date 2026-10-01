import "server-only";

import { db } from "@/lib/db";
import { normalizeKickChannel, normalizeYoutubeChannel } from "@/lib/stream-channels";
import { getStreamsConfig, isYoutubeConfigured, type StreamsConfig } from "./env";
import { createStreamsHttpClient, StreamsError, type StreamsHttpClient } from "./http";
import { isKickChannelLive } from "./kick";
import { isYoutubeChannelLive } from "./youtube";

/**
 * Refresco del estado de directo de YouTube y Kick para los participantes que
 * tienen canal, una vez por pasada del sincronizador.
 *
 * ## Por qué va en el worker y no en el DAL ni en la web
 *
 * El despliegue es un Worker de Cloudflare en el plan **Free**: 10 ms de CPU por
 * invocación y del orden de 500 ms por pasada del sincronizador (README, "El límite
 * de CPU del plan Free"). Preguntar a dos plataformas externas **en cada visita a la
 * web** sería una petición saliente por lectura de página, con el riesgo de que la
 * cuota de la API de YouTube se la gaste un visitante y de que un corte de cualquiera
 * de las dos tire una pantalla que hoy no depende de ninguna API externa. La
 * detección vive aquí, una vez por pasada, para los participantes **aprobados** que
 * tengan canal, con un presupuesto acotado.
 *
 * Lo que hace el DAL es leer lo que este módulo ya escribió, que es lo mismo que
 * hace con `twitchIsLive` desde que la ladder lo publica.
 *
 * ## Fallar aquí no puede tumbar la pasada
 *
 * Ni por plataforma ni por canal: cada comprobación va en su propio `try`, un
 * `fatal` (una clave inválida, un `403` de Cloudflare) aparta el resto de esa
 * plataforma sin tragarse el error, y lo que no se ha podido comprobar **no se
 * escribe**. Un `false` escrito por un fallo publicaría "no está en directo", que es
 * una afirmación que no se sabe; el estado anterior se conserva y el motivo sale en
 * `warnings`, que el sincronizador escribe en `streamsError`.
 *
 * ## Solo se escribe lo que cambia
 *
 * Una pasada sin novedades (lo normal: 288 al día) no toca ni una fila de `Player`.
 * Es el mismo criterio que `recomputeScores()` con los puntos de `Match`, y por el
 * mismo motivo: `updatedAt` es información que la interfaz y el historial leen, y
 * una tabla que se reescribe entera cada cinco minutos no dice nada.
 */

/** Una fila de `Player` tal y como la necesita el refresco. */
export type StreamCandidate = {
  id: string;
  profileId: number;
  name: string;
  youtubeChannel: string | null;
  youtubeIsLive: boolean;
  kickChannel: string | null;
  kickIsLive: boolean;
};

export type StreamRefreshResult = {
  /** Participantes con al menos un canal, después de normalizar los que son válidos. */
  candidates: number;
  /** Comprobaciones realmente hechas (una por plataforma y canal). */
  checks: number;
  /** Canales que se han comprobado y estaban en directo. */
  live: number;
  /** Comprobaciones que no se han podido hacer (error de red, de cuota o de estado). */
  failures: number;
  /** Filas de `Player` escritas: solo las que han cambiado de valor. */
  updated: number;
  /** Canales que no se han comprobado: por el tope, por un error *fatal* o por el plazo. */
  skipped: number;
  /** Por qué no se ha comprobado algo, en texto legible. */
  warnings: string[];
  /** `true` si no hay `YOUTUBE_API_KEY` y la detección de YouTube está apagada. */
  youtubeDisabled: boolean;
  durationMs: number;
};

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : `Error desconocido: ${String(error)}`;
}

/**
 * Participantes aprobados con canal, ya normalizados.
 *
 * La normalización va aquí y no solo en el DAL porque esta lista decide a quién se
 * va a preguntar: preguntar por un canal que no existe es gastar cuota para nada.
 * `youtubeChannel`/`kickChannel` llegan de la columna, que solo se rellena por un
 * parser o por un alta, así que en el caso normal ya vienen limpios.
 */
async function readCandidates(profileIds: number[] | undefined): Promise<StreamCandidate[]> {
  const rows = await db.player.findMany({
    where: {
      status: "APPROVED",
      OR: [{ youtubeChannel: { not: null } }, { kickChannel: { not: null } }],
      ...(profileIds === undefined ? {} : { profileId: { in: profileIds } }),
    },
    select: {
      id: true,
      profileId: true,
      name: true,
      youtubeChannel: true,
      youtubeIsLive: true,
      kickChannel: true,
      kickIsLive: true,
    },
    orderBy: { profileId: "asc" },
  });

  return rows.map((row) => ({
    id: row.id,
    profileId: row.profileId,
    name: row.name,
    youtubeChannel: normalizeYoutubeChannel(row.youtubeChannel),
    youtubeIsLive: row.youtubeIsLive,
    kickChannel: normalizeKickChannel(row.kickChannel),
    kickIsLive: row.kickIsLive,
  }));
}

/**
 * Qué hay que escribir de una fila, o `null` si no ha cambiado nada.
 *
 * Se compara con lo que **ya estaba** en la fila leída, no con un estado anterior
 * de la pasada: las dos comprobaciones de una misma fila son independientes y el
 * valor guardado es la referencia.
 */
function diffPlayer(
  candidate: StreamCandidate,
  youtube: boolean | null,
  kick: boolean | null,
): { youtubeIsLive?: boolean; kickIsLive?: boolean } | null {
  const data: { youtubeIsLive?: boolean; kickIsLive?: boolean } = {};

  if (youtube !== null && youtube !== candidate.youtubeIsLive) {
    data.youtubeIsLive = youtube;
  }

  if (kick !== null && kick !== candidate.kickIsLive) {
    data.kickIsLive = kick;
  }

  return Object.keys(data).length === 0 ? null : data;
}

/**
 * Refresca el estado de directo y escribe solo lo que ha cambiado.
 *
 * ## El tope por pasada
 *
 * `maxChecksPerRun` es el presupuesto duro, y hay un detalle que importa: se
 * cuentan **comprobaciones** (una plataforma sobre un canal), no participantes. Al
 * llegar al tope, los participantes que quedan se dejan para la siguiente pasada y
 * salen como omitidos en `skipped`; con el torneo actual (decenas de participantes,
 * pocos con canal) el tope no muerde, y si algún día muerde está documentado en
 * `env.ts` y se ajusta por entorno sin desplegar.
 *
 * **Sin participantes con canal no se sale a la red ni se lee nada de `Setting`**: es
 * la respuesta a "una pasada sin nada que hacer no debe gastarse presupuesto", y por
 * eso la comprobación es la primera, antes de crear el cliente HTTP.
 *
 * ## Lo que no se comprueba
 *
 * Tres motivos, y los tres cuentan como omitido en vez de como fallo: que se haya
 * alcanzado el tope, que la plataforma ya se haya apartado en esta pasada por un
 * error que no mejora con reintentos (una clave inválida, un `403` de Cloudflare), o
 * que el plazo global de la pasada se haya agotado. Por eso `checks + skipped` cuadra
 * con los canales que había, salvo cuando el tope recorta a mitad de un participante.
 *
 * ## Cancelación
 *
 * `signal` es el plazo global de la pasada (`AOE4WORLD_SYNC_DEADLINE_MS`). Si se
 * agota a mitad, lo ya comprobado **se escribe** —tirar el trabajo hecho sería
 * repetirlo todo en la siguiente pasada— y lo que queda sin mirar sale como omitido.
 */
export async function refreshStreamLiveStatus(
  options: {
    /** Limita el refresco a estos `profileId` (por defecto, todos los aprobados). */
    profileIds?: number[];
    /** Plazo global de la pasada. */
    signal?: AbortSignal;
    /** Inyecta un cliente alternativo (verificaciones con datos de ejemplo). */
    http?: StreamsHttpClient;
    config?: StreamsConfig;
  } = {},
): Promise<StreamRefreshResult> {
  const startedAtMs = Date.now();
  const config = options.config ?? getStreamsConfig();
  const youtubeEnabled = isYoutubeConfigured(config);

  const result: StreamRefreshResult = {
    candidates: 0,
    checks: 0,
    live: 0,
    failures: 0,
    updated: 0,
    skipped: 0,
    warnings: [],
    youtubeDisabled: !youtubeEnabled,
    durationMs: 0,
  };

  const candidates = (await readCandidates(options.profileIds)).filter(
    (candidate) => candidate.youtubeChannel !== null || candidate.kickChannel !== null,
  );

  result.candidates = candidates.length;

  // Sin nadie con canal no hay nada que hacer: ni una petición, ni una escritura,
  // ni una lectura de la caché de `channelId`. Es el caso de un torneo sin canales
  // de YouTube o Kick, y es el que hace que este módulo no cueste nada por defecto.
  if (candidates.length === 0) {
    result.durationMs = Date.now() - startedAtMs;

    return result;
  }

  if (!youtubeEnabled) {
    result.warnings.push(
      "Sin YOUTUBE_API_KEY no se comprueba el directo de YouTube: los canales quedan como están (false).",
    );
  }

  const http = options.http ?? createStreamsHttpClient(config);
  const now = new Date();

  // Un `fatal` aparta el resto de la plataforma en esta pasada: repetir las mismas
  // llamadas con una clave inválida o contra un `403` de Cloudflare solo gastaría el
  // presupuesto del tope y llenaría el log de lo mismo.
  let youtubeAbandoned: string | null = null;
  let kickAbandoned: string | null = null;

  for (const candidate of candidates) {
    if (result.checks >= config.maxChecksPerRun) {
      result.skipped += 1;
      continue;
    }

    let youtube: boolean | null = null;
    let kick: boolean | null = null;

    // Cada plataforma se mira por su cuenta, y con el mismo criterio: si ya se sabe
    // que va a fallar (plazo agotado) o que se ha apartado, no se intenta. Lo que no
    // se comprueba cuenta como omitido, para que `checks + skipped` cuadre con los
    // canales que había y el resumen no dé una cifra que no es.
    if (candidate.youtubeChannel !== null && !youtubeEnabled) {
      result.skipped += 1;
    } else if (candidate.youtubeChannel !== null && youtubeAbandoned !== null) {
      result.skipped += 1;
    } else if (candidate.youtubeChannel !== null) {
      if (options.signal?.aborted === true) {
        result.skipped += 1;
      } else {
        result.checks += 1;

        try {
          youtube = await isYoutubeChannelLive(
            candidate.youtubeChannel,
            http,
            config,
            { signal: options.signal },
            now,
          );
        } catch (error) {
          result.failures += 1;
          result.warnings.push(`YouTube de ${candidate.name}: ${toErrorMessage(error)}`);

          if (error instanceof StreamsError && error.fatal) {
            youtubeAbandoned = toErrorMessage(error);
            result.warnings.push(
              `YouTube se deja de comprobar en esta pasada: ${youtubeAbandoned}`,
            );
          }
        }
      }
    }

    if (candidate.kickChannel !== null && kickAbandoned === null) {
      if (options.signal?.aborted === true) {
        result.skipped += 1;
      } else {
        result.checks += 1;

        try {
          kick = await isKickChannelLive(candidate.kickChannel, http, config, {
            signal: options.signal,
          });
        } catch (error) {
          result.failures += 1;
          result.warnings.push(`Kick de ${candidate.name}: ${toErrorMessage(error)}`);

          if (error instanceof StreamsError && error.fatal) {
            kickAbandoned = toErrorMessage(error);
            result.warnings.push(`Kick se deja de comprobar en esta pasada: ${kickAbandoned}`);
          }
        }
      }
    } else if (candidate.kickChannel !== null) {
      result.skipped += 1;
    }

    if (youtube === true || kick === true) {
      result.live += (youtube === true ? 1 : 0) + (kick === true ? 1 : 0);
    }

    const data = diffPlayer(candidate, youtube, kick);

    if (data === null) {
      continue;
    }

    try {
      await db.player.update({ where: { id: candidate.id }, data });
      result.updated += 1;
    } catch (error) {
      // Una escritura fallida es un fallo más del resumen, no una excepción: el
      // estado que se ha comprobado se pierde, pero la pasada sigue y la próxima
      // vuelve a intentarlo.
      result.failures += 1;
      result.warnings.push(
        `No se ha podido guardar el estado de directo de ${candidate.name}: ${toErrorMessage(error)}`,
      );
    }
  }

  result.durationMs = Date.now() - startedAtMs;

  return result;
}

/**
 * La línea que va al rastro del sincronizador (`streamsError`), o `null` si no hay
 * nada que decir.
 *
 * `null` cuando no había nadie con canal o cuando todo fue bien: el rastro existe
 * para que se vea un problema, y repetir "todo bien" 288 veces al día es ruido que
 * esconde el único caso que importa.
 *
 * Lo que **no** son fallos también se escriben aquí, y el caso de referencia es la
 * falta de `YOUTUBE_API_KEY`: es permanente, así que si no sale en el rastro no hay
 * ningún sitio donde se vea que la detección de YouTube lleva apagada desde el día
 * que se puso en marcha. Y no por eso el rastro marca el sincronizador como roto:
 * `writeSyncRunTrace()` no mira `streamsError` para mover `lastSuccessAt`, igual que
 * hace con `alertsError`, porque no saber si alguien está emitiendo no ha parado ni
 * una partida.
 */
export function describeStreamRefresh(result: StreamRefreshResult): string | null {
  if (result.candidates === 0) {
    return null;
  }

  if (result.failures === 0 && result.skipped === 0 && result.warnings.length === 0) {
    return null;
  }

  const partes = [
    `${result.candidates} con canal`,
    `${result.checks} comprobaciones`,
    result.live === 0 ? null : `${result.live} en directo`,
    result.failures === 0 ? null : `${result.failures} fallo(s)`,
    result.skipped === 0 ? null : `${result.skipped} sin comprobar`,
  ].filter((parte): parte is string => parte !== null);

  return [`Directos (YouTube/Kick): ${partes.join(", ")}.`, ...result.warnings].join(" ");
}