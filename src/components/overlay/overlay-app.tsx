"use client";

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Check } from "@phosphor-icons/react/dist/csr/Check";
import { Coin } from "@phosphor-icons/react/dist/csr/Coin";
import { Columns } from "@phosphor-icons/react/dist/csr/Columns";
import { Diamond } from "@phosphor-icons/react/dist/csr/Diamond";
import { X } from "@phosphor-icons/react/dist/csr/X";

import type { OverlayEventoObjetivo, OverlayObjetoEvento } from "@/lib/overlay-api";
import { countryFlagUrl } from "@/lib/flag";
import {
  overlayEventCompleted,
  overlayEventKind,
  overlayEventLoss,
  overlayEventProgress,
  overlayEventReward,
  overlayFocusKey,
  overlayObjetoAlivio,
  overlayObjetoAntetitulo,
  overlayObjetoConsecuencia,
  overlayObjetoContrario,
  overlayObjetoDesventaja,
  overlayRankingRows,
  type OverlayConfig,
  type OverlayEventView,
  type OverlayPosition,
  type OverlayRankingRow,
  type OverlaySize,
} from "@/lib/overlay-view";
import { OverlayCard, OverlayCardHeader } from "@/components/overlay/overlay-card";
import { OverlayObjectiveIcon } from "@/components/overlay/overlay-objective-icon";
import { useOverlayData } from "@/components/overlay/use-overlay-data";

/** Los dos pasos de la animación de un evento: la ficha y lo que deja. */
type FocusStep = "ficha" | "consecuencia";

/** Lo que dura la ficha del evento antes de pasar a la consecuencia. */
const FICHA_DURATION_MS = 4_000;

/** Lo que dura la consecuencia antes de volver a la vista fija. */
const CONSECUENCIA_DURATION_MS = 3_000;

/** El glifo de cada objeto; el contrato publica los tres ids en minúsculas. */
const OBJETO_GLYPH: Readonly<Record<string, typeof Diamond>> = {
  reliquia: Diamond,
  moneda: Coin,
  monumento: Columns,
};

/** Emblema de la casa, para cuando la edición no publica uno. */
const HOUSE_EMBLEM = "/imagenes/marca/emblema-256.png";

/** Dónde se ancla la tarjeta dentro del lienzo del overlay. */
const POSITION_LAYOUT: Readonly<Record<OverlayPosition, string>> = {
  tr: "items-start justify-end",
  tl: "items-start justify-start",
  br: "items-end justify-end",
  bl: "items-end justify-start",
};

/** Desde qué esquina crece la tarjeta al escalarla, para no desanclarla. */
const POSITION_ORIGIN: Readonly<Record<OverlayPosition, string>> = {
  tr: "top right",
  tl: "top left",
  br: "bottom right",
  bl: "bottom left",
};

/** Cuánto crece o mengua la tarjeta sin tocar su ancho base. */
const CARD_SCALE: Readonly<Record<OverlaySize, number>> = {
  compacto: 0.85,
  normal: 1,
  grande: 1.15,
};

/**
 * La tarjeta del overlay del directo.
 *
 * La página que la monta solo aporta la marca de la edición y la configuración
 * que viaja en la URL; todo lo demás sale de `useOverlayData`, que es quien
 * habla con `/api/v0`. Aquí se decide la vista: ranking con los vecinos del
 * jugador, tarjeta de foco mientras hay una animación en cola —un objetivo o un
 * objeto— y los últimos objetivos debajo. El estado de carga y los errores son
 * parte del diseño, no un añadido.
 *
 * La rotación de la cola la gobierna este componente: cada evento se queda
 * `FICHA_DURATION_MS` en la ficha, `CONSECUENCIA_DURATION_MS` en el cierre y
 * después llama a `advanceQueue()`. Cuando la cola se vacía, vuelve el ranking. Con `prefers-reduced-motion` no hay desplazamiento, pero la
 * rotación sigue: ocultar la información no es una preferencia de movimiento. Si
 * la URL desactiva las animaciones, no hay evento activo y la cola no se pinta ni
 * avanza; el ranking se queda fijo.
 */
