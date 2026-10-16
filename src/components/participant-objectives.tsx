"use client";

import { useState, type ReactNode } from "react";
import type {
  ObjectiveGroup,
  ParticipantObjective,
  ParticipantObjectives,
} from "@/lib/public";
import { BorderGlow } from "@/components/border-glow";
import { MapGaps, MapPool } from "@/components/objective-card";
import { ObjectiveFeatureFrame } from "@/components/objective-feature-summary";
import { ObjectiveFamilyRail } from "@/components/objective-family-rail";
import { ObjectiveIcon } from "@/components/objective-icon";
import { ObjectiveRankingDialog } from "@/components/objective-ranking-dialog";
import { SectionIndexBar, type DocSection } from "@/components/section-index";
import { StatFigure } from "@/components/stat-figure";
import {
  hasNoCap,
  hasReachedTarget,
  objectiveCloseness,
  objectiveTitle,
  orderByObjectiveProgress,
  prizeLabel,
} from "@/lib/objective-format";

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
 * La pestaña de objetivos de la ficha de un participante.
 *
 * Es la vista de detalle de la columna "Objetivos" de la clasificación: la misma
 * captura de `/objetivos` proyectada sobre un jugador. No recalcula nada —el DAL
 * reutiliza el motor de objetivos—, así que lo que se lee aquí no puede
 * contradecir al ranking de cada objetivo.
 *
 * La cabecera del participante (identidad y cifras) y las pestañas son del layout:
 * aquí solo va lo que es de objetivos —la entradilla del mejor objetivo, el índice
 * de secciones y los bloques—, de modo que pasar a la pestaña de historial no
 * repinte lo que no ha cambiado.
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
 * sección. La clasificación completa de un objetivo se abre en la misma ventana
 * volteable que usa `/objetivos` (`ObjectiveRankingDialog`): al pulsar se ve la
 * clasificación y el giro descubre el resumen del avance del jugador.
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

  // Los puntos de la carrera y el resumen se cuentan sobre los **individuales**:
  // son los que esta pestaña lista. Las cifras de la cabecera —las que hablan del
  // catálogo entero, carruseles incluidos— las cuenta el layout.
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

  return (
    <div className="flex flex-col gap-8">
      {/*
        La entradilla del mejor objetivo abre la pestaña: es de objetivos —habla
        de cuál es el más cercano—, así que no vive en la cabecera del layout, que
        es común a las dos vistas. Va en su propia caja para que la historia se lea
        antes que las secciones, que es donde se comprueba.
      */}
      <div className="rounded-lg border border-line bg-surface px-5 py-4">
        <p className="max-w-[68ch] text-sm leading-relaxed text-muted">
          <BestBetNote bestBet={bestBet} bestDistance={bestDistance} />
        </p>
      </div>

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
          front={
            // La X de cerrar vive en la esquina superior derecha de la propia cara
            // (`ObjectiveFlipDialog`), así que el resumen le reserva ese aire.
            <div className="h-full overflow-y-auto">
              <ParticipantObjectiveFeatureSummary
                objective={active}
                groupLabels={groupLabels}
                mapPool={mapPool}
              />
            </div>
          }
        />
      )}
    </div>
  );
}

/**
 * Entradilla narrativa que abre la pestaña de objetivos: qué objetivo es hoy el
 * más cercano y cuánto le falta. Sin ninguno al alcance, explica por qué y cuándo
 * aparecerá, que es lo que debe hacer un vacío.
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
  // «Conseguidos» es llegar al umbral, como en el resto de la ficha: en estos
  // subobjetivos (3 victorias o 3 partidas con una civilización) coincidía ya con
  // cobrar algo, pero el criterio es el mismo en todas partes.
  const completed = items.filter((objective) =>
    hasReachedTarget(objective, objective.value),
  ).length;

  return (
    <div id={id} className="scroll-mt-24">
      <div className="flex flex-col gap-1 border-b border-line pb-2">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5">
          <h3 className="font-display text-base font-semibold text-foreground">{title}</h3>
          <p className="text-xs tabular-nums text-muted">
            {subobjectiveCount(items.length)} · {achievedCount(completed)}
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
 * El resumen del avance del jugador en un objetivo: emblema, nombre, puntos,
 * los tres datos de su progreso y la regla. Es la cara frontal de la ventana
 * volteable y el contenido de la tarjeta pequeña; el cromo (`BorderGlow`) y el
 * botón que abre la clasificación los pone `ObjectiveCard`.
 */
