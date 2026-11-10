"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import type {
  OverlayClasificacion,
  OverlayEventoObjetivo,
  OverlayEventoObjetivoListado,
  OverlayObjetivo,
  OverlayParticipante,
} from "@/lib/overlay-api";
import {
  overlayEventKey,
  overlayEventView,
  overlayMergeEvents,
  overlayNewEventViews,
  overlayPollSince,
  overlayRecentCombined,
  overlayReconnectDelay,
  type OverlayEventView,
} from "@/lib/overlay-view";

/**
 * El estado del overlay: la única pieza que habla con `/api/v0`.
 *
 * Este hook no pinta nada; expone un contrato tipado para que la interfaz de
 * `/overlay` lo consuma sin saber cómo se refresca. Las reglas que ya son puras
 * viven en `@/lib/overlay-view` (ranking, vistas de evento, `desde`, backoff);
 * aquí solo queda el ciclo de vida: la carga inicial, el sondeo cada 30 s, la
 * pausa cuando la pestaña no se ve y el reintento con espera creciente.
 *
 * ## Contrato
 *
 * ```ts
 * const data = useOverlayData(profileId);
 * ```
 *
 * | Campo | Tipo | Qué es |
 * |---|---|---|
 * | `status` | `"loading" \| "ready" \| "not-found" \| "unavailable"` | La clasificación es crítica: sin ella no hay overlay. `not-found` es un 404 de la API y `unavailable`, un fallo de red o de la base. |
 * | `profileId` | `string` | El id que se está siguiendo. |
 * | `classification` | `OverlayClasificacion[] \| null` | La fila pedida y sus vecinos, tal cual los publica `/clasificacion`. |
 * | `participants` | `ReadonlyMap<string, OverlayParticipante>` | Alias, país y avatar por id. Si `/participantes` falla, mapa vacío. |
 * | `objectives` | `ReadonlyMap<string, OverlayObjetivo>` | Catálogo por id. Si `/objetivos` falla, mapa vacío. |
 * | `events` | `Record<string, OverlayEventoObjetivo>` | Último evento por objetivo, fusionado con cada sondeo. |
 * | `recentEvents` | `OverlayEventView[]` | Hasta 3 hitos positivos, del más reciente al más antiguo; combina el feed inicial con lo nuevo. |
 * | `queue` | `OverlayEventView[]` | Animaciones pendientes, en orden de llegada. |
 * | `currentEvent` | `OverlayEventView \| null` | `queue[0]`, o `null`. |
 * | `advanceQueue` | `() => void` | Desplaza la cola cuando termina la animación. |
 * | `retry` | `() => void` | Vuelve a empezar la carga tras `unavailable`. |
 * | `enqueueDemo` | `(objetivoId, evento) => void` | Encola una vista de demostración con clave única; la usa el botón «Probar animación». |
 * | `reconnecting` | `boolean` | Hay un fallo de sondeo y se está reintentando con backoff. |
 * | `lastUpdatedAt` | `number \| null` | Epoch en ms de la última respuesta buena, para «actualizado hace…». |
 *
 * `participants`, `objectives` y `events` son tolerantes a fallo: si sus rutas
 * fallan, el overlay sigue con lo que tenga y `recentEvents` cae al mapa de
 * `eventos_objetivos` de la clasificación. `classification` no lo es: sin ella el
 * estado pasa a `not-found` o `unavailable`.
 */

/** Cada cuánto se sondea la clasificación. */
const POLL_INTERVAL_MS = 30_000;
/** Sondeos entre refrescos del catálogo y de los participantes (≈ 10 min). */
const CATALOG_REFRESH_POLLS = 20;
/** Eventos que se piden en la carga inicial del feed. */
const INITIAL_EVENT_LIMIT = 12;
/** Tope de la cola de animación: evita que un reintento largo la deje creciendo. */
const QUEUE_LIMIT = 5;
/** Hitos recientes que se exponen en `recentEvents`. */
const RECENT_LIMIT = 3;

export type OverlayDataStatus = "loading" | "ready" | "not-found" | "unavailable";

/** El contrato que consume la interfaz de `/overlay`. */
export type OverlayData = {
  status: OverlayDataStatus;
  profileId: string;
  classification: OverlayClasificacion[] | null;
  participants: ReadonlyMap<string, OverlayParticipante>;
  objectives: ReadonlyMap<string, OverlayObjetivo>;
  events: Record<string, OverlayEventoObjetivo>;
  recentEvents: OverlayEventView[];
  queue: OverlayEventView[];
  currentEvent: OverlayEventView | null;
  advanceQueue: () => void;
  retry: () => void;
  enqueueDemo: (objetivoId: string, evento: OverlayEventoObjetivo) => void;
  reconnecting: boolean;
  lastUpdatedAt: number | null;
};

/**
 * Fusiona varios mapas de eventos quedándose con el más reciente por objetivo.
 *
 * No se usa `overlayMergeEvents` porque aquí los dos mapas vienen de fuentes
 * distintas —el feed y la clasificación— y el que se lee después no es
 * necesariamente el más nuevo.
 */
