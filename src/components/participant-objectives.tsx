"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import type {
  ObjectiveGroup,
  ParticipantObjective,
  ParticipantObjectives,
} from "@/lib/public";
import { BorderGlow } from "@/components/border-glow";
import { divisionColor } from "@/components/division-icon";
import {
  LeagueIcon,
  leagueFilterRank,
  rankLevelToLeague,
} from "@/components/league-icon";
import { MapPool } from "@/components/objective-card";
import { ObjectiveFamilyRail } from "@/components/objective-family-rail";
import { ObjectiveIcon } from "@/components/objective-icon";
import { ObjectiveRankingDialog } from "@/components/objective-ranking-dialog";
import { PageHead } from "@/components/page-head";
import { PlayerAvatar } from "@/components/player-avatar";
import { SectionIndexBar, type DocSection } from "@/components/section-index";
import { objectiveCloseness, orderByObjectiveProgress } from "@/lib/objective-format";

/**
 * Las familias de objetivos de civilización, en el orden en que se leen: la
 * cabeza (que sigue en las secciones, porque es un objetivo que se consigue) y
 * el rótulo del carrusel de sus subobjetivos. Los ids de las cabezas van como
 * literales: son contrato estable (ver `src/lib/objectives.ts`), pero este
 * componente es de cliente y no puede importar de `@/lib/public`.
 */
const FAMILIES: readonly { headId: string; id: string; title: string }[] = [
  { headId: "polifacetico", id: "lider", title: "Líder" },
  { headId: "jugon", id: "acolito", title: "Acólito" },
];

/** Bloques de la ficha, en el orden en que se leen. Alimentan el índice. */
const SECTIONS: readonly DocSection[] = [
  { id: "al-alcance", label: "Al alcance" },
  { id: "en-posesion", label: "En posesión" },
  { id: "sin-disputar", label: "Sin disputar" },
  { id: "resumen", label: "En resumen" },
];

const SECTION_INDEX_LABEL = "Secciones de los objetivos del participante";

/**
 * Ficha pública de objetivos de un participante.
 *
 * Es la vista de detalle de la columna "Objetivos" de la clasificación: la
 * misma captura de `/objetivos` proyectada sobre un jugador. No recalcula nada
 * —el DAL reutiliza el motor de objetivos—, así que lo que se lee aquí no puede
 * contradecir al ranking de cada objetivo.
 *
 * Los objetivos **individuales** se leen en tres bloques, en este orden: lo
 * primero es lo que está al alcance —ordenado de más a menos cerca de cobrarlo—
 * y después el botín ya conseguido y lo que todavía no se disputa. Los dos
 * últimos van en fichas compactas: en conjunto aplastarían la página si se
 * pintaran con tarjetas completas.
 *
 * Los subobjetivos de civilización (`lider-*`, `acolito-*`) no van sueltos por
 * las secciones: se agrupan, uno por familia, en los carruseles de `Líder` y
 * `Acólito`, **dentro de "Al alcance"** y justo después de sus tarjetas
 * individuales, porque su avance se sigue igual que el de ellas. Las tarjetas de
 * cada carrusel van de mayor a menor porcentaje de consecución. La cabeza de cada
 * familia (`polifacetico`, `jugon`) sí es un objetivo individual y sigue en su
 * sección. La clasificación completa de un objetivo se abre en el mismo diálogo
 * que usa `/objetivos`, reutilizando `ObjectiveRankingDialog`.
 */