export function OverlayApp({
  profileId,
  editionName,
  editionEmblem,
  accentStyle,
  config,
}: {
  profileId: string;
  editionName: string | null;
  editionEmblem: string | null;
  accentStyle?: CSSProperties;
  config: OverlayConfig;
}) {
  const reduceMotion = useReducedMotion() ?? false;
  const {
    status,
    classification,
    participants,
    recentEvents,
    queue,
    currentFocus,
    advanceQueue,
    retry,
    enqueueDemo,
    enqueueObjetoDemo,
    reconnecting,
  } = useOverlayData(profileId);

  const activeFocus = config.animaciones ? currentFocus : null;
  const activeKey = activeFocus === null ? null : overlayFocusKey(activeFocus);
  const showRanking = config.secciones !== "objetivos";
  const showObjectives = config.secciones !== "ranking";
  // Con las dos secciones se reserva la altura de la ventana de animación, para
  // que la tarjeta no cambie de tamaño entre pasos. Con una sola, el alto lo pone
  // el contenido y la tarjeta solo crece mientras dura el evento.
  const reserveBodyHeight = showRanking && showObjectives;

  // La animación de un evento tiene dos pasos: la ficha y la consecuencia. La
  // fase se guarda con la clave del evento para que uno nuevo empiece siempre
  // por la ficha, sin un efecto que la reinicie.
  const [phase, setPhase] = useState<{ key: string; step: FocusStep } | null>(null);
  const step: FocusStep = phase !== null && phase.key === activeKey ? phase.step : "ficha";

  useEffect(() => {
    if (activeKey === null) {
      return;
    }

    const timer = setTimeout(() => {
      if (step === "ficha") {
        setPhase({ key: activeKey, step: "consecuencia" });
        return;
      }

      setPhase(null);
      advanceQueue();
    }, step === "ficha" ? FICHA_DURATION_MS : CONSECUENCIA_DURATION_MS);

    return () => clearTimeout(timer);
  }, [activeKey, step, advanceQueue]);

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (event.origin !== window.location.origin) {
        return;
      }

      const demo = readDemoMessage(event.data);

      if (demo !== null) {
        enqueueDemo(demo.objetivoId, demo.evento);
        return;
      }

      const objetoDemo = readObjetoDemoMessage(event.data);

      if (objetoDemo !== null) {
        enqueueObjetoDemo(objetoDemo);
      }
    }

    window.addEventListener("message", onMessage);

    return () => window.removeEventListener("message", onMessage);
  }, [enqueueDemo, enqueueObjetoDemo]);

  const rows = useMemo(
    () =>
      classification === null
        ? []
        : overlayRankingRows(classification, participants, profileId),
    [classification, participants, profileId],
  );

  const subtitle =
    status === "loading"
      ? "Conectando"
      : status === "not-found"
        ? "No disponible"
        : status === "unavailable"
          ? "Sin conexión"
          : activeFocus !== null
            ? activeFocus.clase === "objeto"
              ? "Objeto"
              : "Objetivo"
            : reconnecting
              ? "Reconectando"
              : showRanking
                ? "Clasificación"
                : "Objetivos";

  return (
    <div
      style={accentStyle}
      className={`fixed inset-0 flex p-4 sm:p-6 ${POSITION_LAYOUT[config.posicion]}`}
    >
      <OverlayCard
        style={{
          transform: `scale(${CARD_SCALE[config.tamano]})`,
          transformOrigin: POSITION_ORIGIN[config.posicion],
        }}
      >
        <OverlayCardHeader
          emblem={editionEmblem ?? HOUSE_EMBLEM}
          title={editionName ?? "Liga Hispana"}
          subtitle={subtitle}
        />

        {status === "loading" ? <LoadingBody /> : null}

        {status === "not-found" ? (
          <ErrorBody
            title="Participante no encontrado"
            body={`No hay ningún participante aprobado con el identificador ${profileId}. Comprueba la URL del overlay.`}
          />
        ) : null}

        {status === "unavailable" ? (
          <ErrorBody
            title="No se ha podido cargar el overlay"
            body="La clasificación no ha respondido. Se volverá a intentar, o puedes reintentarlo ahora."
            onRetry={retry}
          />
        ) : null}

        {status === "ready" ? (
          <div className={reserveBodyHeight ? "h-[13rem]" : undefined}>
            <AnimatePresence mode="wait" initial={false}>
              {activeFocus !== null ? (
                <motion.div
                  key={`${activeKey}:${step}`}
                  className="h-full"
                  initial={reduceMotion ? false : { opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -6 }}
                  transition={{ duration: reduceMotion ? 0.12 : 0.28, ease: "easeOut" }}
                >
                  {step === "ficha" ? (
                    activeFocus.clase === "objetivo" ? (
                      <EventFocus view={activeFocus.vista} pending={queue.length} />
                    ) : (
                      <ObjetoFocus view={activeFocus.vista} pending={queue.length} />
                    )
                  ) : activeFocus.clase === "objetivo" ? (
                    <RewardFocus view={activeFocus.vista} />
                  ) : (
                    <ObjetoConsecuencia view={activeFocus.vista} />
                  )}
                </motion.div>
              ) : (
                <motion.div
                  key="card"
                  className="h-full"
                  initial={reduceMotion ? false : { opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: reduceMotion ? 0.12 : 0.22 }}
                >
                  <CardBody
                    rows={rows}
                    recentEvents={recentEvents}
                    showRanking={showRanking}
                    showObjectives={showObjectives}
                  />
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        ) : null}
      </OverlayCard>
    </div>
  );
}

/** Aviso de carga: la marca ya está en la cabecera, aquí solo late la espera. */
function LoadingBody() {
  return (
    <div role="status" className="flex flex-col gap-2 px-3 py-3">
      <span className="sr-only">Cargando el overlay</span>
      <div aria-hidden="true" className="flex items-center gap-2">
        <span className="size-2 animate-pulse rounded-full bg-accent motion-reduce:animate-none" />
        <span className="text-[9px] font-medium uppercase tracking-[0.18em] text-muted">
          Conectando con la clasificación
        </span>
      </div>
      <div aria-hidden="true" className="flex flex-col gap-1.5">
        <span className="h-2.5 w-[88%] animate-pulse rounded bg-surface-raised motion-reduce:animate-none" />
        <span className="h-2.5 w-[76%] animate-pulse rounded bg-surface-raised motion-reduce:animate-none" />
        <span className="h-2.5 w-[64%] animate-pulse rounded bg-surface-raised motion-reduce:animate-none" />
      </div>
    </div>
  );
}

/** Tarjeta de error. La de red lleva «Reintentar»; la de un id inválido, no. */
function ErrorBody({
  title,
  body,
  onRetry,
}: {
  title: string;
  body: string;
  onRetry?: () => void;
}) {
  return (
    <div className="flex flex-col items-start gap-2 px-3 py-4">
      <p className="font-display text-[13px] font-semibold text-foreground">{title}</p>
      <p className="text-[11px] leading-relaxed text-muted">{body}</p>
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="mt-1 inline-flex min-h-8 items-center justify-center rounded-md border border-accent/50 bg-accent/10 px-3 text-xs font-semibold text-accent transition-colors hover:bg-accent/20"
        >
          Reintentar
        </button>
      ) : null}
    </div>
  );
}

