"use client";

import { Fragment, useEffect, useState } from "react";
import { countdownParts } from "@/lib/format";

/**
 * Cuánto queda de torneo, en la banda de cabecera de la portada.
 *
 * El primer render usa `serverNow`, el instante en que el servidor pintó la
 * página, para que el HTML y la hidratación coincidan: llamar aquí a `new Date()`
 * daría un valor distinto en servidor y cliente y React lo marcaría como
 * desajuste. Ya montado, el contador salta a la hora real y se recalcula cada
 * minuto, que es la precisión que promete el texto ("min", nunca segundos).
 *
 * `to` llega como ISO desde el servidor y quien no tiene ventana no monta el
 * componente. `countdownParts()` devuelve `null` cuando el torneo ya terminó, y
 * entonces el contador desaparece en vez de quedarse a cero.
 */
export function TournamentCountdown({ to, serverNow }: { to: string; serverNow: string }) {
  const [now, setNow] = useState(() => new Date(serverNow));

  useEffect(() => {
    const update = () => setNow(new Date());
    // Primer ajuste al minuto en punto y de ahí en adelante cada minuto: los
    // límites de la ventana caen en medianoche UTC, así que la cifra cambia en
    // el segundo :00 y conviene leerla en el minuto que toca, no con retraso.
    const untilNextMinute = 60_000 - (Date.now() % 60_000);
    let timer: ReturnType<typeof setInterval> | undefined;

    const start = setTimeout(() => {
      update();
      timer = setInterval(update, 60_000);
    }, untilNextMinute);

    return () => {
      clearTimeout(start);
      if (timer !== undefined) {
        clearInterval(timer);
      }
    };
  }, []);

  const parts = countdownParts(new Date(to), now);

  if (parts === null) {
    return null;
  }

  const units: { value: number; label: string }[] = [];

  if (parts.days > 0) {
    units.push({ value: parts.days, label: parts.days === 1 ? "día" : "días" });
  }

  if (parts.hours > 0) {
    units.push({ value: parts.hours, label: "h" });
  }

  // Si no queda ni un día ni una hora, se enseña el minuto aunque sea cero: el
  // torneo está a punto de cerrar y callar la última cifra sería engañoso.
  if (parts.minutes > 0 || units.length === 0) {
    units.push({ value: parts.minutes, label: "min" });
  }

  return (
    <p className="text-muted">
      {units[0].value === 1 ? "Queda" : "Quedan"}{" "}
      <time dateTime={to}>
        {units.map((unit, index) => (
          <Fragment key={unit.label}>
            {index > 0 ? (index === units.length - 1 ? " y " : ", ") : null}
            <span className="font-display tabular-nums text-foreground">{unit.value}</span>{" "}
            {unit.label}
          </Fragment>
        ))}
      </time>
    </p>
  );
}