export function ParticipantObjectivesView({
  data,
  groupLabels,
}: {
  data: ParticipantObjectives;
  groupLabels: Record<ObjectiveGroup, string>;
}) {
  const { player, options, mapPool } = data;
  const [active, setActive] = useState<ParticipantObjective | null>(null);

  // Las secciones y los carruseles se reparten los objetivos: los hijos de una
  // familia van al carrusel de su cabeza; todo lo demás, a las secciones.
  const individual = options.filter((option) => option.parent === null);
  const achievedIndividual = individual.filter((option) => option.achieved);
  // "Al alcance" se ordena por cercanía a cobrarlo (ver `objectiveCloseness`):
  // más avance o mejor puesto, más arriba. `options` llega en el orden del
  // catálogo, así que las secciones no ordenadas lo conservan.
  const contending = individual
    .filter((option) => !option.achieved && option.position !== null)
    .sort(compareCloseness);
  const waiting = individual.filter(
    (option) => !option.achieved && option.position === null,
  );

  const families = FAMILIES.flatMap((family) => {
    const head = options.find((option) => option.id === family.headId) ?? null;
    const children = options.filter((option) => option.parent === family.headId);

    return head === null || children.length === 0
      ? []
      : [
          {
            id: family.id,
            title: family.title,
            head,
            // De mayor a menor porcentaje de consecución: el más avanzado, a la
            // izquierda, y el conseguido (100 %) el primero.
            children: orderByObjectiveProgress(children),
          },
        ];
  });

  // Las cuentas de cabecera son del catálogo entero: los carruseles también son
  // objetivos. Las secciones que vienen debajo muestran solo los individuales.
  const achieved = options.filter((option) => option.achieved);
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

  return (
    <div className="flex flex-col gap-8">
      <PageHead title={`Objetivos de ${player.name}`} />

      <nav aria-label="Migas de pan" className="min-w-0 text-sm">
        <ol className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <li className="flex min-w-0 items-center gap-x-2">
            <Link href="/" className="text-muted transition-colors hover:text-accent">
              Clasificación
            </Link>
            <span aria-hidden="true" className="text-muted/50">
              /
            </span>
          </li>
          <li className="flex min-w-0 items-center gap-x-2">
            <Link
              href="/objetivos"
              className="text-muted transition-colors hover:text-accent"
            >
              Objetivos
            </Link>
            <span aria-hidden="true" className="text-muted/50">
              /
            </span>
          </li>
          <li className="min-w-0">
            <span aria-current="page" title={player.name} className="block truncate">
              {player.name}
            </span>
          </li>
        </ol>
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

      <SectionIndexBar sections={SECTIONS} ariaLabel={SECTION_INDEX_LABEL} />

      <ObjectiveSection
        id="al-alcance"
        title="Al alcance"
        note={
          contending.length === 1
            ? "1 objetivo en el que ya cuentas"
            : `${contending.length} objetivos en los que ya cuentas`
        }
        pointsLabel="en juego"
        items={contending}
        groupLabels={groupLabels}
        mapPool={mapPool}
        emptyMessage="Ahora mismo no apareces en la clasificación de ningún objetivo. En cuanto cierres una partida que cuente para uno, saldrá aquí tu puesto."
        onOpen={setActive}
        highlight
      >
        {families.map((family) => (
          <FamilyCarouselSection
            key={family.id}
            id={family.id}
            title={family.title}
            headLabel={family.head.label}
            items={family.children}
            groupLabels={groupLabels}
            mapPool={mapPool}
            onOpen={setActive}
          />
        ))}
      </ObjectiveSection>

      <ObjectiveSection
        id="en-posesion"
        title="En posesión"
        note={
          achievedIndividual.length === 1
            ? "1 objetivo en tu haber"
            : `${achievedIndividual.length} objetivos en tu haber`
        }
        pointsLabel="en tu haber"
        items={achievedIndividual}
        groupLabels={groupLabels}
        mapPool={mapPool}
        emptyMessage="Todavía no has ganado ningún objetivo especial. Los tienes listados abajo, con lo que pide cada uno."
        onOpen={setActive}
        compact
      />

      <ObjectiveSection
        id="sin-disputar"
        title="Sin disputar todavía"
        note={
          waiting.length === 1
            ? "1 objetivo en el que aún no has empezado tu participación"
            : `${waiting.length} objetivos en los que aún no has empezado tu participación`
        }
        pointsLabel="en juego"
        items={waiting}
        groupLabels={groupLabels}
        mapPool={mapPool}
        emptyMessage="Estás en la carrera de todos los objetivos."
        onOpen={setActive}
        compact
      />

      <SummarySection
        leading={leading}
        onPodium={onPodium}
        oneAway={oneAway}
        contendingPoints={contendingPoints}
      />

      {active === null ? null : (
        <ObjectiveRankingDialog
          key={active.id}
          option={active}
          highlightProfileId={player.profileId}
          onClose={() => setActive(null)}
        />
      )}
    </div>
  );
}

