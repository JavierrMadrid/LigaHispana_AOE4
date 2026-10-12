"use client";

import { Fragment, useEffect, useState } from "react";
import { countdownParts, countdownTarget } from "@/lib/format";

/**
 * Cuánto queda para el torneo, en la banda de cabecera de la portada.
 *
 * Cuenta una cosa u otra según el momento, y **el objetivo y la fase salen del
 * mismo cálculo** (`countdownTarget()`), no de dos comparaciones de fechas: antes
 * de empezar apunta al inicio del torneo («Quedan 3 días para que empiece el
 * torneo») y, ya en marcha, al cierre («Quedan 12 días para que termine el
 * torneo»). Cuando no hay nada que contar —torneo terminado, o ventana abierta
 * que ya arrancó— la función devuelve `null` y el contador no se pinta.
 *
 * El primer render usa `serverNow`, el instante en que el servidor pintó la
 * página, para que el HTML y la hidratación coincidan: llamar aquí a `new Date()`
 * daría un valor distinto en servidor y cliente y React lo marcaría como
 * desajuste. Ya montado, el contador salta a la hora real y se recalcula cada
 * minuto, que es la precisión que promete el texto ("min", nunca segundos).
 *
 * Pinta también su propia barra de separación, y no la pone quien lo monta: es el
 * elemento que se intercala en la banda entre el recuento de participantes y la
 * hora del refresco, así que cuando el contador desaparece —al pasar el minuto
 * del cierre, sin recargar— la barra se va con él en vez de quedarse suelta.
 */
export function TournamentCountdown({
  from,
  to,
  serverNow,
}: {
  /** Inicio de la ventana del torneo, en ISO. */
  from: string;
  /** Fin de la ventana del torneo, en ISO; `null` en una ventana abierta. */
  to: string | null;
  /** Instante en que el servidor pintó la página, en ISO. */
  serverNow: string;
}) {
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

  const target = countdownTarget({ from, to }, now);

  if (target === null) {
    return null;
  }

  const parts = countdownParts(target.target, now);

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
    <>
      <span aria-hidden="true" className="hidden h-4 w-px shrink-0 bg-line sm:block" />
      <p className="text-muted">
        {units[0].value === 1 ? "Queda" : "Quedan"}{" "}
        <time dateTime={target.target.toISOString()}>
          {units.map((unit, index) => (
            <Fragment key={unit.label}>
              {index > 0 ? (index === units.length - 1 ? " y " : ", ") : null}
              <span className="font-display tabular-nums text-foreground">{unit.value}</span>{" "}
              {unit.label}
            </Fragment>
          ))}
        </time>{" "}
        {target.phase === "before" ? "para que empiece el torneo" : "para que termine el torneo"}
      </p>
    </>
  );
}
