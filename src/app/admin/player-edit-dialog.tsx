"use client";

import { useActionState, useId, useState } from "react";
import { updatePlayer, type PlayerFormState } from "./actions";
import { CONTACT_EMAIL_MAX_LENGTH, DISCORD_USERNAME_FIELD_MAX_LENGTH } from "@/lib/player-input";
import type { AdminParticipant } from "@/lib/admin";
import { useActionFeedback } from "@/components/action-feedback";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Modal } from "@/components/modal";

const initialState: PlayerFormState = { error: null, message: null };

/** Los siete campos que `updatePlayer` reescribe, ya como texto de formulario. */
type EditFields = {
  name: string;
  contactEmail: string;
  discordUsername: string;
  twitchChannel: string;
  youtubeChannel: string;
  kickChannel: string;
  country: string;
};

function fieldsFrom(player: AdminParticipant): EditFields {
  return {
    name: player.name,
    contactEmail: player.contactEmail ?? "",
    // `discordUsername` se guarda sin arroba; el campo se pinta y se envía con ella,
    // que es como lo escribe una persona y como lo valida el servidor. En una ficha
    // anterior a F12 (`null`) queda solo la arroba, y hay que completarlo para
    // guardar: la pista del campo lo dice.
    discordUsername: `@${player.discordUsername ?? ""}`,
    twitchChannel: player.twitchChannel ?? "",
    youtubeChannel: player.youtubeChannel ?? "",
    kickChannel: player.kickChannel ?? "",
    country: player.country ?? "",
  };
}

function fieldsDiffer(a: EditFields, b: EditFields): boolean {
  return (
    a.name !== b.name ||
    a.contactEmail !== b.contactEmail ||
    a.discordUsername !== b.discordUsername ||
    a.twitchChannel !== b.twitchChannel ||
    a.youtubeChannel !== b.youtubeChannel ||
    a.kickChannel !== b.kickChannel ||
    a.country !== b.country
  );
}

/**
 * Botón "Editar" de la columna de acciones y su formulario.
 *
 * Escribe un formulario propio y no reutiliza `player-form.tsx`, que es el alta:
 * aunque comparten siete campos, el alta pide además el `profileId` y el estado,
 * llama a `createPlayer` y el servidor puede tardar segundos trayendo partidas.
 * Aquí el `profileId` y el estado no se tocan (el estado tiene su propio
 * aprobar/rechazar) y lo único que se manda es una foto de los siete campos. Se
 * copia el dialecto de los campos del alta (mismas clases, mismas pistas) en vez
 * de extraer un formulario genérico: parametrizar el alta obligaría a tocar un
 * componente estable fuera de este encargo para ganar unas pocas líneas.
 *
 * Los campos son **controlados** a propósito. React resetea los formularios de
 * una Server Action al enviarlos, así que con campos no controlados un error de
 * validación llegaría con lo escrito ya borrado; manteniendo el valor en estado
 * de React, el error se pinta **sin perder lo que se estaba escribiendo**.
 *
 * Al cerrar, si hay algo escrito se pide confirmación con `ConfirmDialog`, el
 * mismo que usan las acciones destructivas del panel. La mecánica de la capa
 * —foco, `Esc`, clic en el fondo y scroll bloqueado— es la de `Modal`.
 */
