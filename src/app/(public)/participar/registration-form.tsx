"use client";

import type { ComponentPropsWithoutRef } from "react";
import { useActionState, useEffect, useId } from "react";
import Link from "next/link";
import type { DiscordStep } from "@/lib/discord/contract";
import { CONTACT_EMAIL_MAX_LENGTH } from "@/lib/player-input";
import { REGISTRATION_IS_CLOSED } from "@/lib/registration-open";
import { registerPlayer, type RegistrationFormState } from "./actions";
import { TurnstileWidget, resetTurnstileWidget } from "./turnstile-widget";

const initialState: RegistrationFormState = {
  status: "idle",
  message: null,
  fieldErrors: {},
};

/**
 * Site key pública del captcha. Se lee con el nombre literal y no con la
 * constante del contrato porque Next solo sustituye `process.env.NEXT_PUBLIC_*`
 * cuando el acceso es estático; con una clave calculada llegaría vacío al
 * navegador. Sin valor el formulario es el de siempre: no se pinta el widget y
 * el servidor tampoco comprueba nada.
 */
const turnstileSiteKey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY?.trim() ?? "";

/**
 * Formulario público de inscripción.
 *
 * Es cliente porque `useActionState` lleva el estado de la Server Action (error
 * general, error por campo y envío pendiente). Importar `registerPlayer` aquí es
 * lo que mantiene la acción viva en el build: sin esta referencia, Next la
 * eliminaría por no tener consumidores.
 *
 * Los tres momentos de la UI se cubren en el mismo componente: `idle` pinta el
 * formulario, `error` añade el bloque general y los avisos por campo, y `success`
 * sustituye el formulario entero por la confirmación, para no dejar a nadie con
 * los datos rellenos y sin respuesta. El contexto sobre qué se pide vive en las
 * pistas de cada campo, no en un bloque aparte que se quedaría colgando tras
 * enviar.
 *
 * Con el plazo cerrado (`REGISTRATION_IS_CLOSED`) el botón se desactiva y el
 * motivo se lee a su lado, enlazado con `aria-describedby`. El servidor lo
 * rechaza igualmente: esto es la cara visible del mismo flag, no la defensa.
 *
 * ## El paso de Discord (F12)
 *
 * Llega con `discord` (`DiscordStep`, el contrato de `src/lib/discord/contract.ts`)
 * y **no es un campo**: no hay `<input name="discord">` ni ningún `FormData` que lo
 * lleve. El botón es un enlace a `/api/discord/oauth`, Discord manda a la persona a su
 * pantalla de permisos y vuelve al callback, que deja la cookie firmada; la Server
 * Action la verifica y escribe `Player.discordUserId`. Ese camino es precisamente lo
 * que hace que `discordUserId` no se pueda escribir a mano.
 *
 * Con `discord.configured === false` (sin credenciales de Discord) **no se pinta
 * nada**: es la degradación que permite que el proyecto funcione sin configurar nada
 * nuevo. Con `linkedUsername` hay cuenta conectada y el error del campo `discord` ya
 * no puede salir.
 *
 * El dialecto visual del paso vive en `DiscordStepPanel`: un bloque con la misma
 * superficie y los mismos controles que los campos, que se marca con acento
 * mientras exige algo y se apaga a neutro cuando ya está resuelto. Aquí está el
 * funcionamiento y el contrato, que es lo que decide el servidor.
 */
