import type { Metadata } from "next";
import Link from "next/link";
import { PageHead } from "@/components/page-head";
import { DEFAULT_COUNTRIES, readCountries } from "@/lib/countries";
import { readDiscordStep } from "@/lib/discord/session";
import { DEFAULT_REGISTRATION_OPEN } from "@/lib/registration-open";
import { readRegistrationOpen } from "@/lib/settings";
import { RegistrationForm } from "./registration-form";

export const metadata: Metadata = {
  title: "Participa",
  description:
    "Inscripción en la Liga Hispana de Age of Empires IV: alta de la cuenta de AoE4World, Discord obligatorio para entrar en el servidor del torneo, país y, de forma opcional, los canales de Twitch, YouTube y Kick, con revisión de la organización antes de entrar en la clasificación.",
};

// La lista de países admitidos se lee de `Setting` en cada petición, así que la
// página deja de ser estática. Sin esto el `next build` intentaría prerenderizarla
// sin `DATABASE_URL` y fallaría. Y desde F12 también lee una cookie para el paso de
// Discord, que es la segunda razón por la que no puede ser estática.
export const dynamic = "force-dynamic";

export default async function ParticipatePage({ searchParams }: PageProps<"/participar">) {
  // Un fallo de la base de datos no debe tumbar una página pública: el formulario
  // se pinta con la lista por defecto y, al enviarlo, la acción vuelve a leer la
  // lista viva y pide reintentar si tampoco puede. Es la misma degradación que el
  // resto de la web.
  //
  // Los cuatro no son un detalle: la lista de países sale de Postgres, el paso de
  // Discord sale de la petición, el estado del plazo sale de `Setting` y el aviso del
  // OAuth sale de la URL. Leídos en paralelo, la página tarda lo que el más lento; en
  // serie, lo que los cuatro suman.
  //
  // El plazo degrada a `DEFAULT_REGISTRATION_OPEN` (cerrado) igual que los países
  // degradan a la lista por defecto: si no se puede leer, el formulario se pinta como
  // cerrado en vez de abrir por accidente, y el servidor vuelve a comprobarlo en cada
  // envío real.
  const [countries, discord, registrationOpen, params] = await Promise.all([
    readCountries().catch(() => [...DEFAULT_COUNTRIES]),
    readDiscordStep(),
    readRegistrationOpen().catch(() => DEFAULT_REGISTRATION_OPEN),
    searchParams,
  ]);

  const notice = readDiscordNotice(params.discord);


  return (
    // La página es una sola columna centrada: el formulario marca el ancho
    // (2xl) y la intro y la nota adoptan ese mismo ancho para que sus bordes
    // caigan sobre los de la tarjeta y el conjunto no descuadre.
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-8">
      <PageHead title="Participa" />

      {/* El resultado del OAuth vuelve en `?discord=` (canceló, falló o el paso
          no está configurado). Va arriba del todo para que quien vuelve de
          Discord lo vea sin buscarlo; con `ok` no se pinta nada porque el propio
          paso ya muestra la cuenta conectada. */}
      {notice !== null ? <DiscordOAuthNotice notice={notice} /> : null}

      <p className="text-[15px] leading-relaxed text-muted">
        Inscríbete con tu cuenta de AoE4World. Cada solicitud la revisa la
        organización antes de aprobarse, así que no aparecerás en la clasificación
        hasta entonces. No hay equipos: cada persona compite por su cuenta.
      </p>

      <RegistrationForm
        countries={countries}
        discord={discord}
        registrationOpen={registrationOpen}
      />

      <p className="border-t border-line pt-6 text-sm leading-relaxed text-muted">
        Las{" "}
        <Link
          href="/reglas"
          className="text-accent underline underline-offset-4 hover:text-accent-strong"
        >
          reglas
        </Link>{" "}
        explican qué cuenta como partida clasificatoria y cómo se reparten los
        puntos.
      </p>
    </div>
  );
}

type DiscordNotice = { tone: "neutral" | "error"; message: string };

/**
 * Traduce `?discord=` al aviso que se pinta sobre el formulario.
 *
 * Solo tres valores llevan aviso: `cancel` (la persona cerró la pantalla de
 * permisos), `error` (no se pudo resolver la identidad) y `no-config` (el paso no
 * está disponible). `ok` no lleva a propósito: el propio paso ya enseña la cuenta
 * conectada y repetirlo sería ruido. Cualquier otro valor se ignora.
 */
function readDiscordNotice(value: string | string[] | undefined): DiscordNotice | null {
  if (value === "cancel") {
    return {
      tone: "neutral",
      message:
        "Has cancelado la conexión con Discord. Puedes retomarla cuando quieras desde el paso de Discord para completar la inscripción.",
    };
  }

  if (value === "error") {
    return {
      tone: "error",
      message:
        "No se ha podido completar la conexión con Discord. Vuelve a intentarlo; si el problema sigue, avisa a la organización.",
    };
  }

  if (value === "no-config") {
    return {
      tone: "neutral",
      message:
        "La conexión con Discord no está disponible en este momento. Inténtalo más tarde o avisa a la organización.",
    };
  }

  return null;
}

/**
 * Aviso del resultado del OAuth. Comparte forma con el error general del
 * formulario (filete y relleno a `rounded-md`), pero reserva el rojo al fallo de
 * verdad: una cancelación o un paso no configurado se leen en tono neutro, sin
 * alarmar a quien solo ha cerrado una pantalla.
 */
function DiscordOAuthNotice({ notice }: { notice: DiscordNotice }) {
  const isError = notice.tone === "error";

  return (
    <p
      role={isError ? "alert" : "status"}
      className={`rounded-md border px-4 py-3 text-sm leading-relaxed ${
        isError
          ? "border-red-500/40 bg-red-500/5 text-red-300"
          : "border-line bg-surface text-muted"
      }`}
    >
      {notice.message}
    </p>
  );
}