export function PlayerEditDialog({
  player,
  countries,
}: {
  player: AdminParticipant;
  countries: string[];
}) {
  const report = useActionFeedback();
  const titleId = useId();
  const [open, setOpen] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [fields, setFields] = useState<EditFields>(() => fieldsFrom(player));
  const [feedback, setFeedback] = useState<PlayerFormState>(initialState);

  const [, formAction, pending] = useActionState(runAction, initialState);

  async function runAction(
    previous: PlayerFormState,
    formData: FormData,
  ): Promise<PlayerFormState> {
    const result = await updatePlayer(previous, formData);

    if (result.error !== null) {
      // El error se queda dentro del diálogo, junto a los campos que hay que
      // corregir. `state` de `useActionState` no se pinta: se copia aquí para
      // poder limpiarlo al abrir de nuevo y no arrastrar el fallo anterior.
      setFeedback(result);
    } else {
      setOpen(false);
      setConfirmDiscard(false);

      if (result.message !== null) {
        report({ tone: "success", message: result.message });
      }
    }

    return result;
  }

  const dirty = fieldsDiffer(fields, fieldsFrom(player));

  function openDialog() {
    setFields(fieldsFrom(player));
    setFeedback(initialState);
    setOpen(true);
  }

  function setField(key: keyof EditFields, value: string) {
    setFields((current) => ({ ...current, [key]: value }));
  }

  // `Esc`, clic en el fondo y la X pasan por aquí: si hay cambios sin guardar,
  // se pide confirmación en vez de descartarlos en silencio.
  function requestClose() {
    if (pending) {
      return;
    }

    if (dirty) {
      setConfirmDiscard(true);
      return;
    }

    setOpen(false);
  }

  function discardChanges() {
    setConfirmDiscard(false);
    setOpen(false);
  }

  /**
   * Países del desplegable. Son los de la lista viva más, si hace falta, el que
   * ya tiene el jugador aunque la organización lo haya retirado: sin ese último,
   * el desplegable no podría mostrar su valor y guardar sin tocarlo lo borraría
   * en silencio. Al enviarlo, la acción lo rechaza con su propio mensaje.
   */
  const countryOptions = countries.map((country) => ({ value: country, label: country }));

  if (player.country !== null && !countries.includes(player.country)) {
    countryOptions.push({
      value: player.country,
      label: `${player.country} (ya no admitido)`,
    });
  }

  return (
    <>
      <button
        type="button"
        onClick={openDialog}
        className="h-10 whitespace-nowrap rounded-md border border-line px-3 text-xs text-muted transition-colors hover:bg-surface-raised hover:text-foreground"
      >
        Editar
      </button>

      <Modal
        open={open}
        onClose={requestClose}
        closeDisabled={pending}
        labelledBy={titleId}
        closeLabel="Cerrar la edición"
        className="m-auto max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-lg overflow-y-auto rounded-lg border border-line bg-surface p-0 text-foreground"
      >
        <div className="p-5">
          <h2 id={titleId} className="text-lg font-semibold text-foreground">
            Editar participante
          </h2>
          <p className="mt-1 text-sm text-muted">
            {player.name} · AoE4World {player.profileId}
          </p>

          <form action={formAction} className="mt-4 flex flex-col gap-4">
            <input type="hidden" name="playerId" value={player.id} />

            <TextField
              id={`${titleId}-name`}
              name="name"
              label="Nombre"
              value={fields.name}
              onChange={(value) => setField("name", value)}
              maxLength={64}
              required
              autoFocus
            />

            <TextField
              id={`${titleId}-email`}
              name="email"
              label="Correo de contacto (opcional)"
              hint="Solo para avisarle si hay dudas con su inscripción."
              placeholder="nombre@correo.com"
              type="email"
              autoComplete="email"
              value={fields.contactEmail}
              onChange={(value) => setField("contactEmail", value)}
              maxLength={CONTACT_EMAIL_MAX_LENGTH}
            />

            <TextField
              id={`${titleId}-discord`}
              name="discordUsername"
              label="Usuario de Discord"
              hint="Se escribe con la arroba, como @pepito: es el usuario global, el que la persona usa en todo Discord, no el nombre que tenga puesto dentro del servidor. Si esta ficha todavía no lo tiene, escríbelo para poder comprobar que está en el servidor."
              placeholder="@pepito"
              value={fields.discordUsername}
              onChange={(value) => setField("discordUsername", value)}
              maxLength={DISCORD_USERNAME_FIELD_MAX_LENGTH}
              required
            />

            <fieldset className="flex flex-col gap-4">
              <legend className="text-sm font-medium text-foreground">
                Canales de directo
              </legend>

              <TextField
                id={`${titleId}-twitch`}
                name="twitchChannel"
                label="Twitch (opcional)"
                hint="Solo el nombre del canal, sin la arroba."
                placeholder="tu_canal"
                value={fields.twitchChannel}
                onChange={(value) => setField("twitchChannel", value)}
                maxLength={25}
              />

              <TextField
                id={`${titleId}-youtube`}
                name="youtubeChannel"
                label="YouTube (opcional)"
                hint="El @nombre de tu canal, como aparece en youtube.com/@nombre."
                placeholder="@tu_canal"
                value={fields.youtubeChannel}
                onChange={(value) => setField("youtubeChannel", value)}
                maxLength={100}
              />

              <TextField
                id={`${titleId}-kick`}
                name="kickChannel"
                label="Kick (opcional)"
                hint="El nombre de tu canal, tal cual está en kick.com/nombre."
                placeholder="tu_canal"
                value={fields.kickChannel}
                onChange={(value) => setField("kickChannel", value)}
                maxLength={100}
              />
            </fieldset>

            <SelectField
              id={`${titleId}-country`}
              name="country"
              label="País (opcional)"
              value={fields.country}
              onChange={(value) => setField("country", value)}
              emptyLabel="Sin especificar"
              options={countryOptions}
            />

            {feedback.error !== null ? (
              <p
                role="alert"
                className="rounded-md border border-loss/40 bg-loss/5 px-3 py-2 text-sm leading-relaxed text-loss"
              >
                {feedback.error}
              </p>
            ) : null}

            <div className="flex flex-wrap justify-end gap-2">
              <button
                type="button"
                disabled={pending}
                onClick={requestClose}
                className="h-10 rounded-md border border-line px-3 text-sm text-foreground transition-colors hover:border-line-strong disabled:cursor-not-allowed disabled:opacity-60"
              >
                Cancelar
              </button>
              <button
                type="submit"
                disabled={pending}
                className="h-10 rounded-md bg-accent px-4 text-sm font-semibold text-accent-ink transition-colors hover:bg-accent-strong disabled:cursor-not-allowed disabled:opacity-60"
              >
                {pending ? "Guardando…" : "Guardar cambios"}
              </button>
            </div>
          </form>
        </div>
      </Modal>

      <ConfirmDialog
        open={confirmDiscard}
        onClose={() => setConfirmDiscard(false)}
        title="Descartar los cambios"
        pending={false}
      >
        <p className="text-sm leading-relaxed text-muted">
          Has modificado datos de {player.name} sin guardarlos. Si cierras ahora, se
          perderán.
        </p>

        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button
            type="button"
            data-autofocus
            onClick={() => setConfirmDiscard(false)}
            className="h-10 rounded-md border border-line px-3 text-sm text-foreground transition-colors hover:border-line-strong"
          >
            Seguir editando
          </button>
          <button
            type="button"
            onClick={discardChanges}
            className="h-10 rounded-md bg-loss px-4 text-sm font-semibold text-accent-ink transition-colors hover:brightness-110"
          >
            Descartar
          </button>
        </div>
      </ConfirmDialog>
    </>
  );
}