export function ParticipantObjectiveSummary({
  objective,
  groupLabels,
  mapPool,
  dense = false,
}: {
  objective: ParticipantObjective;
  groupLabels: Record<ObjectiveGroup, string>;
  mapPool: readonly string[];
  dense?: boolean;
}) {
  return (
    <div className={`flex h-full flex-col ${dense ? "p-3" : "p-4"}`}>
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
              <AchievedBadge objective={objective} />
            ) : objective.kind === "competition" ? (
              <PositionBadge position={objective.position} />
            ) : null}
          </div>
          <p className="mt-0.5 text-xs text-muted">{groupLabels[objective.group]}</p>
        </div>

        <PointsPlate objective={objective} />
      </div>

      <dl className="mt-3 grid grid-cols-3 gap-x-3 gap-y-2">
        <Fact label="Tu avance" value={formatMetricValue(objective)} strong />
        <ObjectiveFacts objective={objective} />
      </dl>

      <AchievementProgress objective={objective} />

      <p
        className={`mt-2 text-xs leading-relaxed text-muted ${
          dense ? "line-clamp-2" : ""
        }`}
      >
        {objective.description}
      </p>

      {objective.metric === "mapas" && mapPool.length > 0 ? (
        <ObjectiveMapDetail objective={objective} mapPool={mapPool} />
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
  );
}

/**
 * La cara frontal del objetivo en la ficha de un participante: la misma
 * información que su tarjeta pequeña (emblema, nombre, grupo y detalle, puntos,
 * los tres datos del avance y la regla). Monta el mismo armazón que `/objetivos`
 * —título centrado con filete, emblema en grande y descripción debajo— y lleva a
 * la ranura inferior izquierda el avance del jugador, con los puntos en línea a la
 * derecha sobre el filete y la puerta a la clasificación debajo, que abre el
 * `FlipCard`.
 */
export function ParticipantObjectiveFeatureSummary({
  objective,
  groupLabels,
  mapPool,
}: {
  objective: ParticipantObjective;
  groupLabels: Record<ObjectiveGroup, string>;
  mapPool: readonly string[];
}) {
  // En la tarjeta grande, la barra del logro ya resume "X de Y": repetir "Tu
  // avance" justo encima es redundante. Solo se conserva cuando la barra no se
  // pinta —logro sin umbral, sin tope o ya en el umbral—, para no perder la cifra.
  const showProgressBar =
    objective.kind === "achievement" &&
    objective.target !== null &&
    !hasReachedTarget(objective, objective.value);

  return (
    <ObjectiveFeatureFrame
      target={objective}
      title={objective.label}
      subtitle={
        objective.detail === null
          ? groupLabels[objective.group]
          : `${groupLabels[objective.group]} · ${objective.detail.label}`
      }
      badges={
        objective.achieved ? (
          <AchievedBadge objective={objective} />
        ) : objective.kind === "competition" ? (
          <PositionBadge position={objective.position} />
        ) : null
      }
      points={objective.points}
      pointsTone={objective.achieved ? "accent" : "neutral"}
      description={objective.description}
      detail={
        objective.metric === "mapas" && mapPool.length > 0 ? (
          <ObjectiveMapDetail objective={objective} mapPool={mapPool} />
        ) : undefined
      }
      progress={
        <div className="flex flex-col gap-5">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-4">
            {showProgressBar ? null : (
              <div className="col-span-2">
                <Fact label="Tu avance" value={formatMetricValue(objective)} strong />
              </div>
            )}
            <ObjectiveFacts objective={objective} />
          </dl>

          <AchievementProgress objective={objective} />
        </div>
      }
      actionLabel="Ver clasificación"
    />
  );
}