function newestEvents(
  ...records: Readonly<Record<string, OverlayEventoObjetivo>>[]
): Record<string, OverlayEventoObjetivo> {
  const merged: Record<string, OverlayEventoObjetivo> = {};

  for (const record of records) {
    for (const [objetivoId, event] of Object.entries(record)) {
      const previous = merged[objetivoId];

      if (previous === undefined || Date.parse(event.fechahora) >= Date.parse(previous.fechahora)) {
        merged[objetivoId] = event;
      }
    }
  }

  return merged;
}

/** Lee una lista JSON de una respuesta, o `[]` si no es una respuesta buena. */
async function readList<T>(response: Response | null): Promise<T[]> {
  if (response === null || !response.ok) {
    return [];
  }

  try {
    const data: unknown = await response.json();

    return Array.isArray(data) ? (data as T[]) : [];
  } catch {
    return [];
  }
}

/** El feed en forma de mapa, quedándose con lo más reciente de cada objetivo. */
function feedRecord(
  feed: readonly OverlayEventoObjetivoListado[],
): Record<string, OverlayEventoObjetivo> {
  const record: Record<string, OverlayEventoObjetivo> = {};

  for (const event of feed) {
    const previous = record[event.objetivo_id];

    if (previous === undefined || Date.parse(event.fechahora) >= Date.parse(previous.fechahora)) {
      record[event.objetivo_id] = event;
    }
  }

  return record;
}

