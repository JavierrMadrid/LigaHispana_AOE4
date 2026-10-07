"use client";

import { useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import type {
  ObjectiveGroup,
  ParticipantObjective,
  ParticipantObjectives,
} from "@/lib/public";
import { divisionColor } from "@/components/division-icon";
import {
  LeagueIcon,
  leagueFilterRank,
  rankLevelToLeague,
} from "@/components/league-icon";
import { ObjectiveIcon } from "@/components/objective-icon";
import { ObjectiveRankingDialog } from "@/components/objective-ranking-dialog";
import { PageHead } from "@/components/page-head";
import { PlayerAvatar } from "@/components/player-avatar";
import {
  MobileSectionIndex,
  SectionIndexAside,
  type DocSection,
} from "@/components/section-index";

/** Bloques de la ficha, en el orden en que se leen. Alimentan el índice lateral. */
const SECTIONS: readonly DocSection[] = [
  { id: "al-alcance", label: "Al alcance" },
  { id: "en-posesion", label: "En posesión" },
  { id: "sin-disputar", label: "Sin disputar" },
  { id: "resumen", label: "En resumen" },
];

const SECTION_INDEX_LABEL = "Secciones de los objetivos del participante";

/**
 * Mínimo de un objetivo, ya resuelto en el servidor con `objectiveMinimum`.
 *
 * El cliente no puede importar `@/lib/public` (es `server-only`), así que la
 * página calcula este dato —que sí es serializable— y entra como prop. Así la
 * regla del mínimo sigue teniendo una sola fuente.
 */
export type ObjectiveMinimumView = {
  unit: "partidas" | "victorias";
  value: number;
};

/**
 * Ficha pública de objetivos de un participante.
 *
 * Es la vista de detalle de la columna "Objetivos" de la clasificación: la
 * misma captura de `/objetivos` proyectada sobre un jugador. No recalcula nada
 * —el DAL reutiliza el motor de objetivos—, así que lo que se lee aquí no puede
 * contradecir al ranking de cada objetivo.
 *
 * Tres bloques con intención: lo primero es lo que está al alcance (mejor puesto
 * entre los aspirantes, desempata la distancia al líder), luego el botín ya
 * conseguido y al final lo que todavía no se disputa, que por mayoría aplasta la
 * página si se pinta con tarjetas: por eso ese último bloque es un índice
 * compacto. La clasificación completa de un objetivo se abre en el mismo diálogo
 * que usa `/objetivos`, reutilizando `ObjectiveRankingDialog`.
 */
export function ParticipantObjectivesView({
  data,
  groupLabels,
  minimumsByObjective,
  masterizarTodosId,
}: {
  data: ParticipantObjectives;
  groupLabels: Record<ObjectiveGroup, string>;
  /** Mínimo de cada objetivo, por id; `null` cuando no tiene umbral. */
  minimumsByObjective: Record<string, ObjectiveMinimumView | null>;
  masterizarTodosId: string;
}) {
  const { player, minimums, options } = data;
  const [group, setGroup] = useState<ObjectiveGroup | null>(null);
  const [active, setActive] = useState<ParticipantObjective | null>(null);

  // Tres bloques con intención: primero lo que está al alcance (mejor puesto
  // entre los aspirantes, desempata la distancia al líder), luego lo ya
  // conseguido y al final lo que todavía no se disputa. `options` llega en el
  // orden del catálogo, así que los dos bloques no ordenados lo conservan.
  const achieved = options.filter((option) => option.achieved);
  const contending = options
    .filter((option) => !option.achieved && option.position !== null)
    .sort(
      (a, b) =>
        (a.position ?? Number.POSITIVE_INFINITY) -
          (b.position ?? Number.POSITIVE_INFINITY) ||
        (a.distance ?? Number.POSITIVE_INFINITY) -
          (b.distance ?? Number.POSITIVE_INFINITY) ||
        a.label.localeCompare(b.label, "es"),
    );
  const waiting = options.filter(
    (option) => !option.achieved && option.position === null,
  );

  // El orden de las familias se toma de los propios objetivos, que ya llegan en
  // el orden de presentación de `docs/PUNTUACION.md`, igual que en `/objetivos`.
  const groups = useMemo(() => {
    const order: ObjectiveGroup[] = [];

    for (const option of options) {
      if (!order.includes(option.group)) {
        order.push(option.group);
      }
    }

    return order;
  }, [options]);

  const groupCounts = useMemo(() => {
    const counts = new Map<ObjectiveGroup, number>();

    for (const option of options) {
      counts.set(option.group, (counts.get(option.group) ?? 0) + 1);
    }

    return counts;
  }, [options]);

  const inGroup = (items: ParticipantObjective[]) =>
    group === null ? items : items.filter((option) => option.group === group);

  const achievedShown = inGroup(achieved);
  const contendingShown = inGroup(contending);
  const waitingShown = inGroup(waiting);

  const earnedPoints = achieved.reduce((total, option) => total + option.points, 0);
  const contendingPoints = contending.reduce(
    (total, option) => total + option.points,
    0,
  );
  const bestBet = contending[0] ?? null;
  // `distance` de quien va primero es `0`, no `null`, así que la rama "lideras"
  // se decide por la distancia ya formateada (que se anula al ir primero).
  const bestDistance = bestBet === null ? null : formatDistance(bestBet);
  const onPodium = contending.filter((option) => (option.position ?? 0) <= 3).length;
  const leading = contending.filter((option) => option.position === 1).length;
  const oneAway = contending.filter((option) => option.position === 2).length;

  // El emblema sale del `rankLevel` en crudo, como en la clasificación; si no
  // está, cae al emblema de la división ya resuelta. Un jugador sin clasificar
  // no pinta escudo.
  const league =
    rankLevelToLeague(player.rankLevel) ??
    (player.division === null ? null : leagueFilterRank(player.division));

  const matchesFilter =
    achievedShown.length + contendingShown.length + waitingShown.length;

  return (
    <div className="flex flex-col gap-8">
      <PageHead title={`Objetivos de ${player.name}`} />

      <nav
        aria-label="Vuelta"
        className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm"
      >
        <Link href="/" className="text-muted transition-colors hover:text-accent">
          Clasificación general
        </Link>
        <Link
          href="/objetivos"
          className="text-muted transition-colors hover:text-accent"
        >
          Todos los objetivos
        </Link>
      </nav>

      {/*
        Cabecera: la identidad entera es un solo enlace a AoE4World (avatar,
        nombre y emblema), con las tres cifras de cabecera a la derecha y la
        entradilla narrativa debajo. La frase del mejor objetivo sube aquí para
        que la historia se lea en la primera pantalla, y así "En resumen" puede
        contar la carrera sin repetir estas cifras.
      */}
      <header className="thread-top relative overflow-hidden rounded-lg border border-line bg-surface px-5 py-5">
        <div className="flex flex-wrap items-start gap-x-6 gap-y-4">
          <a
            href={player.profileUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="group flex min-w-0 items-center gap-4 rounded-sm"
          >
            <PlayerAvatar
              name={player.name}
              avatarUrl={player.avatarUrl}
              className="size-16 text-lg"
            />
            <span className="min-w-0">
              <span className="flex min-w-0 items-center gap-2">
                <span className="truncate font-display text-2xl font-semibold text-foreground underline-offset-4 transition-colors group-hover:text-accent group-hover:underline">
                  {player.name}
                </span>
                {league !== null ? (
                  <span
                    className="inline-flex shrink-0"
                    style={{ color: divisionColor(league.division) }}
                  >
                    <LeagueIcon rank={league} label={league.label} className="h-7 w-5" />
                  </span>
                ) : null}
              </span>
              <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted">
                {league === null ? (
                  <span>Sin clasificar</span>
                ) : (
                  <span style={{ color: divisionColor(league.division) }}>
                    {league.label}
                  </span>
                )}
                <span className="underline-offset-4 transition-colors group-hover:text-accent">
                  Perfil en AoE4World
                </span>
              </span>
            </span>
            <span className="sr-only">(se abre en una pestaña nueva)</span>
          </a>

          <dl className="ml-auto flex flex-wrap items-start gap-x-8 gap-y-3">
            <HeaderStat
              label="Objetivos en posesión"
              value={`${achieved.length} de ${options.length}`}
            />
            <HeaderStat
              label="Puntos de objetivos"
              value={String(earnedPoints)}
              accent
            />
            <HeaderStat label="Al alcance" value={String(contending.length)} />
          </dl>
        </div>

        <p className="mt-4 max-w-[68ch] border-t border-line pt-4 text-sm leading-relaxed text-muted">
          <BestBetNote bestBet={bestBet} bestDistance={bestDistance} />
        </p>
      </header>

      <MobileSectionIndex sections={SECTIONS} ariaLabel={SECTION_INDEX_LABEL} />

      <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_13rem] lg:gap-14">
        <div className="flex min-w-0 flex-col gap-10">
          <FilterBar
            groups={groups}
            group={group}
            groupLabels={groupLabels}
            countOf={(item) => groupCounts.get(item) ?? 0}
            total={options.length}
            matches={matchesFilter}
            onGroupChange={setGroup}
          />

          {group === null || contendingShown.length > 0 ? (
            <ObjectiveSection
              id="al-alcance"
              title="Al alcance"
              note={
                contendingShown.length === 1
                  ? "1 objetivo en el que ya tienes puesto"
                  : `${contendingShown.length} objetivos en los que ya tienes puesto`
              }
              pointsLabel="en juego"
              items={contendingShown}
              groupLabels={groupLabels}
              emptyMessage="Ahora mismo no apareces en la clasificación de ningún objetivo. En cuanto cierres una partida que cuente para uno, saldrá aquí tu puesto."
              minimumsByObjective={minimumsByObjective}
              onOpen={setActive}
              highlight
            />
          ) : null}

          {group === null || achievedShown.length > 0 ? (
            <ObjectiveSection
              id="en-posesion"
              title="En posesión"
              note={
                achievedShown.length === 1
                  ? "1 objetivo en tu haber"
                  : `${achievedShown.length} objetivos en tu haber`
              }
              pointsLabel="en tu haber"
              items={achievedShown}
              groupLabels={groupLabels}
              emptyMessage="Todavía no has ganado ningún objetivo especial. Los tienes listados abajo, con lo que pide cada uno."
              minimumsByObjective={minimumsByObjective}
              onOpen={setActive}
            />
          ) : null}

          {group === null || waitingShown.length > 0 ? (
            <ObjectiveSection
              id="sin-disputar"
              title="Sin disputar todavía"
              note={
                waitingShown.length === 1
                  ? "1 objetivo que aún no cuenta contigo"
                  : `${waitingShown.length} objetivos que aún no cuentan contigo`
              }
              pointsLabel="en juego"
              items={waitingShown}
              groupLabels={groupLabels}
              emptyMessage="Estás en la carrera de todos los objetivos."
              minimumsByObjective={minimumsByObjective}
              onOpen={setActive}
              compact
            />
          ) : null}

          <SummarySection
            leading={leading}
            onPodium={onPodium}
            oneAway={oneAway}
            contendingPoints={contendingPoints}
          />
        </div>

        <SectionIndexAside sections={SECTIONS} ariaLabel={SECTION_INDEX_LABEL} />
      </div>

      {active === null ? null : (
        <ObjectiveRankingDialog
          key={active.id}
          option={active}
          minimums={minimums}
          masterizarTodosId={masterizarTodosId}
          onClose={() => setActive(null)}
        />
      )}
    </div>
  );
}

/**
 * Entradilla narrativa de la cabecera: qué objetivo es hoy el más cercano y
 * cuánto separa del primer puesto. Sin ninguno al alcance, explica por qué y
 * cuándo aparecerá, que es lo que debe hacer un vacío.
 */
function BestBetNote({
  bestBet,
  bestDistance,
}: {
  bestBet: ParticipantObjective | null;
  bestDistance: string | null;
}) {
  if (bestBet === null) {
    return (
      <>
        Todavía no apareces en la clasificación de ningún objetivo. En cuanto
        juegues una partida clasificatoria que cuente para alguno, aquí verás tu
        puesto y lo que te falta para el primero.
      </>
    );
  }

  if (bestDistance === null) {
    return (
      <>
        Lideras la carrera por{" "}
        <strong className="font-medium text-foreground">{bestBet.label}</strong>{" "}
        entre los aspirantes.
      </>
    );
  }

  return (
    <>
      Tu objetivo más cercano es{" "}
      <strong className="font-medium text-foreground">{bestBet.label}</strong>: vas{" "}
      {ordinal(bestBet.position ?? 0)} y te separan{" "}
      <strong className="font-medium text-foreground">{bestDistance}</strong> del
      primer puesto.
    </>
  );
}

/** Bloque de objetivos, con tarjetas completas o como índice compacto. */
function ObjectiveSection({
  id,
  title,
  note,
  pointsLabel,
  items,
  groupLabels,
  emptyMessage,
  minimumsByObjective,
  onOpen,
  highlight = false,
  compact = false,
}: {
  id: string;
  title: string;
  note: string;
  pointsLabel: string;
  items: ParticipantObjective[];
  groupLabels: Record<ObjectiveGroup, string>;
  emptyMessage: string;
  minimumsByObjective: Record<string, ObjectiveMinimumView | null>;
  onOpen: (objective: ParticipantObjective) => void;
  highlight?: boolean;
  compact?: boolean;
}) {
  const points = items.reduce((total, option) => total + option.points, 0);
  const totals = `${objectiveCount(items.length)} · ${points} puntos ${pointsLabel}`;

  const heading = (
    <>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5">
        <h2 className="font-display text-lg font-semibold text-foreground">{title}</h2>
        <p className="text-xs tabular-nums text-muted">{totals}</p>
      </div>
      <p className="mt-0.5 text-xs text-muted">{note}</p>
    </>
  );

  return (
    <section id={id} className="scroll-mt-24">
      {highlight ? (
        <div className="thread-top relative overflow-hidden rounded-lg border border-accent/30 bg-surface px-4 py-3">
          {heading}
        </div>
      ) : (
        <div className="flex flex-col gap-1 border-b border-line pb-2">{heading}</div>
      )}

      {items.length === 0 ? (
        <p className="mt-3 rounded-lg border border-dashed border-line bg-surface/40 px-5 py-6 text-sm text-muted">
          {emptyMessage}
        </p>
      ) : compact ? (
        <ul className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {items.map((objective) => (
            <li key={objective.id}>
              <ObjectiveChip
                objective={objective}
                groupLabels={groupLabels}
                onOpen={onOpen}
              />
            </li>
          ))}
        </ul>
      ) : (
        <ul className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {items.map((objective) => (
            <ObjectiveRow
              key={objective.id}
              objective={objective}
              groupLabels={groupLabels}
              minimumsByObjective={minimumsByObjective}
              onOpen={onOpen}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

/** Una fila de objetivo: qué es, cuánto vale, cómo va el jugador en él. */
function ObjectiveRow({
  objective,
  groupLabels,
  minimumsByObjective,
  onOpen,
}: {
  objective: ParticipantObjective;
  groupLabels: Record<ObjectiveGroup, string>;
  minimumsByObjective: Record<string, ObjectiveMinimumView | null>;
  onOpen: (objective: ParticipantObjective) => void;
}) {
  const distance = formatDistance(objective);
  const minimum = minimumsByObjective[objective.id] ?? null;
  const current = (minimum?.unit ?? "partidas") === "partidas" ? objective.matches : objective.value;

  return (
    <li
      className={`flex flex-col rounded-lg border bg-surface p-4 ${
        objective.achieved ? "border-accent/35" : "border-line"
      }`}
    >
      <div className="flex items-start gap-4">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-md border border-line bg-surface-raised">
          <ObjectiveIcon option={objective} className="size-5 shrink-0" />
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h3 className="min-w-0 font-medium text-foreground">{objective.label}</h3>
            {objective.detail !== null ? (
              <span className="text-xs text-muted">({objective.detail.label})</span>
            ) : null}
            {objective.achieved ? (
              <AchievedBadge />
            ) : (
              <PositionBadge position={objective.position} />
            )}
          </div>

          <p className="mt-0.5 text-xs text-muted">{groupLabels[objective.group]}</p>

          <p className="mt-2 text-sm leading-relaxed text-muted">
            {objective.description}
          </p>

          <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-3">
            <Fact label="Tu avance" value={formatMetricValue(objective)} strong />
            <Fact
              label="Posición"
              value={objective.achieved ? "Poseído" : positionText(objective)}
            />
            <Fact label="Al primero" value={distance ?? "—"} />
          </dl>

          <MinimumProgress current={current} minimum={minimum} />
        </div>

        <PointsPlate points={objective.points} achieved={objective.achieved} />
      </div>

      <div className="mt-3 flex justify-end border-t border-line pt-2">
        <button
          type="button"
          onClick={() => onOpen(objective)}
          aria-label={`Ver la clasificación de ${objective.label}`}
          className="-my-2 rounded-sm py-2 text-xs font-medium text-accent underline-offset-4 transition-colors hover:underline"
        >
          Ver clasificación
        </button>
      </div>
    </li>
  );
}

/** Ficha compacta de un objetivo, para el índice de los que aún no se disputan. */
function ObjectiveChip({
  objective,
  groupLabels,
  onOpen,
}: {
  objective: ParticipantObjective;
  groupLabels: Record<ObjectiveGroup, string>;
  onOpen: (objective: ParticipantObjective) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onOpen(objective)}
      aria-label={`Ver la clasificación de ${objective.label}`}
      className="group flex w-full items-center gap-3 rounded-md border border-line bg-surface px-3 py-2 text-left transition-colors hover:border-line-strong hover:bg-surface-raised"
    >
      <span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-line bg-surface-raised">
        <ObjectiveIcon option={objective} className="size-4 shrink-0" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-foreground transition-colors group-hover:text-accent">
          {objective.label}
        </span>
        <span className="block truncate text-xs text-muted">
          {groupLabels[objective.group]}
        </span>
      </span>
      <span className="shrink-0 font-display text-sm font-semibold tabular-nums text-muted">
        {objective.points}
        <span className="sr-only"> puntos</span>
      </span>
    </button>
  );
}

/** Filtro por familia de objetivo. Agrupa los tres bloques a la vez. */
function FilterBar({
  groups,
  group,
  groupLabels,
  countOf,
  total,
  matches,
  onGroupChange,
}: {
  groups: ObjectiveGroup[];
  group: ObjectiveGroup | null;
  groupLabels: Record<ObjectiveGroup, string>;
  countOf: (group: ObjectiveGroup) => number;
  total: number;
  matches: number;
  onGroupChange: (group: ObjectiveGroup | null) => void;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
        <span id="filtro-familias" className="shrink-0 text-xs font-semibold text-muted sm:w-20">
          Familia
        </span>
        <div role="group" aria-labelledby="filtro-familias" className="flex flex-wrap items-center gap-2">
          <FilterPill active={group === null} onClick={() => onGroupChange(null)}>
            Todas
            <Count value={total} />
          </FilterPill>
          {groups.map((item) => (
            <FilterPill
              key={item}
              active={group === item}
              onClick={() => onGroupChange(group === item ? null : item)}
            >
              {groupLabels[item]}
              <Count value={countOf(item)} />
            </FilterPill>
          ))}
        </div>
      </div>

      {group === null ? null : (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p role="status" className="text-xs text-muted">
            {matches} de {total} {total === 1 ? "objetivo" : "objetivos"}
          </p>
          <button
            type="button"
            onClick={() => onGroupChange(null)}
            className="text-xs font-medium text-muted underline-offset-4 transition-colors hover:text-accent hover:underline"
          >
            Quitar filtro
          </button>
        </div>
      )}
    </div>
  );
}

function FilterPill({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`inline-flex h-10 items-center gap-2 rounded-full border px-3 text-xs font-semibold transition-colors ${
        active
          ? "border-accent bg-accent text-accent-ink"
          : "border-line bg-surface text-muted hover:bg-surface-raised hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}

function Count({ value }: { value: number }) {
  return <span className="tabular-nums opacity-70">{value}</span>;
}

/**
 * Cifras de la carrera, sin repetir las de la cabecera: la cabecera cuenta lo
 * que el jugador posee; aquí se cuenta lo que puede ganar.
 */
function SummarySection({
  leading,
  onPodium,
  oneAway,
  contendingPoints,
}: {
  leading: number;
  onPodium: number;
  oneAway: number;
  contendingPoints: number;
}) {
  return (
    <section id="resumen" className="scroll-mt-24">
      <div className="border-b border-line pb-2">
        <h2 className="font-display text-lg font-semibold text-foreground">
          En resumen
        </h2>
      </div>
      <div className="mt-3 rounded-lg border border-line bg-surface p-5">
        <dl className="flex flex-wrap items-start gap-x-10 gap-y-4">
          <HeaderStat
            label="Objetivos que lideras"
            value={String(leading)}
            accent={leading > 0}
          />
          <HeaderStat label="En el podio de aspirantes" value={String(onPodium)} />
          <HeaderStat label="A un puesto del liderato" value={String(oneAway)} />
          <HeaderStat label="Puntos al alcance" value={String(contendingPoints)} />
        </dl>
      </div>
    </section>
  );
}

/**
 * Dato de la fila: rótulo pequeño y valor debajo, en el orden de lectura visual.
 */
function Fact({
  label,
  value,
  strong = false,
}: {
  label: string;
  value: string;
  strong?: boolean;
}) {
  return (
    <div className="min-w-0">
      <dt className="truncate text-muted">{label}</dt>
      <dd
        className={`truncate tabular-nums ${
          strong ? "font-semibold text-foreground" : "text-foreground"
        }`}
        title={value}
      >
        {value}
      </dd>
    </div>
  );
}

/** Los puntos que reparte el objetivo, en una placa a la derecha de la fila. */
function PointsPlate({ points, achieved }: { points: number; achieved: boolean }) {
  return (
    <span
      className={`shrink-0 rounded-md border px-2.5 py-1.5 text-right ${
        achieved
          ? "border-accent/40 bg-accent/5"
          : "border-line bg-surface-raised"
      }`}
    >
      <span
        className={`block font-display text-lg font-semibold leading-none tabular-nums ${
          achieved ? "text-accent" : "text-foreground"
        }`}
      >
        {points}
      </span>
      <span className="mt-1 block text-xs font-medium uppercase tracking-wide text-muted">
        puntos
      </span>
    </span>
  );
}

/** Distintivo del objetivo que el jugador posee ahora mismo. */
function AchievedBadge() {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-accent/40 bg-accent/10 px-2 py-0.5 text-xs font-medium text-accent">
      <CheckIcon className="size-3 shrink-0" />
      Conseguido
    </span>
  );
}

/**
 * Insignia del puesto entre los aspirantes. Solo para el podio: el oro de la
 * casa para el liderato, plata y bronce para el 2.º y el 3.º, los mismos tokens
 * que usa la clasificación para el podio.
 */
function PositionBadge({ position }: { position: number | null }) {
  if (position === null || position > 3) {
    return null;
  }

  const label = position === 1 ? "Líder" : `${position}.º`;
  const tone =
    position === 1
      ? "border-accent/50 bg-accent/10 text-accent"
      : position === 2
        ? "border-podium-silver/50 bg-podium-silver/10 text-podium-silver"
        : "border-podium-bronze/50 bg-podium-bronze/10 text-podium-bronze";

  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-xs font-medium ${tone}`}
    >
      {label}
    </span>
  );
}

/**
 * Avance hacia el mínimo del objetivo, cuando lo hay y aún no se cumple. La
 * barra solo refuerza el texto, que ya dice cuánto falta; por eso es decorativa.
 */
function MinimumProgress({
  current,
  minimum,
}: {
  current: number;
  minimum: ObjectiveMinimumView | null;
}) {
  if (minimum === null) {
    return null;
  }

  if (current >= minimum.value) {
    return null;
  }

  const missing = minimum.value - current;
  const percent =
    minimum.value > 0
      ? Math.min(100, Math.round((current / minimum.value) * 100))
      : 0;

  return (
    <div className="mt-3">
      <p className="text-xs text-muted">
        Te {missing === 1 ? "falta" : "faltan"}{" "}
        <span className="font-medium text-foreground">
          {countUnits(missing, minimum.unit)}
        </span>{" "}
        para el mínimo de <span className="tabular-nums">{minimum.value}</span>
      </p>
      <div
        aria-hidden="true"
        className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-line"
      >
        <span
          className="block h-full rounded-full bg-accent/70"
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}

/** Entrada de las cuentas de cabecera y del resumen. */
function HeaderStat({
  label,
  value,
  accent = false,
}: {
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <div className="min-w-0">
      <dd
        className={`font-display text-lg font-semibold tabular-nums ${
          accent ? "text-accent" : "text-foreground"
        }`}
      >
        {value}
      </dd>
      <dt className="text-xs text-muted">{label}</dt>
    </div>
  );
}

/** Check del distintivo de conseguido. */
function CheckIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <path d="M2.5 6.5 5 9l4.5-5.5" />
    </svg>
  );
}

/** "3 objetivos" / "1 objetivo". */
function objectiveCount(count: number): string {
  return count === 1 ? "1 objetivo" : `${count} objetivos`;
}

/** "4 partidas" / "1 victoria", en la unidad del mínimo. */
function countUnits(count: number, unit: "partidas" | "victorias"): string {
  if (unit === "victorias") {
    return count === 1 ? "1 victoria" : `${count} victorias`;
  }

  return count === 1 ? "1 partida" : `${count} partidas`;
}

/**
 * Valor actual del jugador en la métrica del objetivo, en la unidad que se lee
 * de un vistazo. Es el mismo criterio de `formatValue` (tarjetas de
 * `/objetivos`): en `winrate` se pinta el récord con su porcentaje, porque el
 * valor son victorias de `matches` partidas.
 */
function formatMetricValue(objective: ParticipantObjective): string {
  const { value, matches } = objective;

  switch (objective.metric) {
    case "partidas":
      return value === 1 ? "1 partida" : `${value} partidas`;
    case "racha":
      return value === 1 ? "1 victoria seguida" : `${value} victorias seguidas`;
    case "victorias":
      return value === 1 ? "1 victoria" : `${value} victorias`;
    case "winrate": {
      if (matches <= 0) {
        return "Sin partidas";
      }

      const losses = matches - value;
      const percentage = Math.round((value / matches) * 100);

      // Espacio duro antes del «%»: en español no se separa de su cifra.
      return `${value}-${losses} (${percentage}\u00A0%)`;
    }
  }
}

/**
 * Distancia al líder, ya formateada según la métrica.
 *
 * En `partidas`, `victorias` y `racha` la distancia son unidades enteras que
 * faltan. En `winrate` es una fracción de `[0, 1]`, así que se traduce a puntos
 * porcentuales; un valor por debajo del medio punto se muestra como "<1 pp" en
 * vez de redondear a un falso "0 pp". Un `null` (sin puesto o ya primero) no se
 * pinta.
 */
function formatDistance(objective: ParticipantObjective): string | null {
  const { distance, metric } = objective;

  if (distance === null || objective.position === null || objective.position === 1) {
    return null;
  }

  switch (metric) {
    case "partidas":
      return distance === 1 ? "1 partida" : `${distance} partidas`;
    case "victorias":
      return distance === 1 ? "1 victoria" : `${distance} victorias`;
    case "racha":
      return distance === 1 ? "1 victoria seguida" : `${distance} victorias seguidas`;
    case "winrate": {
      const points = distance * 100;
      const rounded = Math.round(points);

      if (rounded === 0 && points > 0) {
        return "<1 pp";
      }

      return `${rounded} pp`;
    }
  }
}

/** Puesto entre los aspirantes, en ordinal («3.º»); sin puesto, se dice. */
function positionText(objective: ParticipantObjective): string {
  if (objective.position === null) {
    return "Sin puesto";
  }

  if (objective.position === 1) {
    return "1.º (líder)";
  }

  return ordinal(objective.position);
}

function ordinal(position: number): string {
  return `${position}.º`;
}