/** El cuerpo de la tarjeta: el ranking, los últimos objetivos o las dos cosas. */
function CardBody({
  rows,
  recentEvents,
  showRanking,
  showObjectives,
}: {
  rows: OverlayRankingRow[];
  recentEvents: OverlayEventView[];
  showRanking: boolean;
  showObjectives: boolean;
}) {
  const hasObjectives = showObjectives && recentEvents.length > 0;

  return (
    <div>
      {showRanking ? (
        rows.length > 0 ? (
          <ol className="divide-y divide-line/60">
            {rows.map((row) => (
              <RankingRow key={row.id} row={row} />
            ))}
          </ol>
        ) : (
          <p className="px-3 py-4 text-[11px] leading-relaxed text-muted">
            Todavía no hay una clasificación publicada para este jugador.
          </p>
        )
      ) : null}

      {hasObjectives ? (
        <section
          className={`px-3 py-2 ${showRanking ? "border-t border-accent/20" : ""}`}
        >
          <h2 className="mb-1.5 text-[9px] font-medium uppercase tracking-[0.18em] text-muted">
            Últimos objetivos
          </h2>
          <ul className="flex flex-col gap-1">
            {recentEvents.map((view) => (
              <RecentRow key={view.key} view={view} />
            ))}
          </ul>
        </section>
      ) : null}

      {showObjectives && !hasObjectives && !showRanking ? (
        <p className="px-3 py-4 text-[11px] leading-relaxed text-muted">
          Sin objetivos todavía.
        </p>
      ) : null}
    </div>
  );
}

