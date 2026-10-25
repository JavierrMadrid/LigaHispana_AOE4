"use client";

import { useActionState, useId, useState, useTransition } from "react";
import {
  approvePlayerWithoutVerification,
  resendPlayerVerification,
  updatePlayer,
  type AdminActionResult,
  type PlayerFormState,
} from "./actions";
import { CONTACT_EMAIL_MAX_LENGTH, DISCORD_USERNAME_FIELD_MAX_LENGTH } from "@/lib/player-input";
import type { AdminParticipant } from "@/lib/admin";
import { useActionFeedback } from "@/components/action-feedback";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Modal } from "@/components/modal";
import { formatMadridDateTime } from "@/lib/format";
import {
  VerificationBadge,
  canApproveWithoutVerification,
  canResendVerification,
  describeVerification,
  verificationFacts,
} from "./participant-verification";

const initialState: PlayerFormState = { error: null, message: null };

/** Lo que se dice si una acción de verificación falla sin mensaje propio. */
const GENERIC_ERROR = "No se ha podido completar la acción.";

const VERIFICATION_RESEND_CLASS =
  "h-10 whitespace-nowrap rounded-md border border-accent/40 px-3 text-xs text-accent transition-colors hover:bg-accent/10 disabled:cursor-not-allowed disabled:opacity-60";

const VERIFICATION_SKIP_CLASS =
  "h-10 whitespace-nowrap rounded-md border border-line-strong px-3 text-xs text-muted transition-colors hover:bg-surface-raised hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60";

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
 *
 * ## La verificación del alta (issue 119)
 *
 * El diálogo es donde el estado de la verificación se lee entero: las fechas del
 * privado, de la confirmación y del rechazo, más las dos acciones que caben cuando
 * la fila sigue esperando («Reenviar verificación» y, para el superadministrador,
 * «Aprobar sin verificación»).
 *
 * Esa sección va **fuera** del `<form>` de edición, y no es un detalle de estilo:
 * un formulario dentro de otro no es HTML válido y el navegador desarma el de
 * fuera al enviar el de dentro. Sus botones no envían nada por sí mismos: arman un
 * `FormData` con el `playerId` y llaman a la acción dentro de una transición, que
 * es lo que da el `disabled` mientras viaja.
 */
