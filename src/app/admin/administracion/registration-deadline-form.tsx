"use client";

import Link from "next/link";
import { useActionState, useState, type ReactNode } from "react";
import { setRegistrationClosesAt, type AdminActionResult } from "@/app/admin/actions";
import { Callout } from "@/components/admin/callout";
import { SectionCard } from "@/components/admin/section";
import { StatusPill } from "@/components/admin/status-pill";
import type { RegistrationClosureReason } from "@/lib/registration-open";
import { StatusLine, TextField } from "./fields";

const initialState: AdminActionResult = { status: "idle", message: null };

/**
 * El motivo del estado, en una frase: la píldora dice si se admiten solicitudes y
 * esto, qué mando lo ha cerrado y qué lo reabre. Los tres textos nombran **qué
 * mando** manda —el interruptor o la fecha—, porque con el plazo cerrado la
 * pregunta que sigue es cómo reabrirlo, y no se reabre igual en los dos casos.
 */
const NOTICE: Record<RegistrationClosureReason, ReactNode> = {
  open: "El plazo está abierto; la fecha lo cerrará sola cuando llegue.",
  switch: (
    <>
      Cerrado por el interruptor manual. Se reabre en{" "}
      <Link
        href="/admin/administracion/inscripciones"
        className="text-accent underline underline-offset-4 transition-colors hover:text-accent-strong"
      >
        Inscripciones
      </Link>
      .
    </>
  ),
  deadline:
    "Cerrado porque la fecha de cierre ya ha pasado. El interruptor no lo reabre: hay que quitar la fecha o moverla.",
};

/**
 * La fecha de cierre **automático** de las inscripciones.
 *
 * Es la cara visible de `Setting["registration.closesAt"]`: pasada esa hora, el
 * plazo se cierra solo, sin que nadie toque el interruptor. El interruptor
 * (`RegistrationSwitch`) sigue siendo el mando **manual**, y por eso se explican
 * juntos aunque cada uno viva en su subpestaña: `Fechas` para la fecha e
 * `Inscripciones` para el interruptor. Son dos maneras de cerrar el mismo plazo.
 *
 * El campo es un `datetime-local`, como la ventana del torneo: **sin zona**, y lo
 * interpreta el servidor en `Europe/Madrid`. Lo que se manda vacío **quita** la
 * fecha, que es la única forma de reabrir después del cierre: con la fecha en el
 * pasado, encender el interruptor no abre nada.
 *
 * La píldora y el aviso salen del estado **efectivo**, no del interruptor
 * (`reason`), que es lo que decide la página. Si la lectura falla (`reason` nulo)
 * se dice y no se ofrece el campo: guardarlo vacío borraría un cierre vigente.
 */
export function RegistrationDeadlineForm({
  closesAt: initialClosesAt,
  reason,
}: {
  closesAt: string;
  reason: RegistrationClosureReason | null;
}) {
  const [state, formAction, pending] = useActionState(setRegistrationClosesAt, initialState);
  const [closesAt, setClosesAt] = useState(initialClosesAt);

  if (reason === null) {
    return (
      <SectionCard title="Plazo de inscripción">
        <Callout tone="warning" title="No se ha podido leer el plazo">
          La base de datos no ha respondido y sin la fecha guardada no se ofrece el
          campo: guardarlo vacío borraría un cierre vigente.
        </Callout>
      </SectionCard>
    );
  }

  const open = reason === "open";

  return (
    <form action={formAction}>
      <SectionCard
        title="Plazo de inscripción"
        actions={<StatusPill active={open}>{open ? "Abiertas" : "Cerradas"}</StatusPill>}
        footer={
          <div className="flex flex-wrap items-center gap-4">
            <button
              type="submit"
              disabled={pending}
              className="h-10 rounded-md bg-accent px-4 text-sm font-semibold text-accent-ink transition-colors hover:bg-accent-strong disabled:cursor-not-allowed disabled:opacity-60"
            >
              {pending ? "Guardando…" : "Guardar la fecha"}
            </button>
            <StatusLine state={state} pending={pending} />
          </div>
        }
      >
        <Callout tone={open ? "info" : "locked"}>{NOTICE[reason]}</Callout>

        <div className="mt-4 max-w-md">
          <TextField
            name="closesAt"
            label="Fecha de cierre (opcional)"
            type="datetime-local"
            value={closesAt}
            onChange={setClosesAt}
            hint="Al llegar, el plazo se cierra solo."
          />
        </div>
      </SectionCard>
    </form>
  );
}