/** El color de la medalla según el puesto; del cuarto en adelante, neutro. */
const PODIUM_TONE: Readonly<Record<number, string>> = {
  1: "text-accent",
  2: "text-podium-silver",
  3: "text-podium-bronze",
};

function RankingRow({ row }: { row: OverlayRankingRow }) {
  const flag = countryFlagUrl(row.pais);
  const medal = PODIUM_TONE[row.posicion];

  return (
    <li
      className={`relative flex items-center gap-2 px-3 py-1.5 ${
        row.isRequested ? "bg-accent/10" : ""
      }`}
    >
      {row.isRequested ? (
        <span
          aria-hidden="true"
          className="absolute inset-y-0 left-0 w-0.5 bg-accent"
        />
      ) : null}

      <span
        className={`inline-flex size-5 shrink-0 items-center justify-center rounded-full border text-[10px] font-semibold tabular-nums ${
          medal ? `border-current ${medal}` : "border-line-strong text-muted"
        }`}
      >
        {row.posicion}
      </span>

      {flag ? (
        // eslint-disable-next-line @next/next/no-img-element -- bandera de flagcdn
        <img
          src={flag}
          alt={row.pais ?? ""}
          width={15}
          height={10}
          loading="lazy"
          decoding="async"
          className="h-2.5 w-[15px] shrink-0 rounded-[1px] object-cover"
        />
      ) : null}

      <span
        className={`min-w-0 flex-1 truncate text-[13px] ${
          row.isRequested ? "font-semibold text-foreground" : "text-foreground/90"
        }`}
      >
        {row.alias}
      </span>

      <span className="shrink-0 text-[13px] font-semibold tabular-nums text-foreground">
        {row.puntos.toLocaleString("es-ES")}
        <span className="ml-0.5 text-[9px] font-normal text-muted">pts</span>
      </span>
    </li>
  );
}

function RecentRow({ view }: { view: OverlayEventView }) {
  const progress = overlayEventProgress(view);
  const showProgress = progress !== "Cumplido" && progress !== "Perdido";

  return (
    <li className="flex items-center gap-1.5">
      <OverlayObjectiveIcon
        iconoUrl={view.iconoUrl}
        objetivoId={view.objetivoId}
        className="size-4 shrink-0 text-muted"
      />
      <span className="min-w-0 flex-1 truncate text-[11px] text-foreground/90">
        {view.nombre}
      </span>
      {overlayEventCompleted(view) ? (
        <span className="flex shrink-0 items-center text-accent">
          <Check size={13} aria-hidden="true" />
          <span className="sr-only">Cumplido</span>
        </span>
      ) : null}
      {showProgress ? (
        <span className="shrink-0 text-[10px] tabular-nums text-muted">
          {progress}
        </span>
      ) : null}
    </li>
  );
}

