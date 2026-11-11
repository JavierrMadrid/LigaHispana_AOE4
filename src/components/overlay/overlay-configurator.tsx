"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ArrowDownLeft } from "@phosphor-icons/react/dist/csr/ArrowDownLeft";
import { ArrowDownRight } from "@phosphor-icons/react/dist/csr/ArrowDownRight";
import { ArrowUpLeft } from "@phosphor-icons/react/dist/csr/ArrowUpLeft";
import { ArrowUpRight } from "@phosphor-icons/react/dist/csr/ArrowUpRight";
import { Check } from "@phosphor-icons/react/dist/csr/Check";
import { MagnifyingGlass } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";

import { countryFlagUrl } from "@/lib/flag";
import { normalizeSearchText } from "@/lib/format";
import type {
  OverlayClasificacion,
  OverlayEventoObjetivo,
  OverlayObjetivo,
} from "@/lib/overlay-api";
import {
  DEFAULT_OVERLAY_CONFIG,
  overlayAnimates,
  overlayEventKind,
  overlayEventView,
  overlayPreviewUrl,
  type OverlayConfig,
  type OverlayConfiguratorParticipant,
  type OverlayEventKind,
  type OverlayPosition,
  type OverlaySize,
} from "@/lib/overlay-view";
import { PlayerAvatar } from "@/components/player-avatar";

/** El tamaño de fuente de OBS que corresponde a cada tamaño de tarjeta. */
const OBS_SIZE: Readonly<Record<OverlaySize, string>> = {
  compacto: "360 × 320",
  normal: "400 × 360",
  grande: "460 × 400",
};

/** Las cuatro esquinas, en el orden en que se leen en una rejilla de 2 × 2. */
const POSITION_OPTIONS: ReadonlyArray<{
  value: OverlayPosition;
  label: string;
  Icon: typeof ArrowUpLeft;
}> = [
  { value: "tl", label: "Arriba izquierda", Icon: ArrowUpLeft },
  { value: "tr", label: "Arriba derecha", Icon: ArrowUpRight },
  { value: "bl", label: "Abajo izquierda", Icon: ArrowDownLeft },
  { value: "br", label: "Abajo derecha", Icon: ArrowDownRight },
];

const SIZE_OPTIONS: ReadonlyArray<{ value: OverlaySize; label: string }> = [
  { value: "compacto", label: "Compacto" },
  { value: "normal", label: "Normal" },
  { value: "grande", label: "Grande" },
];

const SECTION_OPTIONS: ReadonlyArray<{ value: OverlayConfig["secciones"]; label: string }> = [
  { value: "ambas", label: "Todo" },
  { value: "ranking", label: "Clasificación" },
  { value: "objetivos", label: "Objetivos" },
];

/** El aspecto de un botón de opción, encendido o apagado. */
function optionClass(active: boolean): string {
  return `inline-flex h-9 items-center justify-center gap-1.5 rounded-md border px-2.5 text-xs font-medium transition-colors ${
    active
      ? "border-accent/60 bg-accent/10 text-accent"
      : "border-line-strong text-muted hover:border-accent/40 hover:text-foreground"
  }`;
}

/** El origen de la ventana no cambia durante la vida de la página. */
function subscribeToOrigin(): () => void {
  return () => {};
}

/** El catálogo de objetivos, para saber de qué tipo es cada evento. */
async function loadObjectives(): Promise<OverlayObjetivo[] | null> {
  try {
    const response = await fetch("/api/v0/objetivos", { cache: "no-store" });

    if (!response.ok) {
      return null;
    }

    const objectives: unknown = await response.json();

    return Array.isArray(objectives) ? (objectives as OverlayObjetivo[]) : null;
  } catch {
    return null;
  }
}

/** La fila del participante en `/clasificacion`, o `null` si no se puede leer. */
async function loadClassification(id: string): Promise<OverlayClasificacion | null> {
  try {
    const response = await fetch(`/api/v0/clasificacion?id=${encodeURIComponent(id)}`, {
      cache: "no-store",
    });

    if (!response.ok) {
      return null;
    }

    const rows = (await response.json()) as OverlayClasificacion[];

    return rows.find((row) => row.id === id) ?? null;
  } catch {
    return null;
  }
}