/**
 * Entradilla narrativa de la cabecera: qué objetivo es hoy el más cercano y
 * cuánto le falta. Sin ninguno al alcance, explica por qué y cuándo aparecerá,
 * que es lo que debe hacer un vacío.
 *
 * La frase se adapta al tipo del objetivo más cercano: un logro se cuenta por lo
 * que le falta para el umbral; una competición, por el puesto y la distancia al
 * liderato. El orden de "Al alcance" mezcla los dos tipos, así que la entradilla
 * no puede dar por hecho que el primero sea una carrera.
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

  if (bestBet.kind === "achievement") {
    return (
      <>
        Tu objetivo más cercano es{" "}
        <strong className="font-medium text-foreground">{bestBet.label}</strong>: te
        falta{" "}
        <strong className="font-medium text-foreground">
          {remainingText(bestBet) ?? "—"}
        </strong>{" "}
        para conseguirlo.
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
  mapPool,
  emptyMessage,
  onOpen,
  highlight = false,
  compact = false,
  children,
}: {
  id: string;
  title: string;
  note: string;
  pointsLabel: string;
  items: ParticipantObjective[];
  groupLabels: Record<ObjectiveGroup, string>;
  mapPool: readonly string[];
  emptyMessage: string;
  onOpen: (objective: ParticipantObjective) => void;
  highlight?: boolean;
  compact?: boolean;
  /** Bloques que van dentro de la sección, tras sus tarjetas (los carruseles). */
  children?: ReactNode;
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
        children === undefined ? (
          <p className="mt-3 rounded-lg border border-dashed border-line bg-surface/40 px-5 py-6 text-sm text-muted">
            {emptyMessage}
          </p>
        ) : null
      ) : compact ? (
        <ul className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
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
        <ul className="mt-3 grid gap-3 lg:grid-cols-2 xl:grid-cols-3">
          {items.map((objective) => (
            <li key={objective.id}>
              <ObjectiveCard
                objective={objective}
                groupLabels={groupLabels}
                mapPool={mapPool}
                onOpen={onOpen}
              />
            </li>
          ))}
        </ul>
      )}

      {children === undefined ? null : (
        <div className="mt-8 flex flex-col gap-8">{children}</div>
      )}
    </section>
  );
}

/**
 * Carrusel de una familia de civilización en la ficha del participante.
 *
 * Monta el mismo riel que `/objetivos` (`ObjectiveFamilyRail`) con las tarjetas
 * de avance del jugador en vez de las globales, y añade el titular con el
 * recuento de lo conseguido. Vive **dentro de "Al alcance"**, justo después de
 * sus tarjetas individuales: son objetivos cuyo avance se sigue igual. Las
 * tarjetas llegan ya ordenadas de mayor a menor porcentaje de consecución. La
 * cabeza de la familia no se repite aquí: vive en las secciones individuales.
 */
