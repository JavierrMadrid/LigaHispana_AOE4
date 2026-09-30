"use client";

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";

export type ComboboxOption = {
  id: string;
  name: string;
};

type PlayerComboboxProps = {
  options: ComboboxOption[];
  /** `id` elegido, o `""` para "todos". */
  value: string;
  /** Recibe el `id` elegido (`""` para "todos"). */
  onChange: (id: string) => void;
  /** Texto de la opción que representa "sin filtrar". */
  allLabel: string;
  /** `id` del campo, para que el `<label>` del formulario lo apunte. */
  inputId: string;
};

/** Sin acentos ni mayúsculas, para que "chocola" encuentre a "Chocolate". */
function normalize(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

/**
 * Desplegable de jugadores con el buscador **dentro**.
 *
 * No es un `<select>`: la lista de opciones lleva filtro por texto en el mismo
 * desplegable, y un `<select>` nativo no admite contenido propio ni se puede filtrar.
 * Por eso se implementa el patrón *combobox* de ARIA a mano, que es lo que mantiene el
 * teclado y el lector de pantalla funcionando:
 *
 * - `role="combobox"` en el campo, con `aria-expanded`, `aria-controls` y
 *   `aria-activedescendant` apuntando a la opción resaltada.
 * - `role="listbox"` en la lista y `role="option"` en cada fila, con `aria-selected`
 *   en la elegida.
 * - Teclado: abajo/arriba para recorrer (con vuelta por los extremos), Inicio/Fin para
 *   los extremos, Enter para elegir, Escape para cerrar sin cambiar nada.
 *
 * **Una sola lista de opciones**, con "todos" como primera entrada, para que los
 * índices del resaltado y los `id` de los `option` sean el mismo número. Con "todos"
 * fuera de esa lista, el teclado nunca podría volver a "sin filtrar" y el resaltado
 * apuntaría a una fila distinta de la que se ve.
 *
 * El filtro no distingue acentos ni mayúsculas, igual que el buscador de participantes.
 *
 * Se cierra al pulsar fuera, con `pointerdown` y no con `click`: el `click` llega
 * después del `focus` del elemento de fuera, así que cerrar por foco parpadearía al
 * pulsar cualquier control que no sea un campo.
 */
export function PlayerCombobox({
  options,
  value,
  onChange,
  allLabel,
  inputId,
}: PlayerComboboxProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlighted, setHighlighted] = useState(0);

  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const optionId = (index: number) => `${listId}-opt-${index}`;

  const selected = options.find((option) => option.id === value) ?? null;

  /**
   * Las filas de la lista, ya filtradas. "todos" va primera y **no se filtra**:
   * quitarla al escribir dejaría sin forma de volver a "sin filtrar" a quien no
   * borre el texto a mano.
   */
  const items = useMemo<ComboboxOption[]>(() => {
    const todos = { id: "", name: allLabel };
    const needle = normalize(query.trim());

    if (needle === "") {
      return [todos, ...options];
    }

    return [todos, ...options.filter((option) => normalize(option.name).includes(needle))];
  }, [allLabel, options, query]);

  const indexPath = (id: string) => items.findIndex((item) => item.id === id);

  // Texto del campo cuando está cerrado: el nombre elegido, o "todos".
  const closedLabel = selected?.name ?? allLabel;

  useEffect(() => {
    if (!open) {
      return;
    }

    function onPointerDown(event: PointerEvent) {
      if (rootRef.current !== null && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
        setQuery("");
      }
    }

    document.addEventListener("pointerdown", onPointerDown);

    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);

  // Al abrir se resalta la opción elegida, para poder elegirla con Enter sin tocar el
  // ratón. Si no hay ninguna elegida, cae en "todos", que es la primera.
  function abrir() {
    const index = indexPath(value);

    setOpen(true);
    setQuery("");
    setHighlighted(index === -1 ? 0 : index);
  }

  function elegir(id: string) {
    onChange(id);
    setOpen(false);
    setQuery("");
    inputRef.current?.blur();
  }

  function mover(delta: number) {
    setHighlighted((current) => (current + delta + items.length) % items.length);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();

      if (open) {
        mover(1);
      } else {
        abrir();
      }
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();

      if (open) {
        mover(-1);
      }
      return;
    }

    if (open && event.key === "Home") {
      event.preventDefault();
      setHighlighted(0);
      return;
    }

    if (open && event.key === "End") {
      event.preventDefault();
      setHighlighted(items.length - 1);
      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();

      if (!open) {
        abrir();
        return;
      }

      const item = items[highlighted];

      if (item !== undefined) {
        elegir(item.id);
      }
      return;
    }

    if (event.key === "Escape" && open) {
      event.preventDefault();
      setOpen(false);
      setQuery("");
    }
  }

  return (
    <div ref={rootRef} className="relative">
      <input
        ref={inputRef}
        id={inputId}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open ? optionId(highlighted) : undefined}
        value={open ? query : closedLabel}
        onChange={(event) => {
          setQuery(event.target.value);
          setOpen(true);
          setHighlighted(0);
        }}
        onKeyDown={onKeyDown}
        onFocus={abrir}
        placeholder="Buscar jugador"
        autoComplete="off"
        className="h-10 w-full rounded-md border border-line bg-background px-3 text-foreground placeholder:text-muted"
      />

      {open ? (
        <ul
          id={listId}
          role="listbox"
          aria-label="Jugadores"
          className="absolute z-20 mt-1 max-h-72 w-full overflow-y-auto overscroll-contain rounded-md border border-line bg-background py-1 shadow-lg"
        >
          {items.map((item, index) => (
            <li
              key={item.id === "" ? "__todos__" : item.id}
              role="option"
              aria-selected={item.id === value}
              id={optionId(index)}
              onMouseDown={(event) => {
                // `preventDefault` para que el campo no pierda el foco antes de elegir:
                // sin él, el `blur` cierra la lista y el `click` no llega a la opción.
                event.preventDefault();
                elegir(item.id);
              }}
              onMouseEnter={() => setHighlighted(index)}
              className={`cursor-pointer px-3 py-2 text-sm ${
                highlighted === index ? "bg-surface text-foreground" : "text-muted"
              }`}
            >
              {item.name}
            </li>
          ))}

          {items.length === 1 ? (
            <li className="px-3 py-2 text-sm text-muted">Ningún jugador coincide.</li>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
}