export function RegistrationForm({
  countries,
  discord,
}: {
  countries: string[];
  discord: DiscordStep;
}) {
  const [state, formAction, pending] = useActionState(registerPlayer, initialState);

  // El token de Turnstile es de un solo uso: la Server Action lo canjea contra
  // Cloudflare antes de validar los campos, así que cualquier respuesta de error
  // lo deja gastado. Sin resetear aquí, el segundo intento fallaría siempre y el
  // formulario quedaría inservible hasta recargar.
  useEffect(() => {
    if (turnstileSiteKey !== "" && state.status === "error") {
      resetTurnstileWidget();
    }
  }, [state]);

  if (state.status === "success") {
    return <RegistrationConfirmation message={state.message} />;
  }

  const { fieldErrors } = state;

  return (
    <section className="mx-auto w-full max-w-2xl rounded-lg border border-line bg-surface p-6 sm:p-8">
      <h2 className="border-b border-line pb-3 font-display text-xl font-semibold text-foreground">
        Inscripción
      </h2>
      <p className="mt-4 max-w-[58ch] text-sm leading-relaxed text-muted">
        Necesitas el identificador de tu perfil de AoE4World. El país, el correo y
        el Discord son obligatorios; los canales de directo (Twitch, YouTube y
        Kick) son opcionales y solo sirven para señalar tu emisión cuando juegas
        partidas de la liga.
      </p>
      {/* Requisito de participación (F11): se explica aquí, no como un campo
          aparte. No hay casilla de confirmación a propósito: no se pide un
          compromiso, se informa de una condición para poder inscribirse. */}
      <p className="mt-3 max-w-[58ch] text-sm leading-relaxed text-muted">
        Tu perfil de AoE4World tiene que tener el historial de partidas en público.
        La organización lo consulta para poder revisar las partidas del torneo, así
        que es un requisito de participación. Está detallado en{" "}
        <Link
          href="/reglas#historial"
          className="text-accent underline underline-offset-4 hover:text-accent-strong"
        >
          las reglas
        </Link>
        .
      </p>

      {discord.configured ? (
        <DiscordStepPanel step={discord} error={fieldErrors.discord} />
      ) : null}

      <form action={formAction} className="mt-6 flex flex-col gap-5">
        {state.status === "error" && state.message ? (
          <p
            role="alert"
            className="rounded-md border border-red-500/40 bg-red-500/5 px-4 py-3 text-sm leading-relaxed text-red-300"
          >
            {state.message}
          </p>
        ) : null}

        <TextField
          id="profileId"
          name="profileId"
          label="Profile ID de AoE4World"
          hint="El número de tu perfil, visible en la URL de aoe4world.com/players."
          placeholder="1234567"
          inputMode="numeric"
          autoComplete="off"
          required
          error={fieldErrors.profileId}
        />

        <TextField
          id="name"
          name="name"
          label="Nombre de jugador"
          hint="El nombre con el que aparecerás en la clasificación. Hasta 64 caracteres."
          maxLength={64}
          autoComplete="off"
          required
          error={fieldErrors.name}
        />

        <TextField
          id="email"
          name="email"
          label="Correo de contacto"
          hint="Solo para avisarte si hay dudas con tu inscripción."
          placeholder="tu@correo.com"
          type="email"
          inputMode="email"
          autoComplete="email"
          maxLength={CONTACT_EMAIL_MAX_LENGTH}
          required
          error={fieldErrors.email}
        />

        {/* El país es obligatorio y se elige de la lista viva que admite el torneo
            (`Setting["registration.countries"]`), que llega resuelta del servidor: el
            desplegable y la validación del servidor no pueden ofrecer países distintos. */}
        <SelectField
          id="country"
          name="country"
          label="País"
          hint="El país con el que compites en el torneo."
          placeholder="Elige tu país"
          options={countries}
          required
          error={fieldErrors.country}
        />

        <TextField
          id="twitchChannel"
          name="twitchChannel"
          label="Canal de Twitch (opcional)"
          hint="Solo el nombre del canal, sin la arroba."
          placeholder="tu_canal"
          maxLength={25}
          autoComplete="off"
          error={fieldErrors.twitchChannel}
        />

        <TextField
          id="youtubeChannel"
          name="youtubeChannel"
          label="Canal de YouTube (opcional)"
          hint="El @nombre de tu canal, como aparece en youtube.com/@nombre."
          placeholder="@tu_canal"
          maxLength={100}
          autoComplete="off"
          error={fieldErrors.youtubeChannel}
        />

        <TextField
          id="kickChannel"
          name="kickChannel"
          label="Canal de Kick (opcional)"
          hint="El nombre de tu canal, tal cual está en kick.com/nombre."
          placeholder="tu_canal"
          maxLength={100}
          autoComplete="off"
          error={fieldErrors.kickChannel}
        />

        <div className="flex flex-col gap-1.5">
          <label htmlFor="terms" className="flex items-start gap-3 text-sm text-foreground">
            <input
              id="terms"
              name="terms"
              type="checkbox"
              required
              aria-invalid={fieldErrors.terms ? true : undefined}
              aria-describedby={fieldErrors.terms ? "terms-error" : undefined}
              className="mt-0.5 size-4 shrink-0"
            />
            <span>He leído y acepto las bases del torneo.</span>
          </label>
          {fieldErrors.terms ? (
            <p id="terms-error" className="text-sm text-red-400">
              {fieldErrors.terms}
            </p>
          ) : null}
        </div>

        {/* Campo trampa: fuera de pantalla pero sin `display: none`, que algunos
            bots detectan. No es tabulable ni lo anuncia el lector de pantalla, y
            una persona nunca lo rellena. */}
        <div className="absolute left-[-9999px]" aria-hidden="true">
          <label htmlFor="website">No rellenes este campo</label>
          <input
            id="website"
            name="website"
            type="text"
            tabIndex={-1}
            autoComplete="off"
          />
        </div>

        {turnstileSiteKey !== "" ? <TurnstileWidget siteKey={turnstileSiteKey} /> : null}

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="submit"
            disabled={pending || REGISTRATION_IS_CLOSED}
            aria-describedby={REGISTRATION_IS_CLOSED ? "registration-closed-note" : undefined}
            className="inline-flex h-10 items-center justify-center rounded-md border border-accent-strong/70 bg-linear-to-b from-accent-strong to-accent px-5 text-sm font-semibold text-accent-ink transition-colors hover:border-accent-strong hover:to-accent-strong disabled:cursor-not-allowed disabled:opacity-60"
          >
            {pending ? "Enviando…" : "Enviar solicitud"}
          </button>
          {REGISTRATION_IS_CLOSED ? (
            // Aviso, no error: se queda en `muted` para no competir con el rojo
            // que este formulario reserva a los fallos.
            <p id="registration-closed-note" className="max-w-[42ch] text-sm leading-relaxed text-muted">
              La organización abrirá las inscripciones más adelante, una vez que se acerquen las fechas del torneo.
            </p>
          ) : null}
        </div>
      </form>
    </section>
  );
}