/**
 * Los dos datos de avance de un objetivo, según su forma: un logro enseña su estado
 * y lo que le falta, y una competición, su puesto y la distancia al primero.
 *
 * En un logro **sin tope** (`victorias`) no hay umbral que alcanzar —se cobra con
 * cada victoria y no se termina nunca—, así que el estado dice la regla y lo que
 * falta se queda en el guion del "no aplica", el mismo que usa la distancia de una
 * competición sin puesto. Lo que lleva cobrado lo dice la placa de la cabecera.
 *
 * «Conseguido» es llegar al umbral, no cobrar algo: un logro acumulativo a medias se
 * lee **en camino** con lo que le queda (`imparable`, 3 de 14 días → "En camino" y
 * "Te falta: 11 días"), aunque su punto por día ya esté en el haber.
 */
function ObjectiveFacts({ objective }: { objective: ParticipantObjective }) {
  if (objective.kind === "achievement") {
    const state = hasNoCap(objective)
      ? "Sin tope"
      : hasReachedTarget(objective, objective.value)
        ? "Conseguido"
        : "En camino";

    return (
      <>
        <Fact label="Estado" value={state} />
        <Fact label="Te falta" value={remainingText(objective) ?? "—"} />
      </>
    );
  }

  return (
    <>
      <Fact label="Posición" value={objective.achieved ? "Poseído" : positionText(objective)} />
      <Fact label="Al primero" value={formatDistance(objective) ?? "—"} />
    </>
  );
}

/**
 * El detalle de mapas de un logro `por-tierra-y-agua` en la ficha.
 *
 * Con avance del jugador (`mapGaps`) se enseñan los mapas que le faltan, que es lo
 * único accionable; sin él —no aparece en el ranking del objetivo— se enseña el pool
 * entero, que es lo que exige la regla.
 */
function ObjectiveMapDetail({
  objective,
  mapPool,
}: {
  objective: ParticipantObjective;
  mapPool: readonly string[];
}) {
  return objective.mapGaps === null ? (
    <MapPool maps={mapPool} />
  ) : (
    <MapGaps gaps={objective.mapGaps} />
  );
}