export function useOverlayData(profileId: string): OverlayData {
  const [status, setStatus] = useState<OverlayDataStatus>("loading");
  const [classification, setClassification] = useState<OverlayClasificacion[] | null>(null);
  const [participants, setParticipants] = useState<ReadonlyMap<string, OverlayParticipante>>(
    new Map(),
  );
  const [objectives, setObjectives] = useState<ReadonlyMap<string, OverlayObjetivo>>(new Map());
  const [events, setEvents] = useState<Record<string, OverlayEventoObjetivo>>({});
  const [feed, setFeed] = useState<OverlayEventoObjetivoListado[]>([]);
  const [queue, setQueue] = useState<OverlayEventView[]>([]);
  const [reconnecting, setReconnecting] = useState(false);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    const localObjectives = new Map<string, OverlayObjetivo>();
    const seenKeys = new Set<string>();
    let disposed = false;
    let ready = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let polls = 0;
    let failures = 0;
    let lastSeenAt: string | null = null;
    let currentEvents: Record<string, OverlayEventoObjetivo> = {};
    let polling = false;

    function schedule(delay: number): void {
      if (disposed) {
        return;
      }

      if (timer !== null) {
        clearTimeout(timer);
      }

      timer = setTimeout(() => {
        timer = null;
        void runPoll();
      }, delay);
    }

    async function refreshCatalog(): Promise<void> {
      try {
        const [participantsResponse, objectivesResponse] = await Promise.all([
          fetch("/api/v0/participantes", { cache: "no-store", signal: controller.signal }),
          fetch("/api/v0/objetivos", { cache: "no-store", signal: controller.signal }),
        ]);
        const participantList = await readList<OverlayParticipante>(participantsResponse);
        const objectiveList = await readList<OverlayObjetivo>(objectivesResponse);

        if (disposed) {
          return;
        }

        if (participantsResponse.ok) {
          setParticipants(new Map(participantList.map((item) => [item.id, item])));
        }

        if (objectivesResponse.ok) {
          localObjectives.clear();

          for (const objective of objectiveList) {
            localObjectives.set(objective.id, objective);
          }

          setObjectives(new Map(localObjectives));
        }
      } catch {
        // El catálogo es tolerante a fallo: se conserva el de la última vez.
      }
    }

    async function runPoll(): Promise<void> {
      if (disposed || polling || document.visibilityState !== "visible") {
        return;
      }

      polling = true;

      try {
        const query = new URLSearchParams({ id: profileId });

        if (lastSeenAt !== null) {
          query.set("desde", lastSeenAt);
        }

        const response = await fetch(`/api/v0/clasificacion?${query.toString()}`, {
          cache: "no-store",
          signal: controller.signal,
        });

        // Un 404 en un sondeo ya no es un fallo de red: el participante ha
        // dejado de estar aprobado. Se corta el polling y se dice, en vez de
        // seguir enseñando una foto que ya no es cierta.
        if (response.status === 404) {
          setStatus("not-found");
          return;
        }

        if (!response.ok) {
          throw new Error(`La clasificación respondió ${response.status}`);
        }

        const rows = (await response.json()) as OverlayClasificacion[];

        if (disposed) {
          return;
        }

        const requested = rows.find((row) => row.id === String(profileId));
        const incoming = requested?.eventos_objetivos ?? {};
        const newViews = overlayNewEventViews(seenKeys, incoming, localObjectives, QUEUE_LIMIT);

        for (const [objetivoId, event] of Object.entries(incoming)) {
          seenKeys.add(overlayEventKey(objetivoId, event));
        }

        lastSeenAt = overlayPollSince(lastSeenAt, incoming, response.headers.get("date"));
        currentEvents = overlayMergeEvents(currentEvents, incoming);

        setEvents(currentEvents);
        setClassification(rows);
        setLastUpdatedAt(Date.now());

        if (newViews.length > 0) {
          setQueue((previous) => [...previous, ...newViews].slice(0, QUEUE_LIMIT));
        }

        failures = 0;
        polls += 1;
        setReconnecting(false);
        schedule(POLL_INTERVAL_MS);

        if (polls % CATALOG_REFRESH_POLLS === 0) {
          void refreshCatalog();
        }
      } catch (error) {
        if (disposed || (error instanceof DOMException && error.name === "AbortError")) {
          return;
        }

        failures += 1;
        setReconnecting(true);
        schedule(overlayReconnectDelay(failures));
      } finally {
        polling = false;
      }
    }

    function handleVisibility(): void {
      if (disposed || !ready) {
        return;
      }

      if (document.visibilityState !== "visible") {
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }

        return;
      }

      if (timer === null) {
        void runPoll();
      }
    }

    async function loadInitial(): Promise<void> {
      try {
        const id = encodeURIComponent(profileId);
        const [classificationResponse, participantsResponse, objectivesResponse, feedResponse] =
          await Promise.all([
            fetch(`/api/v0/clasificacion?id=${id}`, {
              cache: "no-store",
              signal: controller.signal,
            }),
            fetch("/api/v0/participantes", { cache: "no-store", signal: controller.signal }).catch(
              () => null,
            ),
            fetch("/api/v0/objetivos", { cache: "no-store", signal: controller.signal }).catch(
              () => null,
            ),
            fetch(`/api/v0/eventos?id=${id}&limite=${INITIAL_EVENT_LIMIT}`, {
              cache: "no-store",
              signal: controller.signal,
            }).catch(() => null),
          ]);

        if (disposed) {
          return;
        }

        if (classificationResponse.status === 404) {
          setStatus("not-found");
          return;
        }

        if (!classificationResponse.ok) {
          setStatus("unavailable");
          return;
        }

        const rows = (await classificationResponse.json()) as OverlayClasificacion[];
        const participantList = await readList<OverlayParticipante>(participantsResponse);
        const objectiveList = await readList<OverlayObjetivo>(objectivesResponse);
        const feedList = await readList<OverlayEventoObjetivoListado>(feedResponse);

        if (disposed) {
          return;
        }

        const participantMap = new Map(participantList.map((item) => [item.id, item]));
        const objectiveMap = new Map(objectiveList.map((item) => [item.id, item]));

        localObjectives.clear();

        for (const [idObjetivo, objective] of objectiveMap) {
          localObjectives.set(idObjetivo, objective);
        }

        const requested = rows.find((row) => row.id === String(profileId));
        const seedEvents = newestEvents(
          feedRecord(feedList),
          requested?.eventos_objetivos ?? {},
        );

        for (const [objetivoId, event] of Object.entries(seedEvents)) {
          seenKeys.add(overlayEventKey(objetivoId, event));
        }

        currentEvents = seedEvents;
        lastSeenAt = overlayPollSince(null, seedEvents, classificationResponse.headers.get("date"));
        ready = true;

        setClassification(rows);
        setParticipants(participantMap);
        setObjectives(new Map(localObjectives));
        setEvents(seedEvents);
        setFeed(feedList);
        setLastUpdatedAt(Date.now());
        setStatus("ready");
        setReconnecting(false);

        schedule(POLL_INTERVAL_MS);
      } catch {
        if (!disposed) {
          setStatus("unavailable");
        }
      }
    }

    document.addEventListener("visibilitychange", handleVisibility);
    void loadInitial();

    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", handleVisibility);

      if (timer !== null) {
        clearTimeout(timer);
      }

      controller.abort();
    };
  }, [profileId, attempt]);

  const retry = useCallback(() => {
    setStatus("loading");
    setClassification(null);
    setParticipants(new Map());
    setObjectives(new Map());
    setEvents({});
    setFeed([]);
    setQueue([]);
    setReconnecting(false);
    setLastUpdatedAt(null);
    setAttempt((value) => value + 1);
  }, []);

  const advanceQueue = useCallback(() => {
    setQueue((previous) => previous.slice(1));
  }, []);

  const enqueueDemo = useCallback(
    (objetivoId: string, evento: OverlayEventoObjetivo) => {
      const view = overlayEventView(objetivoId, evento, objectives.get(objetivoId));
      const demo: OverlayEventView = { ...view, key: `demo:${Date.now()}` };

      setQueue((previous) => [...previous, demo]);
    },
    [objectives],
  );

  const recentEvents = useMemo(
    () => overlayRecentCombined(feed, events, objectives, RECENT_LIMIT),
    [feed, events, objectives],
  );

  return {
    status,
    profileId,
    classification,
    participants,
    objectives,
    events,
    recentEvents,
    queue,
    currentEvent: queue[0] ?? null,
    advanceQueue,
    retry,
    enqueueDemo,
    reconnecting,
    lastUpdatedAt,
  };
}