/**
 * La ficha del objetivo, el primer paso de la animación.
 *
 * Según el reparto del objetivo (`overlayEventKind`): los directos no llevan
 * cifra, las metas llevan su progreso (`3/3`, `14/14`) y los lideratos, «1º» en
 * su lugar. El tick verde marca lo conseguido; un `perdido` de competición lo
 * cambia por una X roja, porque el evento solo llega aquí cuando cobra o pierde.
 */
function EventFocus({ view, pending }: { view: OverlayEventView; pending: number }) {
  const kind = overlayEventKind(view);
  const lost = view.tipo === "perdido";

  return (
    <div className="flex h-full flex-col items-center justify-center gap-1.5 px-3 py-3 text-center">
      <span className="flex size-14 items-center justify-center rounded-md border border-accent/30 bg-surface-raised/60 text-accent">
        <OverlayObjectiveIcon
          iconoUrl={view.iconoUrl}
          objetivoId={view.objetivoId}
          className="size-9"
        />
      </span>

      <span
        aria-hidden="true"
        className={`flex size-6 items-center justify-center rounded-full border ${
          lost
            ? "border-loss/50 bg-loss/10 text-loss"
            : "border-accent/40 bg-accent/10 text-accent"
        }`}
      >
        {lost ? <X size={15} aria-hidden="true" /> : <Check size={15} aria-hidden="true" />}
      </span>

      <p className="font-display text-[15px] font-semibold leading-tight text-foreground">
        {view.nombre}
      </p>

      {view.descripcion !== "" ? (
        <p className="line-clamp-2 max-w-[30ch] text-[11px] leading-relaxed text-muted">
          {view.descripcion}
        </p>
      ) : null}

      {kind === "meta" ? (
        <p className="font-display text-[13px] font-semibold tabular-nums text-accent-strong">
          {overlayEventProgress(view)}
        </p>
      ) : null}

      {kind === "liderato" ? (
        <p
          className={`font-display text-[15px] font-semibold tabular-nums ${
            lost ? "text-loss" : "text-accent-strong"
          }`}
        >
          {lost ? "2º" : "1º"}
        </p>
      ) : null}

      <PendingDots count={pending} />
    </div>
  );
}

/** Los puntos de cola: el evento en curso y hasta cuatro esperas detrás. */
function PendingDots({ count }: { count: number }) {
  if (count <= 1) {
    return null;
  }

  return (
    <span aria-hidden="true" className="mt-0.5 flex items-center gap-1">
      {Array.from({ length: Math.min(count, 5) }, (_, index) => (
        <span
          key={index}
          className={`size-1 rounded-full ${index === 0 ? "bg-accent" : "bg-line-strong"}`}
        />
      ))}
    </span>
  );
}

/**
 * La recompensa o la pérdida, el segundo paso de la animación.
 *
 * Ocupa la misma ventana que la ficha y solo enseña lo que ha dado (o quitado) el
 * evento. Una competición ganada avisa de que los puntos son temporales; una
 * perdida los enseña en negativo y en rojo.
 */
