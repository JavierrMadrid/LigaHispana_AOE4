"use client";

import { useActionState, useEffect, useState } from "react";
import type { AdminActionResult } from "@/app/admin/actions";
import { FieldGrid } from "@/components/admin/field-grid";
import { SectionCard } from "@/components/admin/section";
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
 * Los datos de la edición: nombre, premio, retransmisión, objetos y marca.
 *
 * El formulario es una **foto completa**: se envían siempre los siete campos, y
 * un valor vacío es "no hay premio anunciado" o "el del sitio", nunca un "no lo
 * toco". Por eso los campos son controlados —un envío con error no puede borrar
 * lo escrito— y los dos interruptores llevan su valor en un campo oculto, como el
 * del plazo de inscripción.
 *
 * Dos tarjetas, un solo guardado: la marca y el premio por un lado, las reglas por
 * otro, que es como se piensa la edición al configurarla. El color de acento se
 * escribe a mano en `#rrggbb` y no con un selector de color: un selector no sabe
 * expresar "vacío", que es justo "usa el color del sitio".
 */
export function EditionForm({ edition, nameMaxLength, noteMaxLength }: EditionFormProps) {
  const [state, formAction, pending] = useActionState(saveEditionConfig, initialState);

  const [name, setName] = useState(edition.name);
  const [prizeAmount, setPrizeAmount] = useState(
    edition.prize.amount === null ? "" : String(edition.prize.amount),
  );
  const [prizeNote, setPrizeNote] = useState(edition.prize.note ?? "");
  const [streamingRequired, setStreamingRequired] = useState(edition.streamingRequired);
  const [objectsEnabled, setObjectsEnabled] = useState(edition.objectsEnabled);
  const [emblemUrl, setEmblemUrl] = useState(edition.branding.emblemUrl ?? "");
  const [accentColor, setAccentColor] = useState(edition.branding.accentColor ?? "");

  // React resetea los campos cuando una Server Action termina: los controlados vuelven
  // al valor con el que se montaron y, como el estado del cliente no cambia, ningún
  // render los devuelve a su sitio —hasta recargar se ve lo anterior a lo que se acaba
  // de guardar—. Adoptar lo que manda el servidor es ese render: el estado no deriva de
  // otro estado, es el mismo dato del servidor, y por eso se silencia la regla.
  //
  // Un envío con error se salta el efecto a propósito: la configuración que vuelve es
  // la anterior y adoptarla borraría justo el formulario que hay que corregir.
  useEffect(() => {
    if (state.status === "error") {
      return;
    }

    // eslint-disable-next-line react-hooks/set-state-in-effect -- reaplica al DOM la configuración que el servidor acaba de guardar
    setName(edition.name);
    setPrizeAmount(edition.prize.amount === null ? "" : String(edition.prize.amount));
    setPrizeNote(edition.prize.note ?? "");
    setStreamingRequired(edition.streamingRequired);
    setObjectsEnabled(edition.objectsEnabled);
    setEmblemUrl(edition.branding.emblemUrl ?? "");
    setAccentColor(edition.branding.accentColor ?? "");
  }, [edition, state.status]);

  return (
    <form action={formAction} className="flex flex-col gap-6">
      <SectionCard title="Identidad y premio">
        <div>
          <h4 className="text-sm font-medium text-foreground">Marca</h4>
          <FieldGrid className="mt-3">
            <TextField
              name="name"
              label="Nombre de la edición"
              value={name}
              onChange={setName}
              maxLength={nameMaxLength}
              hint="Se ve en la cabecera del sitio y en el título de las pestañas."
              required
              className="sm:col-span-2"
            />

            <TextField
              name="emblemUrl"
              label="Emblema (opcional)"
              value={emblemUrl}
              onChange={setEmblemUrl}
              placeholder="https://… o /ediciones/2026/emblema.png"
              hint="http(s) o una ruta del sitio que empiece por /; vacío usa el emblema de la casa."
              className="sm:col-span-2"
            />

            <TextField
              name="accentColor"
              label="Color de acento (opcional)"
              value={accentColor}
              onChange={setAccentColor}
              placeholder="#e2b714"
              hint="En #rrggbb; vacío usa el oro del sitio."
            />
          </FieldGrid>
        </div>

        <div className="mt-5 border-t border-line pt-5">
          <h4 className="text-sm font-medium text-foreground">Premio</h4>
          <FieldGrid className="mt-3">
            <TextField
              name="prizeAmount"
              label="Premio base (euros)"
              type="number"
              min={0}
              step={1}
              value={prizeAmount}
              onChange={setPrizeAmount}
              placeholder="0"
              hint="Entero de euros. Vacío si no hay premio anunciado."
            />

            <TextField
              name="prizeNote"
              label="Nota del premio (opcional)"
              value={prizeNote}
              onChange={setPrizeNote}
              maxLength={noteMaxLength}
              hint="Una aclaración corta del reparto o las condiciones."
            />
          </FieldGrid>
        </div>
      </SectionCard>

      <SectionCard title="Reglas de participación">
        <div className="flex flex-col gap-3">
          <SwitchField
            name="streamingRequired"
            label="Retransmisión obligatoria"
            hint="Avisa de los participantes aprobados sin ningún canal de directo."
            checked={streamingRequired}
            onChange={setStreamingRequired}
          />

          <SwitchField
            name="objectsEnabled"
            label="Objetos utilizables"
            hint="Al apagarlo se desbloquean las partidas excluidas y se cierran los pendientes."
            checked={objectsEnabled}
            onChange={setObjectsEnabled}
          />
        </div>
      </SectionCard>

      <div className="flex flex-wrap items-center gap-4 border-t border-line pt-4">
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
