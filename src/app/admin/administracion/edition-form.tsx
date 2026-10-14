"use client";

import { useActionState, useState } from "react";
import type { AdminActionResult } from "@/app/admin/actions";
import type { EditionConfig } from "@/lib/edition";
import { saveEditionConfig } from "./actions";
import { StatusLine, TextField } from "./fields";
import { SwitchField } from "./switch-field";

const initialState: AdminActionResult = { status: "idle", message: null };

type EditionFormProps = {
  edition: EditionConfig;
  /** Topes del documento, pasados desde el servidor para no importar el módulo. */
  nameMaxLength: number;
  noteMaxLength: number;
};

/**
 * Los datos de la edición: nombre, premio, retransmisión y marca.
 *
 * El formulario es una **foto completa**: se envían siempre los seis campos, y
 * un valor vacío es "no hay premio anunciado" o "el del sitio", nunca un "no lo
 * toco". Por eso los campos son controlados —un envío con error no puede borrar
 * lo escrito— y el interruptor lleva su valor en un campo oculto, como el del
 * plazo de inscripción.
 *
 * El color de acento se escribe a mano en `#rrggbb` y no con un selector de
 * color: un selector no sabe expresar "vacío", que es justo "usa el color del
 * sitio".
 */
export function EditionForm({ edition, nameMaxLength, noteMaxLength }: EditionFormProps) {
  const [state, formAction, pending] = useActionState(saveEditionConfig, initialState);

  const [name, setName] = useState(edition.name);
  const [prizeAmount, setPrizeAmount] = useState(
    edition.prize.amount === null ? "" : String(edition.prize.amount),
  );
  const [prizeNote, setPrizeNote] = useState(edition.prize.note ?? "");
  const [streamingRequired, setStreamingRequired] = useState(edition.streamingRequired);
  const [emblemUrl, setEmblemUrl] = useState(edition.branding.emblemUrl ?? "");
  const [accentColor, setAccentColor] = useState(edition.branding.accentColor ?? "");

  return (
    <form action={formAction} className="rounded-lg border border-line bg-surface p-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          name="name"
          label="Nombre de la edición"
          value={name}
          onChange={setName}
          maxLength={nameMaxLength}
          hint="Se enseña en la cabecera del sitio y en el título de las pestañas."
          required
          className="sm:col-span-2"
        />

        <TextField
          name="prizeAmount"
          label="Premio base (euros)"
          type="number"
          min={0}
          step={1}
          value={prizeAmount}
          onChange={setPrizeAmount}
          placeholder="0"
          hint="Un número entero de euros. Déjalo vacío si no hay premio anunciado."
        />

        <TextField
          name="prizeNote"
          label="Nota del premio (opcional)"
          value={prizeNote}
          onChange={setPrizeNote}
          maxLength={noteMaxLength}
          hint="Una aclaración corta: el reparto, las condiciones. Solo tiene sentido con importe."
        />

        <TextField
          name="emblemUrl"
          label="Emblema (opcional)"
          value={emblemUrl}
          onChange={setEmblemUrl}
          placeholder="https://… o /ediciones/2026/emblema.png"
          hint="Una dirección http(s) o una ruta del propio sitio que empiece por /. Vacío para usar el emblema de la casa."
          className="sm:col-span-2"
        />

        <TextField
          name="accentColor"
          label="Color de acento (opcional)"
          value={accentColor}
          onChange={setAccentColor}
          placeholder="#e2b714"
          hint="En formato #rrggbb. Vacío para usar el oro del sitio. El texto que va encima del acento se ajusta solo, pero conviene un tono claro: el sitio es oscuro y el acento también se usa como texto."
        />
      </div>

      <div className="mt-4">
        <SwitchField
          name="streamingRequired"
          label="Retransmisión obligatoria"
          hint="Con esto encendido, el motor de alertas avisa de los participantes aprobados que no tienen ningún canal de directo."
          checked={streamingRequired}
          onChange={setStreamingRequired}
        />
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-4">
        <button
          type="submit"
          disabled={pending}
          className="h-10 rounded-md bg-accent px-4 text-sm font-semibold text-accent-ink transition-colors hover:bg-accent-strong disabled:cursor-not-allowed disabled:opacity-60"
        >
          {pending ? "Guardando…" : "Guardar la edición"}
        </button>
        <StatusLine state={state} pending={pending} />
      </div>
    </form>
  );
}