export function PlayerEditDialog({
  player,
  countries,
  canReverse = false,
}: {
  player: AdminParticipant;
  countries: string[];
  /** `getAdminAccess() === "superadmin"`: habilita «Aprobar sin verificación». */
  canReverse?: boolean;
}) {
  const report = useActionFeedback();
  const titleId = useId();
  const [open, setOpen] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [fields, setFields] = useState<EditFields>(() => fieldsFrom(player));
  const [feedback, setFeedback] = useState<PlayerFormState>(initialState);
  const [verificationBusy, startVerification] = useTransition();
  const [confirmSkip, setConfirmSkip] = useState(false);
  const [verificationFeedback, setVerificationFeedback] = useState<{
    tone: "success" | "error";
    message: string;
  } | null>(null);

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
    setVerificationFeedback(null);
    setConfirmSkip(false);
    setOpen(true);
  }

  function setField(key: keyof EditFields, value: string) {
    setFields((current) => ({ ...current, [key]: value }));
  }

  // `Esc`, clic en el fondo y la X pasan por aquí: si hay cambios sin guardar,
  // se pide confirmación en vez de descartarlos en silencio.
  function requestClose() {
    if (pending || verificationBusy) {
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
   * Las dos acciones de la verificación, sin `<form>` propio.
   *
   * El resultado se pinta donde se está mirando: reenviar **no** cierra el
   * diálogo —la fila sigue pendiente—, así que su mensaje se queda en la sección;
   * aprobar sin verificación sí lo cierra, y entonces el aviso viaja a la banda,
   * que es la que sobrevive al cierre.
   */
  function runVerification(kind: "resend" | "approve-without") {
    const formData = new FormData();
    formData.set("playerId", player.id);

    startVerification(async () => {
      const result: AdminActionResult =
        kind === "resend"
          ? await resendPlayerVerification(formData)
          : await approvePlayerWithoutVerification(formData);

      if (result.status === "error") {
        setVerificationFeedback({
          tone: "error",
          message: result.message ?? GENERIC_ERROR,
        });

        return;
      }

      if (kind === "approve-without") {
        setOpen(false);
        setConfirmDiscard(false);

        if (result.message !== null) {
          report({ tone: "success", message: result.message });
        }

        return;
      }

      setVerificationFeedback({
        tone: "success",
        message: result.message ?? `Se ha reenviado el privado a ${player.name}.`,
      });
    });
  }

  const verification = describeVerification(player);
  const verificationEvents = verificationFacts(player);
  const canResend = canResendVerification(player);
  const canSkip = canApproveWithoutVerification(player, canReverse);

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
        closeDisabled={pending || verificationBusy}
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

          {/* El estado de la verificación va arriba, no al pie: es lo que se
              consulta antes de tocar los campos, y los botones del formulario se
              quedan al final, que es donde se busca «Guardar». Los botones de esta
              sección viven **fuera** del `<form>` de edición a propósito: dos
              formularios anidados no son HTML válido y el navegador desarma el de
              fuera al enviar el de dentro. No envían nada: llaman a la acción desde
              una transición, con el `playerId` en un `FormData` armado a mano. */}
          <section
            aria-labelledby={`${titleId}-verification`}
            className="mt-4 rounded-md border border-line bg-background px-3 py-3"
          >
            <h3
              id={`${titleId}-verification`}
              className="text-sm font-medium text-foreground"
            >
              Verificación de Discord
            </h3>

            <div className="mt-1.5 flex flex-wrap items-baseline gap-2">
              {verification !== null ? (
                <>
                  <VerificationBadge player={player} />
                  <p className="text-xs leading-relaxed text-muted">{verification.hint}</p>
                </>
              ) : player.discordVerifiedAt !== null ? (
                /* Alta de `/participar`: la cuenta se verificó en el paso de OAuth de
                   la inscripción, no en el privado de confirmación del alta, que solo
                   existe para las altas de la organización. */
                <p className="text-xs leading-relaxed text-muted">
                  La cuenta se verificó al inscribirse con Discord. Esta ficha no está
                  sujeta al privado de confirmación del alta, así que no hay nada que
                  reenviar.
                </p>
              ) : (
                <p className="text-xs leading-relaxed text-muted">
                  Sin verificación: esta ficha no está sujeta al privado de confirmación.
                </p>
              )}
            </div>

            {verificationEvents.length > 0 ? (
              <dl className="mt-2.5 flex flex-col gap-1 text-xs">
                {verificationEvents.map((fact) => (
                  <div key={fact.key} className="flex flex-wrap gap-x-1.5">
                    <dt className="text-muted">{fact.label}:</dt>
                    <dd className="text-foreground">{formatMadridDateTime(fact.at)}</dd>
                  </div>
                ))}
              </dl>
            ) : null}

            {canResend || canSkip ? (
              <div className="mt-3 flex flex-wrap items-center gap-2">
                {canResend ? (
                  <button
                    type="button"
                    disabled={verificationBusy}
                    onClick={() => runVerification("resend")}
                    className={VERIFICATION_RESEND_CLASS}
                  >
                    {player.discordVerificationSentAt === null
                      ? "Enviar verificación"
                      : "Reenviar verificación"}
                  </button>
                ) : null}

                {canSkip && !confirmSkip ? (
                  <button
                    type="button"
                    disabled={verificationBusy}
                    onClick={() => {
                      setConfirmSkip(true);
                      setVerificationFeedback(null);
                    }}
                    className={VERIFICATION_SKIP_CLASS}
                  >
                    Aprobar sin verificación
                  </button>
                ) : null}
              </div>
            ) : null}

            {/* La confirmación de la renuncia se despliega aquí y no en otra capa:
                un diálogo dentro de otro diálogo rompe la trampa de foco y el `Esc`
                de la capa nativa. */}
            {confirmSkip ? (
              <div className="mt-3 rounded-md border border-accent/40 bg-accent/5 px-3 py-3">
                <p className="text-xs leading-relaxed text-muted">
                  El alta de {player.name} quedará aprobada sin que la persona haya
                  confirmado por privado, y entrará en la clasificación en la próxima
                  pasada del sincronizador. Queda registrado en el historial como
                  «Aprobación sin verificación».
                </p>
                <div className="mt-2.5 flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={verificationBusy}
                    onClick={() => runVerification("approve-without")}
                    className="h-10 rounded-md bg-accent px-3 text-xs font-semibold text-accent-ink transition-colors hover:bg-accent-strong disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    Aprobar sin verificación
                  </button>
                  <button
                    type="button"
                    disabled={verificationBusy}
                    onClick={() => setConfirmSkip(false)}
                    className="h-10 rounded-md border border-line px-3 text-xs text-foreground transition-colors hover:border-line-strong disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    Cancelar
                  </button>
                </div>
              </div>
            ) : null}

            {verificationFeedback !== null ? (
              <p
                role={verificationFeedback.tone === "error" ? "alert" : "status"}
                className={`mt-3 rounded-md border px-3 py-2 text-xs leading-relaxed ${
                  verificationFeedback.tone === "error"
                    ? "border-loss/40 bg-loss/5 text-loss"
                    : "border-accent/40 bg-accent/5 text-foreground"
                }`}
              >
                {verificationFeedback.message}
              </p>
            ) : null}
          </section>

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
