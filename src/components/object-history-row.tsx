import type { ReactNode } from "react";
import Link from "next/link";
import { ObjectIcon } from "@/components/object-icon";
import { formatAbsoluteTime, formatRelativeTime } from "@/lib/format";
import type {
  ObjectHistoryEvent,
  ObjectHistoryKind,
  ObjectHistoryPlayer,
} from "@/lib/object-history";

/**
 * El rótulo de cada tipo de evento. Es la primera señal para distinguirlos y no
 * depende del color: los cuatro dicen qué pasó con una palabra propia.
 */
const KIND_LABEL: Record<ObjectHistoryKind, string> = {
  AWARD: "Premio",
  THROW: "Lanzamiento",
  RETURN: "Devolución",
  FULFILL: "Cumplimiento",
};

/** El nombre de un jugador, enlazado a su ficha pública. */
function PlayerName({ player }: { player: ObjectHistoryPlayer }) {
  return (
    <Link
      href={`/detalle-jugador/${player.profileId}`}
      className="font-medium text-foreground underline decoration-line-strong underline-offset-4 transition-colors hover:text-accent hover:decoration-accent"
    >
      {player.name}
    </Link>
  );
}

/**
 * La frase del evento, con el sujeto ya resuelto.
 *
 * El premio y el cumplimiento no tienen contrario. En un lanzamiento puede faltar
 * el objetivo —si no existe o no está aprobado, la lectura lo deja a `null`—, así
 * que la frase se cierra sin él en vez de dejar un hueco o un "a nadie": sigue
 * siendo cierta y completa con lo que se sabe. Una devolución usa «se le devolvió»
 * para no concordar con el género del objeto y funcionar igual con reliquia,
 * moneda o monumento.
 */
function describeEvent(event: ObjectHistoryEvent): ReactNode {
  const object = `«${event.object.name}»`;

  if (event.kind === "AWARD") {
    return (
      <>
        <PlayerName player={event.player} /> ganó {object}.
      </>
    );
  }

  if (event.kind === "FULFILL") {
    return (
      <>
        <PlayerName player={event.player} /> cumplió la desventaja de {object}.
      </>
    );
  }

  if (event.kind === "RETURN") {
    return (
      <>
        <PlayerName player={event.player} /> lanzó {object}
        {event.opponent === null ? null : (
          <>
            {" "}
            a <PlayerName player={event.opponent} />
          </>
        )}{" "}
        y se le devolvió.
      </>
    );
  }

  return (
    <>
      <PlayerName player={event.player} /> lanzó {object}
      {event.opponent === null ? (
        "."
      ) : (
        <>
          {" "}
          a <PlayerName player={event.opponent} />.
        </>
      )}
    </>
  );
}

/**
 * Una fila del feed de objetos: un premio, un lanzamiento, una devolución o una
 * desventaja cumplida.
 *
 * Sigue la fila del historial de puntos: la fecha relativa —con el instante
 * exacto en el `title` y en el `datetime` del `<time>`— y el rótulo del tipo en la
 * línea de contexto, la frase con el jugador enlazado a su ficha y, debajo, la
 * desventaja del objeto. El premio y el cumplimiento se tiñen del oro de la liga
 * porque son los hitos del objeto —cuando llega y cuando se supera—; el
 * lanzamiento y la devolución se quedan neutros. El color solo refuerza: el
 * rótulo y la frase ya dicen qué pasó.
 */
export function ObjectHistoryRow({ row }: { row: ObjectHistoryEvent }) {
  const milestone = row.kind === "AWARD" || row.kind === "FULFILL";

  return (
    <li className={`px-4 py-3 ${milestone ? "bg-accent/[0.06]" : ""}`}>
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
        <time
          dateTime={row.at.toISOString()}
          title={formatAbsoluteTime(row.at)}
          className="tabular-nums"
        >
          {formatRelativeTime(row.at)}
        </time>
        <span aria-hidden="true">·</span>
        <span
          className={`inline-block rounded-full border px-2 py-0.5 font-medium ${
            milestone
              ? "border-accent/40 bg-accent/10 text-accent"
              : "border-line-strong bg-surface-raised text-muted"
          }`}
        >
          {KIND_LABEL[row.kind]}
        </span>
      </p>

      <p className="mt-0.5 flex items-start gap-2 text-sm leading-relaxed text-foreground">
        <ObjectIcon kind={row.object.kind} className="mt-0.5 size-5 shrink-0" />
        <span className="min-w-0">{describeEvent(row)}</span>
      </p>

      <p className="mt-1.5 pl-7 text-xs leading-relaxed text-muted">
        <span className="font-medium text-foreground">Desventaja:</span>{" "}
        {row.penalty.text ?? "no disponible en el catálogo actual."}
      </p>
    </li>
  );
}

/**
 * El feed completo, sobre el mismo bloque de `surface` y con el mismo filete que
 * la lista del historial de puntos, para que los dos historiales no se separen en
 * cuanto uno cambie de bordes.
 */
export function ObjectHistoryList({ rows }: { rows: readonly ObjectHistoryEvent[] }) {
  return (
    <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface">
      {rows.map((row) => (
        <ObjectHistoryRow key={row.id} row={row} />
      ))}
    </ul>
  );
}