/**
 * El paso de Discord: la acción obligatoria para conectar la cuenta, o la
 * cuenta ya conectada.
 *
 * Los tres estados que puede tener, y los tres son distinguibles de un vistazo:
 *
 * - **Sin conectar** (el que exige algo): filete de acento, etiqueta
 *   "Obligatorio" y un botón que lleva a `/api/discord/oauth`. Es el estado en el
 *   que la Server Action rechazaría el envío, así que el panel lo dice antes de
 *   que alguien lo descubra perdiendo el formulario entero. La acción va con el
 *   tratamiento principal del formulario (oro), porque es el siguiente paso real.
 * - **Conectado y dentro del servidor**: filete neutro, marca de verificación y
 *   nada que hacer. El paso ya está resuelto.
 * - **Conectado pero fuera del servidor**: filete de acento, verificación y la
 *   invitación de respaldo. Es el caso en que el bot no pudo meter a la persona (le
 *   falta el permiso `CREATE_INSTANT_INVITE`, o la cuenta ya estaba en otro servidor
 *   en el que él no está). La inscripción **no se bloquea** por eso: el enlace está
 *   para que entre a mano, y la comprobación de las 12 h lo detecta si no lo hace.
 *   Sin invitación configurada no se pinta un enlace roto: se explica que hay que
 *   entrar al servidor y que lo gestione la organización.
 *
 * El botón es un `<a>` y no un `button`: el viaje es a otro dominio, y el `form` de la
 * inscripción no tiene que enterarse de nada.
 *
 * `linkedUsername` llega **sin arroba** —la forma canónica de la columna— y se enseña
 * con ella (`@pepito`), que es como la persona lo reconoce. El paso **no tiene campo**:
 * la cuenta se conecta con el botón de OAuth, nunca escribiendo el `@usuario`, que es
 * el camino del panel de administración y otro distinto.
 */