/**
 * Una tarjeta de objetivo. El cromo lo pinta `BorderGlow` (halo dorado y estela
 * interior) y la tarjeta entera es un botón invisible que abre su clasificación,
 * igual que en `/objetivos`: mismo hover, mismo cursor de clic y mismo destino.
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
  return (
    <BorderGlow className="h-full">
      <ParticipantObjectiveSummary
        objective={objective}
        groupLabels={groupLabels}
        mapPool={mapPool}
        dense={dense}
      />

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
 *
 * Un logro **sin tope** va en el mismo sitio —está cobrando puntos— pero no lleva
 * el check ni el «Conseguido», que ahí no significan nada: el subtítulo dice la
 * regla («Sin tope») y el rótulo lleva delante sus repeticiones (`24×Victorias`),
 * con lo que va sumado en la cifra de la derecha.
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
  const noCap = hasNoCap(objective);
  // Cobrar y completar son cosas distintas: `imparable` paga desde el primer día, así
  // que un logro a medias se lee «en camino» aunque esté en el haber del jugador.
  const reached = hasReachedTarget(objective, objective.value);
  const subtitle = achieved
    ? noCap
      ? "Sin tope"
      : reached
        ? "Conseguido"
        : "En camino"
    : groupLabels[objective.group];
  // Un logro sin tope todavía sin cobrar enseña el precio de cada unidad, no un
  // premio: el chip lo dice al lado para no parecer que reparte eso de golpe.
  const unitPrice = noCap && !achieved;

  return (
    <button
      type="button"
      onClick={() => onOpen(objective)}
      aria-label={`Ver la clasificación de ${objective.label}${
        achieved && (noCap || reached) ? (noCap ? " (sin tope)" : " (conseguido)") : ""
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
        <span className="block truncate text-sm tabular-nums text-foreground transition-colors group-hover:text-accent">
          {objectiveTitle(objective)}
        </span>
        <span
          className={`block truncate text-xs ${achieved ? "text-accent" : "text-muted"}`}
        >
          {subtitle}
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-1.5">
        {achieved && !noCap && reached ? (
          <CheckIcon className="size-3.5 shrink-0 text-accent" />
        ) : null}
        <span className="font-display text-sm font-semibold tabular-nums text-muted">
          {objective.points}
          {unitPrice ? null : <span className="sr-only"> puntos</span>}
        </span>
        {unitPrice ? (
          <span className="text-xs text-muted">{prizeLabel(objective)}</span>
        ) : null}
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
          <StatFigure
            label="Objetivos que lideras"
            value={String(leading)}
            accent={leading > 0}
          />
          <StatFigure label="En el podio de aspirantes" value={String(onPodium)} />
          <StatFigure label="A un puesto del liderato" value={String(oneAway)} />
          <StatFigure label="Puntos al alcance" value={String(contendingPoints)} />
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

/**
 * Los puntos del objetivo en la ficha, en una placa a la derecha de la fila.
 *
 * La cifra es **lo que el jugador lleva cobrado** por ese objetivo (o lo que
 * cobraría: el precio del catálogo si aún no lo tiene, y en un logro sin tope sin
 * cobrar todavía, el valor de cada unidad). Por eso el pie cambia: `puntos` cuando la
 * cifra es un total suyo, y `puntos por victoria` cuando lo que enseña es lo que paga
 * cada unidad, o parecería que el objetivo reparte eso de golpe.
 */
function PointsPlate({ objective }: { objective: ParticipantObjective }) {
  const achieved = objective.achieved;
  const unitPrice = hasNoCap(objective) && !achieved;

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
        {objective.points}
      </span>
      <span className="mt-1 block max-w-[6.5rem] text-xs font-medium uppercase leading-tight tracking-wide text-muted">
        {unitPrice ? prizeLabel(objective) : "puntos"}
      </span>
    </span>
  );
}

/**
 * Distintivo del logro en el haber del jugador: dice en qué punto está.
 *
 * Un logro sin tope no se «consigue» (se cobra con cada victoria y no hay un momento
 * en que se termine), y uno acumulativo con umbral puede estar **en camino** aunque ya
 * pague: `imparable` da un punto por día, así que con tres de catorce no lleva check.
 * El check es del umbral, no de cobrar.
 */
function AchievedBadge({ objective }: { objective: ParticipantObjective }) {
  if (hasNoCap(objective)) {
    return <Badge>Sin tope</Badge>;
  }

  if (!hasReachedTarget(objective, objective.value)) {
    return <Badge>En camino</Badge>;
  }

  return (
    <Badge>
      <CheckIcon className="size-3 shrink-0" />
      Conseguido
    </Badge>
  );
}

/** El cromo de las tres caras del distintivo: mismo tono de acento para las tres. */
function Badge({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-accent/40 bg-accent/10 px-2 py-0.5 text-xs font-medium text-accent">
      {children}
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
 * Barra de avance de un logro: cuánto lleva de su umbral. La barra solo refuerza el
 * dato, que ya va en "Tu avance"; por eso es decorativa. Solo desaparece cuando no hay
 * umbral (una competición no llega aquí, y `victorias` no se completa) o cuando el
 * logro ya ha llegado a él: mientras va **en camino**, la barra es justo lo que dice
 * cuánto le queda, aunque el punto por día ya esté cobrado.
 */
function AchievementProgress({ objective }: { objective: ParticipantObjective }) {
  if (objective.target === null || hasReachedTarget(objective, objective.value)) {
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