/**
 * El configurador del overlay: elegir participante, ajustar la tarjeta, copiar
 * la URL y probar la animación, con la vista previa al lado y los pasos de OBS.
 *
 * La lista y la vista previa van en dos columnas en escritorio y apiladas en
 * móvil. La selección es estado local; la URL se construye con el origen público
 * si lo hay y, si no, con el de la ventana. El botón de prueba lanza un
 * `postMessage` solo al iframe de la vista previa: no toca el torneo.
 */
export function OverlayConfigurator({
  participants,
  siteOrigin,
}: {
  participants: OverlayConfiguratorParticipant[];
  siteOrigin: string | null;
}) {
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState(participants[0]?.id ?? "");
  const [config, setConfig] = useState<OverlayConfig>(DEFAULT_OVERLAY_CONFIG);
  const [copied, setCopied] = useState(false);
  const [demoNotice, setDemoNotice] = useState<string | null>(null);
  const [iframeLoaded, setIframeLoaded] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const urlInputRef = useRef<HTMLInputElement>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // El origen público puede no estar configurado. En el servidor se usa el que
  // haya (o `null`); en el navegador, el de la ventana, para que la URL copiada
  // sea absoluta y se pueda pegar en OBS. `useSyncExternalStore` resuelve la
  // diferencia sin un `setState` en un efecto.
  const origin = useSyncExternalStore<string | null>(
    subscribeToOrigin,
    () => window.location.origin,
    () => siteOrigin,
  );

  useEffect(
    () => () => {
      if (copyTimer.current !== null) {
        clearTimeout(copyTimer.current);
      }
    },
    [],
  );

  const filtered = useMemo(() => {
    const needle = normalizeSearchText(query.trim());

    if (needle === "") {
      return participants;
    }

    return participants.filter((participant) =>
      normalizeSearchText(`${participant.alias} ${participant.pais ?? ""}`).includes(
        needle,
      ),
    );
  }, [participants, query]);

  const selected =
    participants.find((participant) => participant.id === selectedId) ??
    participants[0] ??
    null;

  // La vista previa vive en el mismo origen, así que va relativa; la URL que se
  // copia y se pega en OBS va absoluta.
  const previewUrl =
    selected === null ? "about:blank" : overlayPreviewUrl(null, selected.id, config);
  const publicUrl =
    selected === null ? "" : overlayPreviewUrl(origin, selected.id, config);

  if (participants.length === 0) {
    return null;
  }

  function selectParticipant(id: string) {
    if (id === selected?.id) {
      return;
    }

    setSelectedId(id);
    setIframeLoaded(false);
    setCopied(false);
    setDemoNotice(null);
  }

  function updateConfig(patch: Partial<OverlayConfig>) {
    const next = { ...config, ...patch };

    if (
      next.posicion === config.posicion &&
      next.tamano === config.tamano &&
      next.secciones === config.secciones &&
      next.animaciones === config.animaciones
    ) {
      return;
    }

    setConfig(next);
    setIframeLoaded(false);
    setCopied(false);
  }

  async function copyUrl() {
    if (publicUrl === "") {
      return;
    }

    try {
      await navigator.clipboard.writeText(publicUrl);
      setCopied(true);

      if (copyTimer.current !== null) {
        clearTimeout(copyTimer.current);
      }

      copyTimer.current = setTimeout(() => setCopied(false), 2_000);
    } catch {
      // Sin permiso de portapapeles, se deja el texto seleccionado para copiar a
      // mano, que es el siguiente gesto que espera quien pulsó el botón.
      urlInputRef.current?.focus();
      urlInputRef.current?.select();
    }
  }

  function postDemo(objetivoId: string, evento: OverlayEventoObjetivo) {
    if (!config.animaciones || !iframeLoaded || selected === null) {
      return;
    }

    iframeRef.current?.contentWindow?.postMessage(
      { type: "overlay:demo", objetivoId, evento },
      window.location.origin,
    );
  }

  async function loadDemoEvent(
    kind: OverlayEventKind,
  ): Promise<{ objetivoId: string; evento: OverlayEventoObjetivo } | null> {
    const target = selected;

    if (target === null) {
      return null;
    }

    const [row, objectives] = await Promise.all([
      loadClassification(target.id),
      loadObjectives(),
    ]);

    if (row === null || objectives === null) {
      return null;
    }

    const catalog = new Map(objectives.map((objective) => [objective.id, objective]));
    let latest: { objetivoId: string; evento: OverlayEventoObjetivo } | null = null;

    for (const [objetivoId, evento] of Object.entries(row.eventos_objetivos)) {
      const objective = catalog.get(objetivoId);

      if (objective === undefined) {
        continue;
      }

      const view = overlayEventView(objetivoId, evento, objective);

      if (overlayEventKind(view) !== kind || !overlayAnimates(view)) {
        continue;
      }

      if (latest === null || Date.parse(evento.fechahora) >= Date.parse(latest.evento.fechahora)) {
        latest = { objetivoId, evento };
      }
    }

    return latest;
  }

  async function testAnimation(kind: OverlayEventKind) {
    if (selected === null || !config.animaciones || !iframeLoaded) {
      return;
    }

    const source = await loadDemoEvent(kind);

    if (source === null) {
      setDemoNotice("Este participante no tiene un objetivo de ese tipo para reproducir.");
      return;
    }

    setDemoNotice(null);
    postDemo(source.objetivoId, source.evento);
  }

  return (
    <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
      <section
        aria-labelledby="overlay-participants-heading"
        className="rounded-lg border border-line bg-surface"
      >
        <div className="flex flex-col gap-3 border-b border-line px-4 py-4">
          <div className="flex items-baseline justify-between gap-3">
            <h2
              id="overlay-participants-heading"
              className="font-display text-base font-semibold text-foreground"
            >
              Participantes
            </h2>
            <p className="text-xs tabular-nums text-muted" role="status">
              {query.trim() === ""
                ? `${participants.length} ${participants.length === 1 ? "participante" : "participantes"}`
                : `${filtered.length} de ${participants.length}`}
            </p>
          </div>

          <p className="text-xs leading-relaxed text-muted">
            Busca tu nombre y pulsa tu fila. Solo aparecen participantes con
            clasificación publicada.
          </p>

          <label className="flex h-10 items-center gap-2 rounded-md border border-line-strong bg-background px-3 text-muted transition-colors focus-within:border-accent focus-within:ring-1 focus-within:ring-accent">
            <span className="sr-only">Buscar tu nombre</span>
            <MagnifyingGlass size={16} aria-hidden="true" />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Busca tu nombre…"
              className="w-full min-w-0 bg-transparent text-sm text-foreground outline-none placeholder:text-muted"
            />
          </label>
        </div>

        {filtered.length === 0 ? (
          <p className="px-4 py-6 text-sm text-muted">
            Ningún participante coincide con la búsqueda.
          </p>
        ) : (
          <ul className="max-h-[32rem] overflow-y-auto">
            {filtered.map((participant) => {
              const flag = countryFlagUrl(participant.pais);
              const active = participant.id === selected?.id;

              return (
                <li key={participant.id}>
                  <button
                    type="button"
                    onClick={() => selectParticipant(participant.id)}
                    aria-pressed={active}
                    className={`flex w-full items-center gap-3 border-l-2 px-3 py-2 text-left transition-colors ${
                      active
                        ? "border-accent bg-accent/10"
                        : "border-transparent hover:bg-surface-raised"
                    }`}
                  >
                    <span className="w-7 shrink-0 text-right text-xs tabular-nums text-muted">
                      {participant.rank}
                    </span>
                    <PlayerAvatar
                      name={participant.alias}
                      avatarUrl={participant.avatarUrl}
                      className="size-8 text-[11px]"
                      shape="circle"
                    />
                    <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                      {participant.alias}
                    </span>
                    {active ? (
                      <Check
                        size={14}
                        aria-hidden="true"
                        className="shrink-0 text-accent"
                      />
                    ) : null}
                    {flag ? (
                      // eslint-disable-next-line @next/next/no-img-element -- bandera de flagcdn
                      <img
                        src={flag}
                        alt={participant.pais ?? ""}
                        width={18}
                        height={12}
                        loading="lazy"
                        decoding="async"
                        className="h-3 w-[18px] shrink-0 rounded-[1px] object-cover"
                      />
                    ) : null}
                    <span className="shrink-0 text-xs tabular-nums text-muted">
                      {participant.points.toLocaleString("es-ES")} pts
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <div className="flex min-w-0 flex-col gap-6">
        <section aria-labelledby="overlay-preview-heading" className="flex flex-col gap-3">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <h2
              id="overlay-preview-heading"
              className="font-display text-base font-semibold text-foreground"
            >
              Vista previa
            </h2>
            {selected !== null ? (
              <p className="text-xs text-muted">
                Overlay de{" "}
                <strong className="font-medium text-foreground">{selected.alias}</strong>
              </p>
            ) : null}
          </div>

          <div className="rounded-lg border border-line bg-linear-to-br from-[#122039] via-background to-[#1b2d48] p-3">
            <iframe
              ref={iframeRef}
              key={previewUrl}
              src={previewUrl}
              title={
                selected === null
                  ? "Vista previa del overlay"
                  : `Vista previa del overlay de ${selected.alias}`
              }
              onLoad={() => setIframeLoaded(true)}
              className="h-[380px] w-full rounded-md border border-line bg-transparent sm:h-[420px]"
            />
          </div>

          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <input
              ref={urlInputRef}
              readOnly
              value={publicUrl}
              aria-label="URL del overlay"
              onFocus={(event) => event.currentTarget.select()}
              className="h-10 min-w-0 flex-1 rounded-md border border-line-strong bg-background px-3 text-xs text-foreground"
            />
            <div className="flex shrink-0 gap-2">
              <button
                type="button"
                onClick={() => void copyUrl()}
                className="inline-flex min-h-10 items-center justify-center rounded-md border border-accent/60 bg-accent/10 px-3 text-sm font-semibold text-accent transition-colors hover:bg-accent/20"
              >
                {copied ? "Copiado" : "Copiar URL"}
              </button>
              <a
                href={publicUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex min-h-10 items-center justify-center rounded-md border border-line-strong px-3 text-sm font-medium text-foreground transition-colors hover:border-accent/60 hover:text-accent"
              >
                Abrir en una pestaña nueva
              </a>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => void testAnimation("directo")}
                disabled={!config.animaciones || !iframeLoaded || selected === null}
                className="inline-flex min-h-9 items-center justify-center rounded-md border border-accent/50 bg-accent/10 px-3 text-sm font-semibold text-accent transition-colors hover:bg-accent/20 disabled:cursor-default disabled:border-line disabled:bg-transparent disabled:text-muted"
              >
                Probar puntos
              </button>
              <button
                type="button"
                onClick={() => void testAnimation("meta")}
                disabled={!config.animaciones || !iframeLoaded || selected === null}
                className="inline-flex min-h-9 items-center justify-center rounded-md border border-accent/50 bg-accent/10 px-3 text-sm font-semibold text-accent transition-colors hover:bg-accent/20 disabled:cursor-default disabled:border-line disabled:bg-transparent disabled:text-muted"
              >
                Probar meta
              </button>
              <button
                type="button"
                onClick={() => void testAnimation("liderato")}
                disabled={!config.animaciones || !iframeLoaded || selected === null}
                className="inline-flex min-h-9 items-center justify-center rounded-md border border-accent/50 bg-accent/10 px-3 text-sm font-semibold text-accent transition-colors hover:bg-accent/20 disabled:cursor-default disabled:border-line disabled:bg-transparent disabled:text-muted"
              >
                Probar 1º
              </button>
            </div>
            <p className="text-xs text-muted">
              {config.animaciones
                ? (demoNotice ??
                  "Reproduce un objetivo real de cada tipo en la vista previa; no cambia nada del torneo.")
                : "Activa las animaciones para probarlas."}
            </p>
          </div>
        </section>

        <section
          aria-labelledby="overlay-settings-heading"
          className="rounded-lg border border-line bg-surface"
        >
          <h2
            id="overlay-settings-heading"
            className="border-b border-line px-4 py-3 font-display text-base font-semibold text-foreground"
          >
            Configuración y OBS
          </h2>

          <div className="grid gap-6 px-4 py-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-foreground">Configuración</h3>
              <p className="mt-1 text-xs leading-relaxed text-muted">
                Ajusta la tarjeta; la URL de la vista previa se actualiza sola.
              </p>

              <div className="mt-4 flex flex-col gap-4">
                <fieldset className="min-w-0">
                  <legend className="mb-2 text-xs font-medium text-muted">Posición</legend>
                  <div className="grid grid-cols-2 gap-1.5">
                    {POSITION_OPTIONS.map(({ value, label, Icon }) => (
                      <button
                        key={value}
                        type="button"
                        onClick={() => updateConfig({ posicion: value })}
                        aria-pressed={config.posicion === value}
                        className={optionClass(config.posicion === value)}
                      >
                        <Icon size={14} aria-hidden="true" />
                        {label}
                      </button>
                    ))}
                  </div>
                </fieldset>

                <fieldset className="min-w-0">
                  <legend className="mb-2 text-xs font-medium text-muted">Tamaño</legend>
                  <div className="flex flex-wrap gap-1.5">
                    {SIZE_OPTIONS.map(({ value, label }) => (
                      <button
                        key={value}
                        type="button"
                        onClick={() => updateConfig({ tamano: value })}
                        aria-pressed={config.tamano === value}
                        className={optionClass(config.tamano === value)}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </fieldset>

                <fieldset className="min-w-0">
                  <legend className="mb-2 text-xs font-medium text-muted">Qué mostrar</legend>
                  <div className="flex flex-wrap gap-1.5">
                    {SECTION_OPTIONS.map(({ value, label }) => (
                      <button
                        key={value}
                        type="button"
                        onClick={() => updateConfig({ secciones: value })}
                        aria-pressed={config.secciones === value}
                        className={optionClass(config.secciones === value)}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </fieldset>

                <label className="flex items-center gap-2.5 text-sm text-foreground">
                  <input
                    type="checkbox"
                    checked={config.animaciones}
                    onChange={(event) => updateConfig({ animaciones: event.target.checked })}
                    className="size-4 shrink-0 accent-accent"
                  />
                  Mostrar animaciones al cumplir o progresar
                </label>
              </div>
            </div>

            <div className="min-w-0 lg:border-l lg:border-line lg:pl-6">
              <h3 className="text-sm font-semibold text-foreground">Añadir a OBS</h3>
              <p className="mt-2 rounded-md border border-line bg-background px-3 py-2 text-xs leading-relaxed text-muted">
                Fuente de navegador ·{" "}
                <strong className="font-medium text-foreground">
                  {OBS_SIZE[config.tamano]}
                </strong>{" "}
                · sin fondo
              </p>
              <ol className="mt-3 flex list-decimal flex-col gap-2 pl-5 text-sm leading-relaxed text-muted">
                <li>
                  Añade una fuente de{" "}
                  <strong className="font-medium text-foreground">Navegador</strong> a la
                  escena.
                </li>
                <li>Pega la URL de la vista previa.</li>
                <li>
                  Usa el tamaño indicado arriba o, a pantalla completa,{" "}
                  <strong className="font-medium text-foreground">1920 × 1080</strong>.
                </li>
                <li>No añadas fondo: la página ya es transparente.</li>
                <li>Activa «Refrescar el navegador cuando la escena se active».</li>
                <li>El contenido se actualiza solo cada 30 segundos.</li>
              </ol>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
