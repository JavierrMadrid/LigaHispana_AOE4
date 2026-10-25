import { CivilizationIcon } from "@/components/civilization-icon";
import { familyCivId } from "@/components/objective-family-rail";
import { civilizationName } from "@/lib/civs";
import { hasReachedTarget } from "@/lib/objective-format";
import type { ParticipantObjective } from "@/lib/public";

/** Una civilización de la familia con la cifra que la representa en la lista. */
type FamilyCivEntry = {
  civ: string;
  count: number;
};

/**
 * El avance de una familia de civilización (`Polifacético`, `Jugón`),
 * civilización por civilización.
 *
 * Enseña **la lista más corta de las dos**: si quedan más civilizaciones por
 * completar que hechas, se muestran las hechas, y si quedan menos, las que
 * quedan. Con 1 de 23 se ve la hecha; con 22, la que falta. Cada entrada es una
 * cifra y la bandera de su civilización —el nombre va para lectores de pantalla
 * y de paso como título al pasar el ratón—, y la cabecera dice **cuál es esa
 * cifra**: partidas en `Jugón` (los `acolito-*`) y victorias en `Polifacético`
 * (los `lider-*`), para que el número no se lea sin su unidad.
 *
 * Es el análogo del detalle de mapas de `por-tierra-y-agua` (`MapGaps`), con una
 * diferencia: aquí el avance por civilización vive en los **hijos** de la
 * familia, que la cabeza no referencia, así que quien los pinta los pasa por
 * prop desde la ficha. La cifra de una hecha es su umbral (3) y la de una que
 * queda, lo que falta para él.
 *
 * `limit` recorta la lista para la tarjeta pequeña y añade «y N más»; sin él
 * —la ventana volteable— se lista entera. `align` centra el bloque bajo la
 * descripción de la cara frontal y lo deja a la izquierda en la tarjeta y en la
 * cara de la clasificación.
 */
export function FamilyCivDetail({
  items,
  limit,
  align = "start",
}: {
  items: readonly ParticipantObjective[];
  /** Cuántas entradas caben; sin él, la lista entera. */
  limit?: number;
  /** Alineación del bloque dentro de su contenedor. */
  align?: "start" | "center";
}) {
  const unit = familyUnit(items);

  if (unit === null) {
    return null;
  }

  const done: FamilyCivEntry[] = [];
  const pending: FamilyCivEntry[] = [];

  for (const item of items) {
    const civ = familyCivId(item.id);

    // Sin umbral no hay cifra que enseñar: los hijos de familia lo tienen
    // siempre (3), y sin él se prefiere no pintar nada antes que inventar uno.
    if (civ === null || item.target === null) {
      continue;
    }

    if (hasReachedTarget(item, item.value)) {
      done.push({ civ, count: item.target.value });
    } else {
      pending.push({ civ, count: item.target.value - item.value });
    }
  }

  // La lista más corta de las dos; con las dos vacías no hay nada que pintar.
  const entries =
    pending.length === 0 || (done.length > 0 && done.length <= pending.length) ? done : pending;

  if (entries.length === 0) {
    return null;
  }

  const completed = entries === done;
  const visible = limit === undefined ? entries : entries.slice(0, limit);
  const hidden = entries.length - visible.length;
  const listAlign = align === "center" ? "justify-center" : "justify-start";

  return (
    <div className={align === "center" ? "mt-2 flex flex-col items-center" : "mt-2"}>
      <p className="text-xs leading-relaxed text-muted">
        <span className="font-medium text-foreground/90">
          {completed ? "Hechas" : "Quedan"}
        </span>
        {" · "}
        {unit} por civilización
      </p>

      <ul className={`mt-1.5 flex flex-wrap items-center gap-1.5 ${listAlign}`}>
        {visible.map((entry) => (
          <li
            key={entry.civ}
            title={civilizationName(entry.civ)}
            className="inline-flex items-center gap-1 rounded-md border border-line bg-surface-raised px-1.5 py-1 text-xs tabular-nums text-foreground"
          >
            <span>{entry.count} ×</span>
            <CivilizationIcon
              civ={entry.civ}
              label={civilizationName(entry.civ)}
              className="size-4 shrink-0"
            />
          </li>
        ))}
        {hidden > 0 ? (
          <li className="px-1 text-xs text-muted">y {hidden} más</li>
        ) : null}
      </ul>
    </div>
  );
}

/**
 * La unidad de la cifra de cada civilización, o `null` si la métrica de la
 * familia no tiene una unidad de estas. Es la de los hijos: `partidas` en los
 * `acolito-*` y `victorias` en los `lider-*`.
 */
function familyUnit(items: readonly ParticipantObjective[]): string | null {
  switch (items[0]?.metric) {
    case "partidas":
      return "partidas";
    case "victorias":
      return "victorias";
    default:
      return null;
  }
}