function FamilyCarouselSection({
  id,
  title,
  headLabel,
  items,
  groupLabels,
  mapPool,
  onOpen,
}: {
  id: string;
  title: string;
  headLabel: string;
  items: ParticipantObjective[];
  groupLabels: Record<ObjectiveGroup, string>;
  mapPool: readonly string[];
  onOpen: (objective: ParticipantObjective) => void;
}) {
  const achieved = items.filter((objective) => objective.achieved).length;

  return (
    <div id={id} className="scroll-mt-24">
      <div className="flex flex-col gap-1 border-b border-line pb-2">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5">
          <h3 className="font-display text-base font-semibold text-foreground">{title}</h3>
          <p className="text-xs tabular-nums text-muted">
            {subobjectiveCount(items.length)} · {achievedCount(achieved)}
          </p>
        </div>
        <p className="mt-0.5 text-xs text-muted">
          Objetivos por civilización; completarlos todos suma el extra de {headLabel}.
        </p>
      </div>

      <div className="mt-3 flex flex-col gap-4">
        <ObjectiveFamilyRail
          items={items}
          itemClassName="w-[18rem] shrink-0 snap-start sm:w-[20rem]"
          renderCard={(objective) => (
            <ObjectiveCard
              objective={objective}
              groupLabels={groupLabels}
              mapPool={mapPool}
              onOpen={onOpen}
              dense
            />
          )}
        />
      </div>
    </div>
  );
}

/**
 * Una tarjeta de objetivo. La jerarquía la fija el orden: arriba la identidad
 * (emblema, nombre y puntos); debajo, como protagonista, el avance del jugador
 * en sus tres datos; y al final, en tono apagado, lo accesorio (la regla) y la
 * puerta a la clasificación. El pie va anclado abajo (`mt-auto`) para que las
 * tarjetas de una misma fila lo alineen aunque su texto no ocupe lo mismo.
 *
 * La misma tarjeta sirve en la rejilla de las secciones y en el riel de un
 * carrusel de familia. En el riel va `dense`: el ancho es fijo y más estrecho,
 * así que se aprieta el relleno y se recorta la regla a dos líneas para que no
 * desborde. La rejilla interior de tres datos se sostiene con `break-words` en
 * los valores: palabras largas como "civilizaciones" parten antes que salirse.
 *
 * El cromo lo pinta `BorderGlow` (halo dorado) y la tarjeta entera es un botón
 * invisible que abre su clasificación, igual que en `/objetivos`: mismo hover,
 * mismo cursor de clic y mismo destino.
 */
function ObjectiveCard({
  objective,
  groupLabels,
  mapPool,
  onOpen,
  dense = false,
}: {
  objective: ParticipantObjective;
  groupLabels: Record<ObjectiveGroup, string>;
  mapPool: readonly string[];
  onOpen: (objective: ParticipantObjective) => void;
  dense?: boolean;
}) {
  const distance = formatDistance(objective);

  return (
    <BorderGlow className="h-full">
      <div className={`flex h-full flex-col ${dense ? "p-4" : "p-5"}`}>
        <div className="flex items-start gap-3">
          <span className="flex size-11 shrink-0 items-center justify-center rounded-md border border-line bg-surface-raised">
            <ObjectiveIcon option={objective} className="size-6 shrink-0" />
          </span>

          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <h3 className="min-w-0 font-display text-base font-semibold leading-snug text-foreground">
                {objective.label}
              </h3>
              {objective.detail !== null ? (
                <span className="text-xs text-muted">({objective.detail.label})</span>
              ) : null}
              {objective.achieved ? (
                <AchievedBadge />
              ) : objective.kind === "competition" ? (
                <PositionBadge position={objective.position} />
              ) : null}
            </div>
            <p className="mt-0.5 text-xs text-muted">{groupLabels[objective.group]}</p>
          </div>

          <PointsPlate points={objective.points} achieved={objective.achieved} />
        </div>

        <dl className="mt-4 grid grid-cols-3 gap-x-3 gap-y-2">
          <Fact label="Tu avance" value={formatMetricValue(objective)} strong />
          {objective.kind === "achievement" ? (
            <>
              <Fact label="Estado" value={objective.achieved ? "Conseguido" : "En camino"} />
              <Fact label="Te falta" value={remainingText(objective) ?? "—"} />
            </>
          ) : (
            <>
              <Fact
                label="Posición"
                value={objective.achieved ? "Poseído" : positionText(objective)}
              />
              <Fact label="Al primero" value={distance ?? "—"} />
            </>
          )}
        </dl>

        <AchievementProgress objective={objective} />

        <p
          className={`mt-3 text-xs leading-relaxed text-muted ${
            dense ? "line-clamp-2" : ""
          }`}
        >
          {objective.description}
        </p>

        {objective.metric === "mapas" && mapPool.length > 0 ? (
          <MapPool maps={mapPool} />
        ) : null}

        <div className="mt-auto flex items-end justify-end border-t border-line pt-3">
          {/* El clic lo recoge el botón invisible que cubre la tarjeta; el pie
              solo anuncia la acción, como en `/objetivos`. */}
          <span className="pointer-events-none inline-flex shrink-0 items-center gap-1 text-xs font-medium text-accent">
            Ver clasificación
            <Chevron />
          </span>
        </div>
      </div>

      <button
        type="button"
        onClick={() => onOpen(objective)}
        aria-label={`Ver la clasificación de ${objective.label}`}
        className="absolute inset-0 z-10 rounded-lg"
      />
    </BorderGlow>
  );
}