function RewardFocus({ view }: { view: OverlayEventView }) {
  const loss = overlayEventLoss(view);
  const amount = loss ?? overlayEventReward(view) ?? 0;
  const lost = loss !== null;
  const temporary = !lost && overlayEventKind(view) === "liderato";

  return (
    <div className="flex h-full flex-col items-center justify-center px-3 py-4 text-center">
      <p
        className={`text-[10px] font-medium uppercase tracking-[0.24em] ${
          lost ? "text-loss" : "text-accent"
        }`}
      >
        {lost ? "Pérdida:" : "Recompensa:"}
      </p>

      <p
        className={`mt-3 font-display text-[44px] font-semibold leading-none tabular-nums ${
          lost ? "text-loss" : "text-accent-strong"
        }`}
      >
        {lost ? `-${amount}` : `+${amount}`}
      </p>

      <p
        className={`mt-1 text-[10px] font-medium uppercase tracking-[0.22em] ${
          lost ? "text-loss" : "text-muted"
        }`}
      >
        puntos
      </p>

      {temporary ? (
        <p className="mt-2 max-w-[28ch] text-[10px] leading-relaxed text-muted">
          Temporales: se pierden si dejas de ser 1º.
        </p>
      ) : null}
    </div>
  );
}

/**
 * La ficha del objeto, el primer paso de su animación.
 *
 * Dice de un vistazo qué le ha pasado al jugador: el antetítulo lleva el
 * sentido del evento, el glifo y el nombre identifican el objeto, la desventaja
 * explica lo que arrastra y la última línea nombra al contrario o el premio del
 * día. La línea de la desventaja se omite si el catálogo ya no la conoce, y la
 * del contrario, si no hay a quién nombrar: la ficha nunca inventa un alias.
 */
function ObjetoFocus({ view, pending }: { view: OverlayObjetoEvento; pending: number }) {
  const Glifo = OBJETO_GLYPH[view.objeto.id] ?? Diamond;
  const contrario = overlayObjetoContrario(view);
  const desventaja = overlayObjetoDesventaja(view.desventaja);

  return (
    <div className="flex h-full flex-col items-center justify-center gap-1 px-3 py-3 text-center">
      <p className="text-[9px] font-medium uppercase tracking-[0.22em] text-accent">
        {overlayObjetoAntetitulo(view.tipo)}
      </p>

      <span className="flex size-14 items-center justify-center rounded-md border border-accent/30 bg-surface-raised/60 text-accent">
        <Glifo size={36} aria-hidden="true" />
      </span>

      <p className="font-display text-[15px] font-semibold leading-tight text-foreground">
        {view.objeto.nombre}
      </p>

      {desventaja !== null ? (
        <p className="line-clamp-2 max-w-[30ch] text-[11px] leading-relaxed text-muted">
          {desventaja}
        </p>
      ) : null}

      {contrario !== null ? (
        <p className="max-w-[30ch] truncate text-[10px] font-medium uppercase tracking-[0.16em] text-foreground/80">
          {contrario}
        </p>
      ) : null}

      <PendingDots count={pending} />
    </div>
  );
}

/**
 * La consecuencia, el segundo paso de un evento de objeto.
 *
 * Cierra la tarjeta con la frase que resume qué cambia a partir de ahora y no
 * con una cifra: un objeto no da puntos, da una carga, se la quita o se la
 * devuelve. El color marca la polaridad (alivio al lanzarlo, carga al recibirlo
 * o al recuperarlo) y el glifo mantiene la continuidad con la ficha.
 */
function ObjetoConsecuencia({ view }: { view: OverlayObjetoEvento }) {
  const alivio = overlayObjetoAlivio(view.tipo);
  const Glifo = OBJETO_GLYPH[view.objeto.id] ?? Diamond;
  const tono = alivio ? "text-accent" : "text-loss";

  return (
    <div className="flex h-full flex-col items-center justify-center px-3 py-4 text-center">
      <p className={`text-[10px] font-medium uppercase tracking-[0.24em] ${tono}`}>
        Consecuencia:
      </p>

      <Glifo size={22} aria-hidden="true" className={`mt-3 ${tono}`} />

      <p className="mt-2 max-w-[26ch] text-[12px] leading-relaxed text-foreground/90">
        {overlayObjetoConsecuencia(view.tipo)}
      </p>
    </div>
  );
}