type TextFieldProps = {
  id: string;
  name: string;
  label: string;
  hint?: string;
  placeholder?: string;
  value: string;
  onChange: (value: string) => void;
  maxLength?: number;
  required?: boolean;
  autoFocus?: boolean;
  /** Tipo del `input`; por defecto texto, como el resto de campos del panel. */
  type?: "text" | "email";
  /** `autoComplete` del `input`; por defecto apagado, como el resto de campos. */
  autoComplete?: string;
};

function TextField({
  id,
  name,
  label,
  hint,
  placeholder,
  value,
  onChange,
  maxLength,
  required,
  autoFocus,
  type = "text",
  autoComplete = "off",
}: TextFieldProps) {
  const hintId = hint !== undefined ? `${id}-hint` : undefined;

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm text-muted">
        {label}
      </label>
      <input
        id={id}
        name={name}
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        maxLength={maxLength}
        required={required}
        data-autofocus={autoFocus ? true : undefined}
        aria-describedby={hintId}
        autoComplete={autoComplete}
        className="h-10 rounded-md border border-line bg-background px-3 text-foreground placeholder:text-muted"
      />
      {hint !== undefined ? (
        <p id={hintId} className="text-xs leading-relaxed text-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

type SelectFieldProps = {
  id: string;
  name: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  emptyLabel: string;
  options: { value: string; label: string }[];
};

function SelectField({
  id,
  name,
  label,
  value,
  onChange,
  emptyLabel,
  options,
}: SelectFieldProps) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm text-muted">
        {label}
      </label>
      <select
        id={id}
        name={name}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-10 rounded-md border border-line bg-background px-3 text-foreground"
      >
        <option value="">{emptyLabel}</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}