/** Flecha del pie de la tarjeta. */
function Chevron() {
  return (
    <svg
      viewBox="0 0 12 12"
      aria-hidden="true"
      className="size-3 shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4.5 2.5 8 6l-3.5 3.5" />
    </svg>
  );
}

/**
 * Ficha compacta de un objetivo: el índice de los que aún no se disputan y el de
 * los ya conseguidos. Los conseguidos se distinguen por el tinte, el subtítulo
 * ("Conseguido", en lugar del grupo) y el check; así "En posesión" conserva la
 * lectura de botín aunque comparta el tratamiento compacto.
 */
function ObjectiveChip({
  objective,
  groupLabels,
  onOpen,
}: {
  objective: ParticipantObjective;
  groupLabels: Record<ObjectiveGroup, string>;
  onOpen: (objective: ParticipantObjective) => void;
}) {
  const achieved = objective.achieved;

  return (
    <button
      type="button"
      onClick={() => onOpen(objective)}
      aria-label={`Ver la clasificación de ${objective.label}${
        achieved ? " (conseguido)" : ""
      }`}
      className={`group flex w-full items-center gap-3 rounded-md border px-3 py-2.5 text-left transition-colors ${
        achieved
          ? "border-accent/35 bg-surface hover:bg-accent/5"
          : "border-transparent bg-surface hover:bg-surface-raised"
      }`}
    >
      <span
        className={`flex size-8 shrink-0 items-center justify-center rounded-md border ${
          achieved
            ? "border-accent/40 bg-accent/5"
            : "border-line bg-surface-raised"
        }`}
      >
        <ObjectiveIcon option={objective} className="size-4 shrink-0" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-foreground transition-colors group-hover:text-accent">
          {objective.label}
        </span>
        <span
          className={`block truncate text-xs ${achieved ? "text-accent" : "text-muted"}`}
        >
          {achieved ? "Conseguido" : groupLabels[objective.group]}
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-1.5">
        {achieved ? <CheckIcon className="size-3.5 shrink-0 text-accent" /> : null}
        <span className="font-display text-sm font-semibold tabular-nums text-muted">
          {objective.points}
          <span className="sr-only"> puntos</span>
        </span>
      </span>
    </button>
  );
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
 * Dato del avance: rótulo pequeño arriba y valor debajo, con más peso. Sin
 * recorte: el valor se lee entero y, si no cabe, hace wrap en vez de perderse.
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
      <dt className="text-xs text-muted">{label}</dt>
      <dd
        className={`mt-0.5 break-words text-sm text-foreground tabular-nums ${
          strong ? "font-semibold" : "font-medium"
        }`}
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
 * Barra de avance de un logro: cuánto lleva de su umbral. La barra solo refuerza
 * el dato, que ya va en "Tu avance"; por eso es decorativa.
 */
function AchievementProgress({ objective }: { objective: ParticipantObjective }) {
  if (objective.target === null || objective.achieved) {
    return null;
  }

  const { value } = objective;
  const { value: target } = objective.target;
  const percent = target > 0 ? Math.min(100, Math.round((value / target) * 100)) : 0;

  return (
    <div className="mt-3">
      <p className="text-xs text-muted">
        Llevas <span className="font-medium text-foreground tabular-nums">{value}</span> de{" "}
        <span className="tabular-nums">{target}</span>.
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

/** "3 subobjetivos" / "1 subobjetivo". */
function subobjectiveCount(count: number): string {
  return count === 1 ? "1 subobjetivo" : `${count} subobjetivos`;
}

/** "3 conseguidos" / "1 conseguido". */
function achievedCount(count: number): string {
  return count === 1 ? "1 conseguido" : `${count} conseguidos`;
}

/**
 * Orden de "Al alcance": de más a menos cerca de cobrar el objetivo.
 *
 * La cercanía la mide `objectiveCloseness` (fracción común a logros y
 * competiciones); el empate se rompe por la distancia al líder y, si todavía
 * empatan, por el nombre, para que el orden no dependa del azar del ranking.
 */
function compareCloseness(a: ParticipantObjective, b: ParticipantObjective): number {
  return (
    objectiveCloseness(b) - objectiveCloseness(a) ||
    (a.distance ?? Number.POSITIVE_INFINITY) -
      (b.distance ?? Number.POSITIVE_INFINITY) ||
    a.label.localeCompare(b.label, "es")
  );
}

/**
 * Valor actual del jugador en la métrica del objetivo, en la unidad que se lee
 * de un vistazo.
 */
function formatMetricValue(objective: ParticipantObjective): string {
  const { value } = objective;

  switch (objective.metric) {
    case "partidas":
      return value === 1 ? "1 partida" : `${value} partidas`;
    case "racha":
      return value === 1 ? "1 victoria seguida" : `${value} victorias seguidas`;
    case "victorias":
      return value === 1 ? "1 victoria" : `${value} victorias`;
    case "dias":
      return value === 1 ? "1 día" : `${value} días`;
    case "civilizaciones":
      return `${value}/${objective.target?.value ?? "?"} civilizaciones`;
    case "mapas":
      return `${value}/${objective.target?.value ?? "?"} mapas`;
  }
}

/**
 * Distancia al líder, ya formateada según la métrica. Un `null` (sin puesto o ya
 * primero) no se pinta.
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
    case "dias":
      return distance === 1 ? "1 día" : `${distance} días`;
    case "civilizaciones":
      return `${distance} civilizaciones`;
    case "mapas":
      return `${distance} mapas`;
  }
}

/**
 * Cuánto le falta a un logro para su umbral, en la unidad de su métrica. `null`
 * en las competiciones, que no tienen umbral.
 */
function remainingText(objective: ParticipantObjective): string | null {
  const { target } = objective;

  if (target === null) {
    return null;
  }

  const remaining = Math.max(0, target.value - objective.value);

  switch (objective.metric) {
    case "partidas":
      return remaining === 1 ? "1 partida" : `${remaining} partidas`;
    case "victorias":
      return remaining === 1 ? "1 victoria" : `${remaining} victorias`;
    case "racha":
      return remaining === 1 ? "1 victoria seguida" : `${remaining} victorias seguidas`;
    case "dias":
      return remaining === 1 ? "1 día" : `${remaining} días`;
    case "civilizaciones":
      return `${remaining} civilizaciones`;
    case "mapas":
      return `${remaining} mapas`;
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
