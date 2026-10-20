"use client";

import { useEffect, useRef, useState } from "react";
import { CaretDown } from "@phosphor-icons/react/dist/csr/CaretDown";
import { SlidersHorizontal } from "@phosphor-icons/react/dist/csr/SlidersHorizontal";
import { DIVISION_UI, DivisionIcon } from "@/components/division-icon";
import { LeagueIcon, rankLevelToLeague } from "@/components/league-icon";
import type { DivisionId } from "@/lib/public";

const prefixes: Record<DivisionId, string> = {
  bronce: "bronze",
  plata: "silver",
  oro: "gold",
  platino: "platinum",
  diamante: "diamond",
  conquistador: "conqueror",
};
const options = [
  { id: "" as DivisionId | "", label: "Todas las divisiones" },
  ...DIVISION_UI,
];

export function HomeDivisionArtwork({
  division,
}: {
  division: DivisionId | "";
}) {
  if (!division) return <SlidersHorizontal size={20} aria-hidden="true" />;
  const rank = rankLevelToLeague(`${prefixes[division]}_3`);
  return rank ? (
    <LeagueIcon rank={rank} className="home-filter-division-icon" />
  ) : (
    <DivisionIcon division={division} className="home-filter-division-icon" />
  );
}

export function HomeDivisionFilter({
  value,
  onChange,
}: {
  value: DivisionId | "";
  onChange: (value: DivisionId | "") => void;
}) {
  const [open, setOpen] = useState(false);
  const selectedIndex = options.findIndex((option) => option.id === value);
  const [active, setActive] = useState(0);
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const items = useRef<(HTMLButtonElement | null)[]>([]);
  useEffect(() => {
    if (!open) return;
    items.current[active]?.focus();
  }, [open, active]);
  useEffect(() => {
    function outside(event: PointerEvent) {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, []);
  function choose(index: number) {
    onChange(options[index].id);
    setOpen(false);
    trigger.current?.focus();
  }
  return (
    <div
      className="home-field home-division-filter"
      ref={container}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null))
          setOpen(false);
      }}
    >
      <span className="home-field-label" id="home-division-label">
        División
      </span>
      <button
        ref={trigger}
        type="button"
        className="home-division-trigger"
        role="combobox"
        aria-labelledby="home-division-label home-division-value"
        aria-controls="home-division-list"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => {
          setActive(selectedIndex);
          setOpen(!open);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setActive(selectedIndex);
            setOpen(true);
          }
        }}
      >
        <span className="home-filter-icon-slot">
          <HomeDivisionArtwork division={value} />
        </span>
        <span id="home-division-value">{options[selectedIndex].label}</span>
        <CaretDown size={16} aria-hidden="true" />
      </button>
      {open ? (
        <div
          id="home-division-list"
          className="home-division-list"
          role="listbox"
          aria-labelledby="home-division-label"
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              setActive(
                (index) =>
                  (index +
                    (event.key === "ArrowDown" ? 1 : -1) +
                    options.length) %
                  options.length
              );
            } else if (event.key === "Home" || event.key === "End") {
              event.preventDefault();
              setActive(event.key === "Home" ? 0 : options.length - 1);
            } else if (event.key === "Escape") {
              event.preventDefault();
              setOpen(false);
              trigger.current?.focus();
            } else if (
              event.key.length === 1 &&
              /^[a-záéíóúñ]$/i.test(event.key)
            ) {
              const match = options.findIndex((option) =>
                option.label
                  .toLocaleLowerCase("es")
                  .startsWith(event.key.toLocaleLowerCase("es"))
              );
              if (match >= 0) setActive(match);
            }
          }}
        >
          {options.map((option, index) => (
            <button
              key={option.id || "all"}
              ref={(node) => {
                items.current[index] = node;
              }}
              type="button"
              role="option"
              aria-selected={value === option.id}
              tabIndex={active === index ? 0 : -1}
              onClick={() => choose(index)}
              className="home-division-option"
            >
              <span className="home-filter-icon-slot">
                <HomeDivisionArtwork division={option.id} />
              </span>
              <span>{option.label}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
