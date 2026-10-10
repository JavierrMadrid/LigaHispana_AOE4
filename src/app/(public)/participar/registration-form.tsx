"use client";

import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { useActionState, useEffect, useId, useRef } from "react";
import Link from "next/link";
import { KickIcon } from "@/components/kick-icon";
import { TwitchIcon } from "@/components/twitch-icon";
import { YoutubeIcon } from "@/components/youtube-icon";
import type { DiscordStep } from "@/lib/discord/contract";
import { CONTACT_EMAIL_MAX_LENGTH } from "@/lib/player-input";
import { REGISTRATION_CLOSED_MESSAGE } from "@/lib/registration-open";
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
 * Los campos se agrupan en dos `fieldset` con su `legend`: los datos del jugador
 * (con el Profile ID, el nombre, el correo y el país) y los canales de directo,
 * que son opcionales y lo dicen una sola vez en el propio rótulo del grupo. Cada
 * control lleva el icono que le identifica a la izquierda, decorativo
 * (`aria-hidden`): la etiqueta visible sigue siendo la que nombra el campo, así
 * que el icono no carga significado accesible.
 *
 * Con el plazo cerrado (`registrationOpen` en `false`) el botón se desactiva y el
 * motivo se lee a su lado, enlazado con `aria-describedby`. El servidor lo
 * rechaza igualmente: esto es la cara visible del mismo interruptor
 * (`Setting["registration.open"]`), no la defensa.
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
  registrationOpen,
  discord,
}: {
  countries: string[];
  /** Si el plazo está cerrado, el envío se desactiva y se explica por qué. */
  registrationOpen: boolean;
  discord: DiscordStep;
}) {
  const [state, formAction, pending] = useActionState(registerPlayer, initialState);
  // Referencias para llevar el foco al fallo tras un envío con error: al bloque
  // general si hay mensaje, o al primer control inválido si no lo hay.
  const formRef = useRef<HTMLFormElement>(null);
  const generalErrorRef = useRef<HTMLParagraphElement>(null);

  // El token de Turnstile es de un solo uso: la Server Action lo canjea contra
  // Cloudflare antes de validar los campos, así que cualquier respuesta de error
  // lo deja gastado. Sin resetear aquí, el segundo intento fallaría siempre y el
  // formulario quedaría inservible hasta recargar.
  useEffect(() => {
    if (turnstileSiteKey !== "" && state.status === "error") {
      resetTurnstileWidget();
    }
  }, [state]);

  // Tras un error, el envío deja la vista arriba y el motivo puede quedar fuera
  // de pantalla: se lleva el foco al aviso general o, sin él, al primer campo
  // marcado como inválido, que sí tiene un motivo propio.
  useEffect(() => {
    if (state.status !== "error") {
      return;
    }

    if (state.message) {
      generalErrorRef.current?.focus();
      return;
    }

    formRef.current
      ?.querySelector<HTMLElement>('[aria-invalid="true"]')
      ?.focus();
  }, [state]);

  if (state.status === "success") {
    return <RegistrationConfirmation message={state.message} />;
  }

  const { fieldErrors } = state;

  // El plazo cerrado decide tres cosas de la misma línea: el botón, su
  // descripción accesible y el aviso. Se calcula una vez para que no puedan
  // divergir.
  const isClosed = !registrationOpen;

  return (
    <section className="mx-auto w-full max-w-2xl rounded-lg border border-line bg-surface p-6 sm:p-8">
      <h2 className="border-b border-line pb-3 font-display text-xl font-semibold text-foreground">
        Inscripción
      </h2>
      <p className="mt-4 max-w-[58ch] text-sm leading-relaxed text-muted">
        Necesitas tu identificador de perfil de AoE4World. El nombre, el correo, el
        país y el Discord son obligatorios; los canales de directo (Twitch, YouTube
        y Kick) son opcionales y solo sirven para señalar tu emisión cuando juegas
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

      <form ref={formRef} action={formAction} className="mt-6 flex flex-col gap-8">
        {state.status === "error" && state.message ? (
          <p
            ref={generalErrorRef}
            tabIndex={-1}
            role="alert"
            className="rounded-md border border-danger/40 bg-danger/5 px-4 py-3 text-sm leading-relaxed text-danger-soft"
          >
            {state.message}
          </p>
        ) : null}

        <fieldset className="min-w-0">
          <FieldLegend badge="Obligatorio">Datos del jugador</FieldLegend>
          <div className="flex flex-col gap-5">
            <TextField
              id="profileId"
              name="profileId"
              label="Profile ID de AoE4World"
              hint="El número de tu perfil, visible en la URL de aoe4world.com/players."
              placeholder="1234567"
              inputMode="numeric"
              autoComplete="off"
              required
              icon={<ProfileIcon className="size-4" />}
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
              icon={<UserIcon className="size-4" />}
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
              icon={<EnvelopeIcon className="size-4" />}
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
              icon={<GlobeIcon className="size-4" />}
              error={fieldErrors.country}
            />
          </div>
        </fieldset>

        <fieldset className="min-w-0">
          <FieldLegend badge="Opcional">Canales de directo</FieldLegend>
          <div className="flex flex-col gap-5">
            <TextField
              id="twitchChannel"
              name="twitchChannel"
              label="Canal de Twitch"
              hint="Solo el nombre del canal, sin la arroba."
              placeholder="tu_canal"
              maxLength={25}
              autoComplete="off"
              icon={<TwitchIcon className="size-4" />}
              error={fieldErrors.twitchChannel}
            />

            <TextField
              id="youtubeChannel"
              name="youtubeChannel"
              label="Canal de YouTube"
              hint="El @nombre de tu canal, como aparece en youtube.com/@nombre."
              placeholder="@tu_canal"
              maxLength={100}
              autoComplete="off"
              icon={<YoutubeIcon className="size-4" />}
              error={fieldErrors.youtubeChannel}
            />

            <TextField
              id="kickChannel"
              name="kickChannel"
              label="Canal de Kick"
              hint="El nombre de tu canal, tal cual está en kick.com/nombre."
              placeholder="tu_canal"
              maxLength={100}
              autoComplete="off"
              icon={<KickIcon className="size-4" />}
              error={fieldErrors.kickChannel}
            />
          </div>
        </fieldset>

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
            <span className="flex flex-wrap items-center gap-2">
              <span>He leído y acepto las bases del torneo.</span>
              <RequiredBadge />
            </span>
          </label>
          {fieldErrors.terms ? (
            <p id="terms-error" className="text-sm text-danger">
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
            disabled={pending || isClosed}
            aria-describedby={isClosed ? "registration-closed-note" : undefined}
            className="inline-flex h-10 items-center justify-center rounded-md bg-accent px-5 text-sm font-semibold text-accent-ink transition-colors hover:bg-accent-strong active:translate-y-px disabled:cursor-not-allowed disabled:opacity-60"
          >
            {pending ? "Enviando…" : "Enviar solicitud"}
          </button>
          {isClosed ? (
            // Aviso, no error: se queda en `muted` para no competir con el rojo
            // que este formulario reserva a los fallos. El texto es el compartido
            // con el servidor, para que la cara visible y el rechazo digan lo mismo.
            <p
              id="registration-closed-note"
              className="max-w-[42ch] text-sm leading-relaxed text-muted"
            >
              {REGISTRATION_CLOSED_MESSAGE}
            </p>
          ) : null}
        </div>
      </form>
    </section>
  );
}

/**
 * Rótulo de grupo de campos: el `legend` del `fieldset` con un filete que corre
 * a su derecha. Es estructura, no adorno: separa un bloque del siguiente sin
 * gastar una segunda línea de texto, y deja que el grupo opcional lo diga en su
 * propia etiqueta en vez de repetir "(opcional)" en cada campo.
 */
function FieldLegend({ children, badge }: { children: ReactNode; badge?: string }) {
  return (
    <legend className="mb-4 block w-full">
      <span className="flex items-center gap-3 text-sm font-semibold text-foreground">
        <span>{children}</span>
        {badge ? (
          <span className="rounded-full border border-line px-2 py-0.5 text-xs font-medium text-muted">
            {badge}
          </span>
        ) : null}
        <span aria-hidden="true" className="h-px flex-1 bg-line" />
      </span>
    </legend>
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
          {conectado ? (
            <CheckIcon className="size-4 shrink-0 text-accent" />
          ) : (
            <DiscordIcon className="size-4 shrink-0 text-accent" />
          )}
          <span id={titleId} className="text-sm font-medium text-foreground">
            {conectado ? `Conectado como @${step.linkedUsername}` : "Discord"}
          </span>
          {conectado ? null : <RequiredBadge />}
        </div>
        {conectado ? (
          <p className="max-w-[58ch] text-sm leading-relaxed text-muted">
            {dentro
              ? "Tu cuenta está enlazada y ya estás en el servidor del torneo."
              : step.inviteUrl !== null
                ? "Tu cuenta está enlazada, pero todavía no estás en el servidor del torneo. Entra con la invitación para no perderte los avisos."
                : "Tu cuenta está enlazada, pero todavía no estás en el servidor del torneo. Pide a la organización que te envíe una invitación."}
          </p>
        ) : (
          // Sin conectar, la explicación y la acción comparten fila desde `sm`:
          // la obligación y el botón se leen de un tirón, sin una línea extra.
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
            <p className="max-w-[58ch] text-sm leading-relaxed text-muted">
              Conectar tu Discord es obligatorio: es el servidor donde la organización se comunica con los participantes del torneo.
            </p>
            {/* El texto visible es "Conectar" —"con Discord" sobra dentro del
                paso—, pero el nombre accesible lo completa para quien navega
                por una lista de controles fuera de contexto. */}
            {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- tiene que ser una navegación completa: el destino es un Route Handler que devuelve una redirección a Discord, y con `<Link>` Next lo pediría como RSC en vez de seguirla. */}
            <a
              href="/api/discord/oauth"
              aria-label="Conectar con Discord"
              className="inline-flex h-10 w-fit shrink-0 items-center justify-center gap-2 rounded-md bg-accent px-5 text-sm font-semibold text-accent-ink transition-colors hover:bg-accent-strong active:translate-y-px"
            >
              <DiscordIcon className="size-4" />
              Conectar
            </a>
          </div>
        )}
      </div>

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
        <p role="alert" className="text-sm leading-relaxed text-danger">
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
  /** Glifo decorativo a la izquierda del control (`aria-hidden`). */
  icon?: ReactNode;
} & Omit<ComponentPropsWithoutRef<"input">, "id" | "name" | "className">;

/**
 * Campo de texto del formulario. La pista y el error comparten línea bajo el
 * control: cuando hay error, el aviso lo sustituye y se enlaza con
 * `aria-describedby`, de modo que el mensaje nunca se pinta dos veces.
 *
 * El icono va en un envoltorio `relative` y el control reserva el hueco con
 * `pl-10`, para que el texto no se monte encima. Es puramente decorativo: el
 * `<label>` visible sigue nombrando el campo.
 */
function TextField({ id, name, label, hint, error, icon, ...inputProps }: TextFieldProps) {
  const messageId = `${id}-message`;
  const message = error ?? hint;

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-foreground">
        {label}
      </label>
      <div className="relative">
        {icon ? (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-muted"
          >
            {icon}
          </span>
        ) : null}
        <input
          id={id}
          name={name}
          aria-invalid={error ? true : undefined}
          aria-describedby={message ? messageId : undefined}
          className={`h-10 w-full rounded-md border bg-background text-foreground transition-colors placeholder:text-muted ${
            icon ? "pl-10 pr-3" : "px-3"
          } ${error ? "border-danger/60" : "border-line focus:border-accent-strong"}`}
          {...inputProps}
        />
      </div>
      {message ? (
        <p
          id={messageId}
          className={
            error ? "text-sm leading-relaxed text-danger" : "text-xs leading-relaxed text-muted"
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
  /** Glifo decorativo a la izquierda del control (`aria-hidden`). */
  icon?: ReactNode;
};

/**
 * Desplegable del formulario. Comparte el tratamiento de error de `TextField`
 * (la pista y el aviso en la misma línea, con `aria-describedby`), pero no admite
 * `placeholder` como un `<input>`: el estado "sin elegir" es un `option` vacío y
 * deshabilitado, que además no se puede marcar.
 *
 * Se pinta con `appearance-none` para que el control siga el mismo dialecto que
 * los demás (filete, relleno y radio propios) y el chevron va dibujado a la
 * derecha; el hueco del icono y el del chevron se reservan con `pl-10`/`pr-9`.
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
  icon,
}: SelectFieldProps) {
  const messageId = `${id}-message`;
  const message = error ?? hint;

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-foreground">
        {label}
      </label>
      <div className="relative">
        {icon ? (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-muted"
          >
            {icon}
          </span>
        ) : null}
        <select
          id={id}
          name={name}
          required={required}
          defaultValue=""
          aria-invalid={error ? true : undefined}
          aria-describedby={message ? messageId : undefined}
          className={`h-10 w-full appearance-none rounded-md border bg-background text-foreground transition-colors ${
            icon ? "pl-10" : "pl-3"
          } pr-9 ${error ? "border-danger/60" : "border-line focus:border-accent-strong"}`}
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
        <ChevronDownIcon className="pointer-events-none absolute inset-y-0 right-3 my-auto size-4 text-muted" />
      </div>
      {message ? (
        <p
          id={messageId}
          className={
            error ? "text-sm leading-relaxed text-danger" : "text-xs leading-relaxed text-muted"
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

      <p className="mt-4 max-w-[58ch] text-sm leading-relaxed text-muted">
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

/**
 * Iconos de campo de un solo uso. Van en este módulo, como `CheckIcon`, y no en
 * `src/components/`: nadie más los pinta. Trazo fino y `currentColor` para
 * hermanar con la marca de verificación; los glifos de plataforma (Twitch,
 * YouTube, Kick, Discord) son de relleno, que es como se reconocen.
 */

function ProfileIcon({ className }: { className?: string }) {
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
      <rect x="3.5" y="5" width="17" height="14" rx="2" />
      <circle cx="9" cy="10.5" r="2" />
      <path d="M5.9 16c.5-1.5 1.7-2.3 3.1-2.3s2.6.8 3.1 2.3" />
      <path d="M14.5 9.5h3.5M14.5 13h3.5" />
    </svg>
  );
}

function UserIcon({ className }: { className?: string }) {
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
      <circle cx="12" cy="8" r="3.5" />
      <path d="M5.5 19.5c0-3.3 2.9-5.5 6.5-5.5s6.5 2.2 6.5 5.5" />
    </svg>
  );
}

function EnvelopeIcon({ className }: { className?: string }) {
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
      <rect x="3.5" y="5.5" width="17" height="13" rx="2" />
      <path d="m4.5 7.5 7.5 5 7.5-5" />
    </svg>
  );
}

function GlobeIcon({ className }: { className?: string }) {
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
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.5 12h17" />
      <path d="M12 3.5c2.3 2.4 3.5 5.3 3.5 8.5s-1.2 6.1-3.5 8.5c-2.3-2.4-3.5-5.3-3.5-8.5S9.7 5.9 12 3.5Z" />
    </svg>
  );
}

function ChevronDownIcon({ className }: { className?: string }) {
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
      <path d="m6 9.5 6 6 6-6" />
    </svg>
  );
}

function DiscordIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={className}>
      <path
        fill="currentColor"
        d="M20.317 4.369a19.79 19.79 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.249a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.036A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128c.126-.094.252-.192.372-.291a.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.009c.12.099.246.198.373.292a.077.077 0 0 1-.006.127 12.3 12.3 0 0 1-1.873.891.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.331c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"
      />
    </svg>
  );
}
