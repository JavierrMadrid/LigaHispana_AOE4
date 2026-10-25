"use client";

import Link from "next/link";
import { useActionState, useId, useState } from "react";
import type { AdminActionResult } from "@/app/admin/actions";
import { StatusLine, TextareaField, TextField } from "@/app/admin/administracion/fields";
import { saveEditionEvent } from "./actions";

const initialState: AdminActionResult = { status: "idle", message: null };

/** Lo que el formulario necesita de un evento para editarlo, ya como texto. */
export type EventFormValues = {
  id: string;
  name: string;
  description: string;
  /** `datetime-local` de Madrid, sin zona; vacío al crear. */
  from: string;
  /** `datetime-local` de Madrid, sin zona; vacío al crear. */
  to: string;
  multiplier: string;
  discordRequired: boolean;
};

type EventFormProps = {
  /** El evento que se está editando, o `null` si el formulario crea uno nuevo. */
  event: EventFormValues | null;
  /** Topes de los documentos, pasados desde el servidor para no importar el módulo. */
  nameMaxLength: number;
  descriptionMaxLength: number;
  minMultiplier: number;
};

/**
 * Alta y edición de un evento puntual.
 *
 * Es **un solo formulario para las dos cosas**, y el `id` decide cuál: vacío al
 * crear —lo genera el servidor— o el del evento al editar. La pantalla monta la
 * misma pieza en los dos casos porque los campos son los mismos y separarlas
 * dejaría dos copias del dialecto de campo que se irían separando.
 *
 * Los campos son controlados para que un envío con error no borre lo escrito, que
 * es la razón de que el resto de formularios del panel también lo sean. Las fechas
 * llegan **prefilladas en hora de Madrid** desde el servidor (`formatMadridLocalInstant`),
 * así que el `datetime-local` enseña lo mismo que se guardó.
 *
 * La cancelación de la edición es un enlace a la ruta limpia y no un botón que
 * limpie el estado: el evento que se edita vive en la URL (`?editar=<id>`), y
 * dejarla apuntando a un evento que ya no se está editando haría que recargar la
 * página volviera a abrirlo.
 */
export function EventForm({
  event,
  nameMaxLength,
  descriptionMaxLength,
  minMultiplier,
}: EventFormProps) {
  const [state, formAction, pending] = useActionState(runAction, initialState);

  const [name, setName] = useState(event?.name ?? "");
  const [description, setDescription] = useState(event?.description ?? "");
  const [from, setFrom] = useState(event?.from ?? "");
  const [to, setTo] = useState(event?.to ?? "");
  const [multiplier, setMultiplier] = useState(event?.multiplier ?? String(minMultiplier));
  const [discordRequired, setDiscordRequired] = useState(event?.discordRequired ?? false);

  const editing = event !== null;

  /**
   * Envía el evento y, si el alta sale bien, deja el formulario en blanco.
   *
   * Al **crear**, los campos se vacían para que el siguiente evento no se escriba
   * encima de los valores del anterior ni se mande dos veces el mismo por inercia;
   * al **editar** se quedan como están, porque el formulario sigue describiendo el
   * evento que se acaba de guardar. Es el mismo sitio donde `ConfirmAction` cierra
   * su diálogo al terminar bien: dentro de la acción, no en un efecto que observe
   * el resultado.
   */
  async function runAction(
    previous: AdminActionResult,
    formData: FormData,
  ): Promise<AdminActionResult> {
    const result = await saveEditionEvent(previous, formData);

    if (result.status === "success" && event === null) {
      setName("");
      setDescription("");
      setFrom("");
      setTo("");
      setMultiplier(String(minMultiplier));
      setDiscordRequired(false);
    }

    return result;
  }

  return (
    <form action={formAction} className="rounded-lg border border-line bg-surface p-4">
      <input type="hidden" name="id" value={event?.id ?? ""} />

      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          name="name"
          label="Nombre del evento"
          value={name}
          onChange={setName}
          maxLength={nameMaxLength}
          placeholder="Noche de ranked"
          hint="Lo que se lee en el calendario y en el banner de la web."
          required
          className="sm:col-span-2"
        />

        <TextareaField
          name="description"
          label="Instrucciones (opcional)"
          value={description}
          onChange={setDescription}
          maxLength={descriptionMaxLength}
          placeholder="Qué hay que hacer para cobrar el multiplicador, si hay algo más que jugar."
          hint="Se publica tal cual en Reglas, junto a la ventana del evento."
          className="sm:col-span-2"
        />

        <TextField
          name="from"
          label="Inicio"
          type="datetime-local"
          value={from}
          onChange={setFrom}
          hint="Hora de Madrid. Una partida cuenta si empieza dentro de la ventana."
          required
        />

        <TextField
          name="to"
          label="Fin"
          type="datetime-local"
          value={to}
          onChange={setTo}
          hint="Hora de Madrid. El fin no entra: una partida que empieza justo ahí ya no lo cobra."
          required
        />

        <TextField
          name="multiplier"
          label="Multiplicador"
          type="number"
          min={minMultiplier}
          step={1}
          value={multiplier}
          onChange={setMultiplier}
          placeholder={String(minMultiplier)}
          hint={`Un entero de ${minMultiplier} en adelante. x2 paga el doble de los puntos por victoria; no toca las derrotas ni los objetivos.`}
          required
        />
      </div>

      <DiscordField
        checked={discordRequired}
        onChange={setDiscordRequired}
      />

      <div className="mt-4 flex flex-wrap items-center gap-4">
        <button
          type="submit"
          disabled={pending}
          className="h-10 rounded-md bg-accent px-4 text-sm font-semibold text-accent-ink transition-colors hover:bg-accent-strong disabled:cursor-not-allowed disabled:opacity-60"
        >
          {pending ? "Guardando…" : editing ? "Guardar los cambios" : "Crear el evento"}
        </button>

        {editing ? (
          <Link
            href="/admin/administracion/eventos"
            className="h-10 rounded-md border border-line px-3 text-sm leading-10 text-foreground transition-colors hover:border-line-strong"
          >
            Cancelar la edición
          </Link>
        ) : null}

        <StatusLine state={state} pending={pending} />
      </div>
    </form>
  );
}

/**
 * «Requiere Discord», la única condición de un evento.
 *
 * Es una casilla y no el interruptor del resto del panel porque aquí no se enciende
 * un ajuste del sitio: se marca una propiedad del documento que se está escribiendo,
 * y se envía con el formulario al guardar. Desmarcada no manda nada y la acción la
 * lee como apagada, que es el estado seguro.
 */
function DiscordField({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  const id = useId();
  const hintId = `${id}-hint`;

  return (
    <div className="mt-4 flex items-start gap-3 rounded-md border border-line bg-background px-3 py-3">
      <input
        id={id}
        name="discordRequired"
        type="checkbox"
        value="true"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        aria-describedby={hintId}
        className="mt-0.5 size-4 shrink-0 accent-accent"
      />
      <div className="flex min-w-0 flex-col gap-0.5">
        <label htmlFor={id} className="text-sm text-foreground">
          Requiere Discord
        </label>
        <p id={hintId} className="max-w-[70ch] text-xs leading-relaxed text-muted">
          Solo cobran el multiplicador quienes estén en el servidor de Discord del
          torneo. La lista se congela al empezar el evento; solo se añade a quien se
          apruebe durante el evento y cumpla el requisito.
        </p>
      </div>
    </div>
  );
}