function DiscordStepPanel({ step, error }: { step: DiscordStep; error?: string }) {
  const conectado = step.linkedUsername !== null;
  const dentro = conectado && step.joined;
  const titleId = useId();

  return (
    <div
      role="group"
      aria-labelledby={titleId}
      className={`mt-6 flex flex-col gap-3 rounded-lg border bg-background p-4 ${
        dentro ? "border-line" : "border-accent/40"
      }`}
    >
      <div className="flex flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-2">
          {conectado ? <CheckIcon className="size-4 shrink-0 text-accent" /> : null}
          <span id={titleId} className="text-sm font-medium text-foreground">
            {conectado ? `Conectado como @${step.linkedUsername}` : "Discord"}
          </span>
          {conectado ? null : <RequiredBadge />}
        </div>
        <p className="max-w-[58ch] text-sm leading-relaxed text-muted">
          {dentro
            ? "Tu cuenta está enlazada y ya estás en el servidor del torneo."
            : conectado
              ? step.inviteUrl !== null
                ? "Tu cuenta está enlazada, pero todavía no estás en el servidor del torneo. Entra con la invitación para no perderte los avisos."
                : "Tu cuenta está enlazada, pero todavía no estás en el servidor del torneo. Pide a la organización que te envíe una invitación."
              : "Conectar tu Discord es obligatorio: es el servidor donde la organización se comunica con los participantes del torneo."}
        </p>
      </div>

      {!conectado ? (
        // eslint-disable-next-line @next/next/no-html-link-for-pages -- tiene que ser una navegación completa: el destino es un Route Handler que devuelve una redirección a Discord, y con `<Link>` Next lo pediría como RSC en vez de seguirla.
        <a
          href="/api/discord/oauth"
          className="inline-flex h-10 w-fit items-center justify-center rounded-md border border-accent-strong/70 bg-linear-to-b from-accent-strong to-accent px-5 text-sm font-semibold text-accent-ink transition-colors hover:border-accent-strong hover:to-accent-strong"
        >
          Conectar con Discord
        </a>
      ) : null}

      {conectado && !step.joined && step.inviteUrl !== null ? (
        <a
          href={step.inviteUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex h-10 w-fit items-center justify-center rounded-md border border-line-strong bg-surface px-5 text-sm font-semibold text-foreground transition-colors hover:border-accent-strong/70 hover:text-accent"
        >
          Entrar al servidor
        </a>
      ) : null}

      {error ? (
        <p role="alert" className="text-sm leading-relaxed text-red-400">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Etiqueta de obligatoriedad del paso. No es un adorno: Discord no existe como
 * `<input required>` en el formulario, así que la obligación tiene que leerse en
 * el propio rótulo. Reutiliza el radio de píldora y el filete de las etiquetas de
 * modo del panel, con el oro del acento para marcar la exigencia.
 */
function RequiredBadge() {
  return (
    <span className="inline-block rounded-full border border-accent/40 px-2 py-0.5 text-xs font-medium text-accent">
      Obligatorio
    </span>
  );
}

type TextFieldProps = {
  id: string;
  name: string;
  label: string;
  hint?: string;
  error?: string;
} & Omit<ComponentPropsWithoutRef<"input">, "id" | "name" | "className">;

/**
 * Campo de texto del formulario. La pista y el error comparten línea bajo el
 * control: cuando hay error, el aviso lo sustituye y se enlaza con
 * `aria-describedby`, de modo que el mensaje nunca se pinta dos veces.
 */
function TextField({ id, name, label, hint, error, ...inputProps }: TextFieldProps) {
  const messageId = `${id}-message`;
  const message = error ?? hint;

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-foreground">
        {label}
      </label>
      <input
        id={id}
        name={name}
        aria-invalid={error ? true : undefined}
        aria-describedby={message ? messageId : undefined}
        className={`h-10 rounded-md border bg-background px-3 text-foreground placeholder:text-muted ${
          error ? "border-red-500/60" : "border-line"
        }`}
        {...inputProps}
      />
      {message ? (
        <p
          id={messageId}
          className={
            error ? "text-sm leading-relaxed text-red-400" : "text-xs leading-relaxed text-muted"
          }
        >
          {message}
        </p>
      ) : null}
    </div>
  );
}

type SelectFieldProps = {
  id: string;
  name: string;
  label: string;
  hint?: string;
  error?: string;
  required?: boolean;
  /** Texto de la opción vacía, deshabilitada: dice qué hay que hacer. */
  placeholder: string;
  options: readonly string[];
};

/**
 * Desplegable del formulario. Comparte el tratamiento de error de `TextField`
 * (la pista y el aviso en la misma línea, con `aria-describedby`), pero no admite
 * `placeholder` como un `<input>`: el estado "sin elegir" es un `option` vacío y
 * deshabilitado, que además no se puede marcar.
 */
function SelectField({
  id,
  name,
  label,
  hint,
  error,
  required,
  placeholder,
  options,
}: SelectFieldProps) {
  const messageId = `${id}-message`;
  const message = error ?? hint;

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-foreground">
        {label}
      </label>
      <select
        id={id}
        name={name}
        required={required}
        defaultValue=""
        aria-invalid={error ? true : undefined}
        aria-describedby={message ? messageId : undefined}
        className={`h-10 rounded-md border bg-background px-3 text-foreground ${
          error ? "border-red-500/60" : "border-line"
        }`}
      >
        <option value="" disabled>
          {placeholder}
        </option>
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
      {message ? (
        <p
          id={messageId}
          className={
            error ? "text-sm leading-relaxed text-red-400" : "text-xs leading-relaxed text-muted"
          }
        >
          {message}
        </p>
      ) : null}
    </div>
  );
}

/** Confirmación: ocupa el lugar del formulario cuando la solicitud ya está registrada. */
function RegistrationConfirmation({ message }: { message: string | null }) {
  return (
    <section className="thread-top relative mx-auto w-full max-w-2xl overflow-hidden rounded-lg border border-accent/30 bg-surface p-6 sm:p-8">
      <div className="flex items-center gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-full border border-accent/40 text-accent">
          <CheckIcon className="size-5" />
        </span>
        <h2 className="font-display text-xl font-semibold text-foreground">
          Solicitud recibida
        </h2>
      </div>

      <p className="mt-4 max-w-[58ch] text-[15px] leading-relaxed text-muted">
        {message ??
          "La organización la revisa antes de que entres en la clasificación."}
      </p>

      <p className="mt-4 max-w-[58ch] text-sm leading-relaxed text-muted/85">
        Mientras tanto, puedes consultar las{" "}
        <Link
          href="/reglas"
          className="text-accent underline underline-offset-4 hover:text-accent-strong"
        >
          reglas del torneo
        </Link>
        .
      </p>
    </section>
  );
}

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <path d="m5 12.5 4.5 4.5L19 6.5" />
    </svg>
  );
}