/**
 * Valida el `postMessage` de demostración del configurador.
 *
 * Solo se acepta la forma mínima que necesita `enqueueDemo`: un id de objetivo y
 * un evento con tipo, fecha y progreso propio. Todo lo demás se descarta, porque
 * el mensaje llega de la misma origen pero no deja de ser una entrada externa.
 */
function readDemoMessage(
  value: unknown,
): { objetivoId: string; evento: OverlayEventoObjetivo } | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const data = value as Record<string, unknown>;

  if (data.type !== "overlay:demo") {
    return null;
  }

  if (typeof data.objetivoId !== "string" || data.objetivoId === "") {
    return null;
  }

  const raw = data.evento;

  if (typeof raw !== "object" || raw === null) {
    return null;
  }

  const evento = raw as Record<string, unknown>;
  const tipo = evento.tipo;

  if (
    tipo !== "cumplido" &&
    tipo !== "perdido" &&
    tipo !== "progresado"
  ) {
    return null;
  }

  if (typeof evento.fechahora !== "string") {
    return null;
  }

  const progreso = evento.progreso;

  if (typeof progreso !== "object" || progreso === null) {
    return null;
  }

  const propio = (progreso as Record<string, unknown>).propio;

  if (typeof propio !== "number" || !Number.isFinite(propio)) {
    return null;
  }

  const result: OverlayEventoObjetivo = {
    tipo,
    fechahora: evento.fechahora,
    progreso: { propio },
  };

  if (typeof evento.repeticion === "number" && Number.isFinite(evento.repeticion)) {
    result.repeticion = evento.repeticion;
  }

  return { objetivoId: data.objetivoId, evento: result };
}

/**
 * Valida el `postMessage` de un objeto de demostración.
 *
 * Misma regla que el de objetivos: llega del mismo origen, pero no deja de ser
 * una entrada externa. Se exige la forma mínima que pinta la tarjeta —tipo,
 * fecha, objeto con nombre y desventaja—; el contrario es opcional y, si viene,
 * tiene que ser un jugador con alias.
 */
function readObjetoDemoMessage(value: unknown): OverlayObjetoEvento | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const data = value as Record<string, unknown>;

  if (data.type !== "overlay:demo-objeto") {
    return null;
  }

  const raw = data.evento;

  if (typeof raw !== "object" || raw === null) {
    return null;
  }

  const evento = raw as Record<string, unknown>;
  const tipo = evento.tipo;

  if (tipo !== "recibido" && tipo !== "lanzado" && tipo !== "devuelto") {
    return null;
  }

  if (typeof evento.fechahora !== "string" || typeof evento.desventaja !== "string") {
    return null;
  }

  const objeto = evento.objeto;

  if (typeof objeto !== "object" || objeto === null) {
    return null;
  }

  const { id, nombre } = objeto as Record<string, unknown>;

  if (typeof id !== "string" || id === "" || typeof nombre !== "string" || nombre === "") {
    return null;
  }

  const contrario = readObjetoContrario(evento.contrario);

  if (contrario === undefined) {
    return null;
  }

  return {
    id: typeof evento.id === "string" && evento.id !== "" ? evento.id : `demo:${Date.now()}`,
    tipo,
    fechahora: evento.fechahora,
    objeto: { id, nombre },
    desventaja: evento.desventaja,
    contrario,
  };
}

/** El contrario de un mensaje de demo: `undefined` si no tiene la forma esperada. */
function readObjetoContrario(
  value: unknown,
): { alias: string; pais: string | null } | null | undefined {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value !== "object") {
    return undefined;
  }

  const raw = value as Record<string, unknown>;

  if (typeof raw.alias !== "string" || raw.alias === "") {
    return undefined;
  }

  if (raw.pais === null || raw.pais === undefined) {
    return { alias: raw.alias, pais: null };
  }

  return typeof raw.pais === "string" ? { alias: raw.alias, pais: raw.pais } : undefined;
}
