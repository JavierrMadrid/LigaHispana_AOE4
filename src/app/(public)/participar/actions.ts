"use server";

import { revalidatePath } from "next/cache";
import { findCountryIsoConflict, readCountries, type CountryIsoConflict } from "@/lib/countries";
import { db } from "@/lib/db";
import { logDatabaseFailure } from "@/lib/db-errors";
import { Prisma } from "@/generated/prisma/client";
import { PlayerStatus } from "@/generated/prisma/enums";
import {
  CONTACT_EMAIL_MAX_LENGTH,
  isLegacyYoutubeUrl,
  parseCountry,
  parseEmail,
  parseKickChannel,
  parseName,
  parseProfileId,
  parseTwitchChannel,
  parseYoutubeChannel,
} from "@/lib/player-input";
import { consumePublicFormAttempt } from "@/lib/rate-limit";
import { checkAoe4WorldProfile } from "@/lib/registration";
import { REGISTRATION_CLOSED_MESSAGE } from "@/lib/registration-open";
import { readRegistrationOpen } from "@/lib/settings";
import { readTurnstileToken, verifyTurnstile } from "@/lib/turnstile";

/**
 * Estado que consume el formulario público de `/participar` con
 * `useActionState(registerPlayer, initialState)`.
 *
 * `status` distingue los tres momentos de la UI: `idle` (todavía no se ha
 * enviado nada), `error` (hay que corregir algo) y `success` (la solicitud está
 * registrada y hay que pintar la confirmación). `message` es el texto general de
 * ese estado y `fieldErrors` el detalle por campo, que se pinta junto a su
 * `input`. Los dos van juntos: un error de campo suele convivir con un mensaje
 * general que explica el conjunto.
 *
* `fieldErrors` lleva una clave por campo del formulario, y su nombre es el
 * `name` del `input` correspondiente: `profileId`, `name`, `email`,
 * `twitchChannel`, `youtubeChannel`, `kickChannel`, `country` y `terms`. El correo
 * es obligatorio desde F6 (está en `Player.contactEmail`) y el país también (está en
 * `Player.country` y es uno de los datos con los que la organización organiza el
 * torneo), así que el formulario tiene que mandar esos dos `input` con esos nombres
 * exactos. Los tres canales son **opcionales**: quien no emite puede dejarlos vacíos
 * y no pierde nada por ello.
 *
 * Los dos canales nuevos (YouTube y Kick) usan los mismos parsers que el alta de
 * admin, y un valor escrito que no vale sale como error de campo en lugar de
 * guardarse como `null`: `Player.youtubeChannel` y `Player.kickChannel` no tienen
 * respaldo desde AoE4World, así que un canal mal escrito no lo arregla nadie en la
 * siguiente pasada del sincronizador.
 *
 * El país **no** se valida contra una lista escrita en el componente: la lista
 * admitida vive en `Setting["registration.countries"]` (ver `src/lib/countries.ts`)
 * y se pasa a `parseCountry()`. Así el desplegable y esta validación no pueden
 * ofrecer países distintos.
 *
 * Y el país elegido se **contrasta además** con el que AoE4World tiene en el perfil
 * (`country`, un ISO-2): solo se bloquea cuando los dos se resuelven a rótulos de la
 * lista admitida y son distintos, y sale como error de ese campo. Sin país en el
 * perfil, o con un ISO que no se sabe traducir, se deja pasar.
 */
export type RegistrationFormState = {
  status: "idle" | "error" | "success";
  message: string | null;
  fieldErrors: {
    profileId?: string;
    name?: string;
    email?: string;
    twitchChannel?: string;
    youtubeChannel?: string;
    kickChannel?: string;
    country?: string;
    terms?: string;
  };
};

/**
 * Confirmación de la inscripción. La comparten el envío real y el que cae en el
 * campo trampa, a propósito: un bot no debe poder distinguir uno del otro. La
 * comparte también la reinscripción de un `REJECTED`, porque para quien la manda
 * el resultado es el mismo: su solicitud vuelve a estar en la cola de revisión.
 *
 * El camino del campo trampa la sigue devolviendo aunque el plazo esté cerrado
 * (ver `readRegistrationOpen()`): el cierre no se le revela a un bot.
 */
const CONFIRMATION =
  "Solicitud recibida. La organización la revisa antes de que entres en la clasificación.";

const DUPLICATE_PROFILE_ERROR = "Ese perfil ya está registrado en la liga.";

const DUPLICATE_FAILED_MESSAGE = "No hemos podido completar la inscripción.";

const FAILED_MESSAGE =
  "No hemos podido guardar la inscripción. Inténtalo de nuevo en unos minutos.";

/**
 * Fallo de la base de datos **antes** de escribir (contador de frecuencia o
 * comprobación de duplicado). No es un "no hemos podido guardar" —nada se ha
 * intentado guardar— ni un "has enviado demasiadas solicitudes", que sería
 * untrue: el formulario se queda sin poder comprobar nada. El motivo concreto se
 * queda en el log del servidor, con el prefijo `[db]`.
 */
const DATABASE_UNAVAILABLE_MESSAGE =
  "No hemos podido registrar la inscripción ahora mismo. Inténtalo de nuevo en unos minutos.";

const UNKNOWN_PROFILE_ERROR =
  "No encontramos ese perfil en AoE4World. Revisa el número: es el que aparece " +
  "en la URL de tu perfil, aoe4world.com/players.";

const PROFILE_UNAVAILABLE_MESSAGE =
  "No hemos podido comprobar el perfil ahora mismo. Inténtalo en unos minutos.";

const RATE_LIMIT_MESSAGE =
  "Has enviado demasiadas solicitudes desde esta conexión. Espera un rato antes de volver a intentarlo.";

const RATE_LIMIT_GLOBAL_MESSAGE =
  "El formulario está recibiendo demasiadas solicitudes a la vez. Inténtalo en unos minutos.";

/**
 * Fallo del captcha. Dice lo que ha pasado y pide recargar, pero no dice si fue
 * un token caducado, un rechazo de Cloudflare o un problema de red: el motivo
 * se queda en el log del servidor. Es además el mensaje que sale cuando el
 * captcha **no se ha podido comprobar**, que es el caso en el que la respuesta
 * correcta es no dejar pasar el envío.
 */
const CAPTCHA_MESSAGE =
  "No hemos podido comprobar que no eres un robot. Recarga e inténtalo de nuevo.";

const EMAIL_REQUIRED_ERROR =
  "El correo es obligatorio: es donde te podemos escribir si hay dudas.";

const EMAIL_TOO_LONG_ERROR = `El correo no puede superar los ${CONTACT_EMAIL_MAX_LENGTH} caracteres.`;

const EMAIL_INVALID_ERROR =
  "Ese correo no parece válido. Revisa que tenga algo antes y después de la arroba.";

const COUNTRY_REQUIRED_ERROR =
  "El país es obligatorio: elígelo en la lista de los que admite el torneo.";

const COUNTRY_UNKNOWN_ERROR =
  "Ese país no está en la lista de los que admite el torneo. Elígelo en el desplegable.";

/**
 * El país elegido y el que AoE4World tiene en el perfil no son el mismo.
 *
 * Nombra los dos porque sin nombrarlos el error no dice nada que se pueda
 * corregir: quien lee "el país no coincide" sin más no sabe cuál de los dos es el
 * que está mal, y lo único que puede hacer es probar con otro. El primero que se
 * nombra es el de AoE4World, porque es el dato del que la organización parte para
 * organizar el torneo y el que la persona puede consultar en su perfil.
 *
 * No se dice "debería ser" en imperativo sino que se corrige el desplegable: el
 * mensaje no sabe si el error es del desplegable o de una elección equivocada, y
 * los dos se arreglan ahí.
 */
function countryMismatchMessage(conflict: CountryIsoConflict): string {
  return (
    `En tu perfil de AoE4World el país es ${conflict.aoe4WorldCountry} y en el ` +
    `formulario has elegido ${conflict.selectedCountry}. Corrige el desplegable para ` +
    "que coincida con el de tu perfil."
  );
}

/**
 * Los tres canales de directo: opcionales, y con el mismo criterio de "un valor
 * escrito que no vale es un error, no un `null` en silencio".
 *
 * Los mensajes de Twitch los lleva el campo desde F6, con un texto más corto; los
 * de YouTube y Kick se explican algo más porque las dos plataformas tienen formas
 * que la gente pega y este proyecto no admite: la URL antigua `/c/…` de YouTube y
 * las URLs con `https://` de las tres.
 */
const YOUTUBE_INVALID_ERROR =
  "Ese canal de YouTube no parece válido. Escribe el @nombre del canal (3 a 30 letras, números, punto, guion o guion bajo) o la dirección youtube.com/@nombre.";

const YOUTUBE_LEGACY_URL_ERROR =
  "Esa dirección no lleva el @nombre del canal. Las URLs /c/ y /user/ no lo tienen, así que escribe el @nombre, que es lo que aparece en youtube.com/@nombre.";

const KICK_INVALID_ERROR =
  "Ese canal de Kick no parece válido. Escribe el nombre del canal o la dirección kick.com/nombre.";

/** Lo que la escritura puede devolver. Ningún camino crea nada por la mitad. */
type WriteOutcome = "created" | "resubmitted" | "duplicate" | "failed";

type RegistrationInput = {
  /** Fila previa con el mismo `profileId`, o `null` si no había ninguna. */
  existing: { id: string; status: PlayerStatus } | null;
  profileId: number;
  name: string;
  contactEmail: string;
  /** Rótulo canónico de la lista admitida, ya resuelto por `parseCountry`. */
  country: string;
  twitchChannel: string | null;
  /** Handle de YouTube sin arroba, ya resuelto por `parseYoutubeChannel`. */
  youtubeChannel: string | null;
  /** Slug de Kick en minúsculas, ya resuelto por `parseKickChannel`. */
  kickChannel: string | null;
  aoe4WorldName: string;
  avatarUrl: string | null;
};

/**
 * Escribe la solicitud: fila nueva, o reinscripción de un `REJECTED`.
 *
 * Son dos caminos porque son dos intenciones distintas, y solo uno crea:
 *
 * - **No había fila**: `create` en `PENDING`. Si entre la comprobación y esta
 *   escritura se coló otra con el mismo `profileId`, la unicidad de la columna
 *   salta con `P2002` y eso se traduce a "duplicado", no a un error de servidor.
 * - **La fila estaba `REJECTED`**: se **actualiza** y vuelve a `PENDING`. No se
 *   crea una segunda fila porque `profileId` es único y porque la cola de
 *   revisión quiere una sola solicitud por persona, no un historial de ellas.
 *
 * El `updateMany` filtra por id **y** por estado, y no un `update` normal, por un
 * motivo de carrera: entre que se leyó la fila y esto, un admin puede haberla
 * aprobado. Con `update` la escritura pisaría esa aprobación sin avisar; así, si
 * el estado ya no es `REJECTED` el `UPDATE` no toca nada, `count` sale a 0 y se
 * trata como duplicado, que es lo que es.
 *
 * En la reinscripción se reescriben **los tres canales** junto al nombre y al
 * correo, por el mismo motivo que el país: quien se reinscribe dice cómo emite
 * ahora, y dejarlo como estaba sería guardar el dato de una solicitud que la
 * organización ya miró y rechazó.
 */
async function persistRegistration(input: RegistrationInput): Promise<WriteOutcome> {
  // El retrato solo si la API lo trae: un `avatars.full` vacío no pisa el último
  // guardado (mismo criterio que el worker) y la interfaz dibuja el monograma de
  // reserva.
  const portrait = input.avatarUrl === null ? {} : { avatarUrl: input.avatarUrl };

  try {
    if (input.existing) {
      const updated = await db.player.updateMany({
        where: { id: input.existing.id, status: PlayerStatus.REJECTED },
        data: {
          // Nombre de display y canal: lo que dice este envío. En una
          // reinscripción la fila anterior se considera superada, así que un
          // campo que se deja vacío se queda vacío.
          name: input.name,
          twitchChannel: input.twitchChannel,
          youtubeChannel: input.youtubeChannel,
          kickChannel: input.kickChannel,
          contactEmail: input.contactEmail,
          // El país también se vuelve a pedir: quien se reinscribe dice de dónde
          // es ahora, y dejarlo como estaba sería guardar el dato de una solicitud
          // que la organización ya miró y rechazó.
          country: input.country,
          aoe4WorldName: input.aoe4WorldName,
          ...portrait,
          // `PENDING` fijo y no el que tuviera: reinscribirse es volver a pedir
          // la revisión, no recuperar la que se rechazó.
          status: PlayerStatus.PENDING,
        },
      });

      return updated.count > 0 ? "resubmitted" : "duplicate";
    }

    await db.player.create({
      data: {
        profileId: input.profileId,
        // Nombre de display: lo que escribió quien se inscribe, tal cual. El
        // oficial de AoE4World va en su propia columna para poder publicar los
        // dos sin pisar el que eligió la persona.
        name: input.name,
        aoe4WorldName: input.aoe4WorldName,
        ...portrait,
        twitchChannel: input.twitchChannel,
        youtubeChannel: input.youtubeChannel,
        kickChannel: input.kickChannel,
        contactEmail: input.contactEmail,
        country: input.country,
        // `PENDING` fijo y no el que venga en el `FormData`: aprobar o rechazar
        // es una decisión de la organización, y un formulario público no puede
        // autoaprobar su propia solicitud por mucho que mida el campo.
        status: PlayerStatus.PENDING,
      },
    });

    return "created";
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return "duplicate";
    }

    // El detalle se queda en el log del servidor. Al formulario solo vuelve un
    // mensaje que no enseña ni mensaje de la base de datos ni traza.
    logDatabaseFailure("participar/alta", error);

    return "failed";
  }
}

/**
 * Alta de una solicitud de participación desde la web pública.
 *
 * Es un endpoint público a propósito: no hay sesión ni `requireAdmin()` porque
 * la inscripción es abierta. Lo que sí es cerrado a propósito es el resultado:
 * la fila se deja siempre en `PENDING` y la organización la aprueba o rechaza
 * desde `/admin/jugadores`.
 *
 * Lo que la mantiene a salvo del abuso son cinco capas, en el orden en que se
 * aplican:
 *
 * Antes de todas está el **interruptor de plazo** (`readRegistrationOpen()`, que
 * lee `Setting["registration.open"]` y comparte contrato en
 * `src/lib/registration-open.ts` para que el formulario y esta acción lean el
 * mismo dato), que no es una capa de defensa sino una decisión de producto: con
 * el plazo cerrado el envío real se rechaza con un mensaje general y no se aplica
 * ninguna, porque no se va a escribir nada. Sale después del campo trampa para que
 * un bot siga viendo la misma confirmación.
 *
 * 1. **Campo trampa** (`website`): no se escribe nada y se devuelve la misma
 *    confirmación que un alta buena, para que un bot no pueda aprender a
 *    esquivarla.
 * 2. **Límite de frecuencia por IP** (`src/lib/rate-limit.ts`): cuenta en
 *    Postgres, con la IP hasheada, y corta antes de validar nada. Va antes que
 *    los validadores a propósito: si solo contara los envíos válidos, un bot
 *    podría martillear el formulario con basura sin que le costara nada.
 * 3. **Captcha** (Cloudflare Turnstile, `src/lib/turnstile.ts`): cierra lo que
 *    el límite de frecuencia no puede, que es un `x-forwarded-for` rotado a
 *    mano detrás de un proxy que lo reenvía sin reescribir. Va aquí, antes de los
 *    validadores, porque es la capa que acota lo que llega al resto: una persona
 *    con una errata la pasa sin enterarse y solo ve el error de su campo, y un
 *    bot se queda antes de poder tantear nada. **Sin `TURNSTILE_SECRET_KEY` la
 *    comprobación se salta** y todo sigue funcionando; en producción hay que
 *    definirla.
 * 4. **Validadores de los campos**, compartidos con el alta de admin
 *    (`src/lib/player-input.ts`), y después la comprobación de la fila existente:
 *    las dos son gratis y así la API no se gasta en un envío que iba a fallar
 *    igualmente. El país rompe un poco el patrón porque su lista **no** la fija el
 *    código: se lee de `Setting` (`readCountries()`), y si esa lectura falla no se
 *    valida contra la lista por defecto en silencio sino que se pide reintentar,
 *    porque escribir el país de una lista que ya no es la vigente sería peor que no
 *    haber escrito nada.
 * 5. **Comprobación del perfil contra AoE4World** (`src/lib/registration.ts`): si
 *    el `profileId` no existe no se escribe nada, y si existe se guarda el nombre
 *    oficial en `aoe4WorldName` junto al de display, que es el que escribió
 *    quien se inscribe. La misma respuesta trae el **país del perfil**, que es lo
 *    que permite contrastarlo con el que eligió la persona en el desplegable: si
 *    los dos se resuelven y no son el mismo, sale como error de campo y no se
 *    escribe nada (ver el punto 5b).
 *
 * 5b. **Contraste del país** (`findCountryIsoConflict()`, en `src/lib/countries.ts`).
 *     Es la única comprobación de la lista de campos que **no falla cerrando**: si
 *     el perfil no trae país, o el ISO que trae no se puede traducir a un rótulo de
 *     la lista admitida, la inscripción continúa. Bloquear ahí sería afirmar una
 *     contradicción que no se ha podido comprobar, que es el peor error que puede
 *     cometer un formulario de este tipo: deja fuera a alguien que sí cumple.
 *
 * Y una decisión de producto que va con la anterior: **un `REJECTED` se puede
 * reinscribir**. Si el perfil ya existe, solo se acepta el envío cuando su estado
 * es `REJECTED`, y entonces lo que hace es actualizar esa fila y devolverla a
 * `PENDING`. Un `APPROVED` o un `PENDING` bloquean: el primero porque ya está en
 * la liga y el segundo porque su solicitud está en la cola de revisión y una
 * segunda no aportaría nada.
 */
export async function registerPlayer(
  _prevState: RegistrationFormState,
  formData: FormData,
): Promise<RegistrationFormState> {
  // Campo trampa (honeypot): está oculto en el formulario y una persona no lo
  // rellena. Si viene con contenido no se escribe nada y se devuelve la misma
  // confirmación que un alta buena, sin revelar que existe la trampa: así el
  // bot no puede aprender a esquivarla.
  //
  // Sale **antes** del límite de frecuencia: el cubo de una IP real no tiene por
  // qué pagar por la existencia de la trampa, y un bot que la rellena ya está
  // descartado.
  if (String(formData.get("website") ?? "").trim() !== "") {
    return { status: "success", message: CONFIRMATION, fieldErrors: {} };
  }

  // Plazo cerrado: primera comprobación del camino real y la más barata, porque
  // no se va a escribir nada y no tiene sentido gastar un intento de una IP real,
  // un captcha ni validaciones en un envío que ya está descartado. Va después del
  // campo trampa a propósito: un bot tiene que seguir viendo la misma
  // confirmación y no poder deducir de la respuesta que el plazo está cerrado.
  //
  // El valor vive en `Setting` y se lee aquí, no se hardcodea: la organización lo
  // abre y lo cierra desde `/admin` sin desplegar. Si la lectura falla no se dice
  // "cerradas" —eso afirmaría un estado que no se ha podido comprobar— sino que no
  // se ha podido registrar, y el motivo queda en el log con el prefijo `[db]`.
  let registrationOpen: boolean;

  try {
    registrationOpen = await readRegistrationOpen();
  } catch (error) {
    logDatabaseFailure("participar/plazo", error);

    return { status: "error", message: DATABASE_UNAVAILABLE_MESSAGE, fieldErrors: {} };
  }

  if (!registrationOpen) {
    return {
      status: "error",
      message: REGISTRATION_CLOSED_MESSAGE,
      fieldErrors: {},
    };
  }

  // El límite va antes que los validadores por lo que se ha dicho en la cabecera:
  // lo que se protege es el formulario, no solo la escritura. Si el cubo es el
  // compartido (la petición no traía IP identificable) el mensaje no señala a
  // nadie: se dice que hay saturación, no que el límite es por tu conexión.
  //
  // El contador vive en Postgres, así que un corte de la base lo tumba también. Se
  // captura para que el envío no acabe en un 500: se pide reintentar y se avisa en
  // el log, sin inventar un "demasiadas solicitudes" que sería falso.
  let rateLimit: Awaited<ReturnType<typeof consumePublicFormAttempt>>;

  try {
    rateLimit = await consumePublicFormAttempt();
  } catch (error) {
    logDatabaseFailure("participar/rate-limit", error);

    return { status: "error", message: DATABASE_UNAVAILABLE_MESSAGE, fieldErrors: {} };
  }

  if (!rateLimit.allowed) {
    return {
      status: "error",
      message:
        rateLimit.scope === "global" ? RATE_LIMIT_GLOBAL_MESSAGE : RATE_LIMIT_MESSAGE,
      fieldErrors: {},
    };
  }

  // Captcha. Sin secret key esto sale `skipped` y no se llama a nadie, así que en
  // desarrollo el flujo es el de siempre. No se manda `remoteip`: el módulo lo
  // acepta, pero la única IP fiable aquí es la de `x-forwarded-for`, que es la
  // misma que un atacante puede rotar, y atar el token a un valor que no es una
  // identidad no añade nada.
  const captcha = await verifyTurnstile(readTurnstileToken(formData));

  if (!captcha.ok) {
    if (!captcha.skipped) {
      console.error("[participar] Captcha no superado:", captcha.reason ?? "sin motivo");
    }

    return { status: "error", message: CAPTCHA_MESSAGE, fieldErrors: {} };
  }

  const profileIdRaw = String(formData.get("profileId") ?? "").trim();
  const nameRaw = String(formData.get("name") ?? "").trim();
  const emailRaw = String(formData.get("email") ?? "").trim();
  const twitchRaw = String(formData.get("twitchChannel") ?? "").trim();
  const youtubeRaw = String(formData.get("youtubeChannel") ?? "").trim();
  const kickRaw = String(formData.get("kickChannel") ?? "").trim();

  const profileId = parseProfileId(profileIdRaw);
  const name = parseName(nameRaw);
  const contactEmail = parseEmail(emailRaw);
  const twitchChannel = parseTwitchChannel(twitchRaw);
  const youtubeChannel = parseYoutubeChannel(youtubeRaw);
  const kickChannel = parseKickChannel(kickRaw);

  const fieldErrors: RegistrationFormState["fieldErrors"] = {};

  if (profileId === null) {
    fieldErrors.profileId =
      "El Profile ID de AoE4World debe ser un número.";
  }

  if (name === null) {
    // El parser no distingue "vacío" de "demasiado largo"; el texto sí puede.
    fieldErrors.name = nameRaw
      ? "El nombre no puede superar los 64 caracteres."
      : "El nombre es obligatorio.";
  }

  // El correo es obligatorio y, a diferencia del canal, aquí no hay "opcional"
  // detrás: o hay uno al que escribir o no se inscribe. El parser devuelve `null`
  // tanto para un vacío como para uno con forma de correo pero inválido, así que
  // son los tres textos los que distinguen los casos.
  if (contactEmail === null) {
    fieldErrors.email = !emailRaw
      ? EMAIL_REQUIRED_ERROR
      : emailRaw.length > CONTACT_EMAIL_MAX_LENGTH
        ? EMAIL_TOO_LONG_ERROR
        : EMAIL_INVALID_ERROR;
  }

  if (twitchChannel === null && twitchRaw !== "") {
    fieldErrors.twitchChannel =
      "El canal de Twitch solo admite letras, números y guion bajo, de 3 a 25 caracteres.";
  }

  // YouTube y Kick, con el mismo criterio de opcionales que el de Twitch: vacío es
  // `null` y no pasa nada; un valor que no vale es un error de su campo. La URL
  // antigua `/c/…` y `/user/…` de YouTube tiene su propio texto porque el motivo
  // concreto ayuda mucho más que "no vale": lo que hay que escribir es el @nombre.
  if (youtubeChannel === null && youtubeRaw !== "") {
    fieldErrors.youtubeChannel = isLegacyYoutubeUrl(youtubeRaw)
      ? YOUTUBE_LEGACY_URL_ERROR
      : YOUTUBE_INVALID_ERROR;
  }

  if (kickChannel === null && kickRaw !== "") {
    fieldErrors.kickChannel = KICK_INVALID_ERROR;
  }

  // Casilla de aceptación: se exige marcada y no se persiste, porque no es un
  // dato del jugador sino una condición del formulario.
  if (!formData.get("terms")) {
    fieldErrors.terms = "Tienes que aceptar las bases para inscribirte.";
  }

  // Los tres `null` ya han metido su error de campo; se repiten aquí porque es
  // lo que estrecha los tipos a `number` y `string` para lo que viene después.
  if (
    profileId === null ||
    name === null ||
    contactEmail === null ||
    Object.keys(fieldErrors).length > 0
  ) {
    return {
      status: "error",
      message: "Revisa los campos marcados para completar la inscripción.",
      fieldErrors,
    };
  }

  // El país es el único campo cuya validación necesita **leer** algo: la lista de
  // los que admite el torneo está en `Setting`, y es lo que hace que se pueda
  // cambiar sin desplegar. Va después de los campos que no la necesitan y antes de
  // la comprobación de la fila previa, por el orden de coste que lleva el resto de
  // la acción: primero lo gratis, y ninguna escritura ni ninguna llamada a la API
  // hasta que todo lo que se puede comprobar gratis está comprobado.
  let countries: string[];

  try {
    countries = await readCountries();
  } catch (error) {
    // Sin lista no hay contra qué validar, y validar contra `DEFAULT_COUNTRIES` en
    // silencio escribiría el país de una lista que la organización puede haber
    // cambiado: es el mismo criterio que el contador de frecuencia más arriba. "No
    // hay lista publicada" sí tiene su lista por defecto (es el estado normal, de
    // antes de sembrar); "no se ha podido leer" no la tiene, y no se puede
    // distinguir una cosa de otra con un `null`. Se pide reintentar y el motivo se
    // queda en el log del servidor.
    logDatabaseFailure("participar/paises", error);

    return { status: "error", message: DATABASE_UNAVAILABLE_MESSAGE, fieldErrors: {} };
  }

  // El país es obligatorio y no hay "opcional" detrás, así que los dos `null` del
  // parser (un vacío y un valor que no está en la lista) son dos mensajes
  // distintos, igual que con el correo.
  const countryRaw = String(formData.get("country") ?? "").trim();
  const country = parseCountry(countryRaw, countries);

  if (country === null) {
    return {
      status: "error",
      message: "Revisa los campos marcados para completar la inscripción.",
      fieldErrors: {
        country: countryRaw ? COUNTRY_UNKNOWN_ERROR : COUNTRY_REQUIRED_ERROR,
      },
    };
  }

  // Solo la lectura a la base va dentro del `try`: si falla, no se crea nada y se
  // pide reintentar. Lo que viene después (la comprobación del perfil en
  // AoE4World) tiene su propio tratamiento y su propio mensaje.
  let existing: { id: string; status: PlayerStatus } | null;

  try {
    existing = await db.player.findUnique({
      where: { profileId },
      select: { id: true, status: true },
    });
  } catch (error) {
    logDatabaseFailure("participar/duplicado", error);

    return { status: "error", message: DATABASE_UNAVAILABLE_MESSAGE, fieldErrors: {} };
  }

  // Solo se reinscribe desde `REJECTED`. Los otros dos estados son un cierre: o la
  // persona ya está en la liga, o su solicitud está esperando y mandarle otra
  // vez no cambiaría nada.
  if (existing !== null && existing.status !== PlayerStatus.REJECTED) {
    return {
      status: "error",
      message: DUPLICATE_FAILED_MESSAGE,
      fieldErrors: { profileId: DUPLICATE_PROFILE_ERROR },
    };
  }

  // Última capa antes de escribir: el perfil tiene que existir en AoE4World. Es
  // la única que sale a la red, y va después de las comprobaciones gratis.
  const profile = await checkAoe4WorldProfile(profileId);

  if (profile.status === "not-found") {
    return {
      status: "error",
      message: "Revisa el Profile ID de AoE4World.",
      fieldErrors: { profileId: UNKNOWN_PROFILE_ERROR },
    };
  }

  if (profile.status === "unavailable") {
    // Fallo nuestro o de la API, no del formulario: no se escribe nada y se pide
    // reintentar. El motivo se queda en el log; el mensaje no dice si fue un 429
    // ni un timeout.
    console.error(
      `[participar] No se ha podido comprobar el perfil ${profileId}:`,
      profile.reason,
    );

    return { status: "error", message: PROFILE_UNAVAILABLE_MESSAGE, fieldErrors: {} };
  }

  // El país del perfil ya está y el rótulo canónico del elegido también, así que
  // esta es la primera y la única vez que se pueden comparar. Va aquí, después de
  // las dos capas anteriores, porque necesita las dos cosas: el rótulo de
  // `parseCountry` y la respuesta de AoE4World.
  //
  // Es un error **de campo** y no un rechazo de la inscripción, y por eso solo
  // devuelve el mensaje del desplegable: la persona puede corregirlo y volver a
  // enviar. La lista admitida es la misma que se usó para resolver el campo, y no
  // `DEFAULT_COUNTRIES`, porque es la que se está aplicando de verdad.
  const countryConflict = findCountryIsoConflict({
    aoe4WorldCountry: profile.country,
    selectedCountry: country,
    allowed: countries,
  });

  if (countryConflict !== null) {
    return {
      status: "error",
      message: "Revisa los campos marcados para completar la inscripción.",
      fieldErrors: { country: countryMismatchMessage(countryConflict) },
    };
  }

  const outcome = await persistRegistration({
    existing,
    profileId,
    name,
    contactEmail,
    country,
    twitchChannel,
    youtubeChannel,
    kickChannel,
    aoe4WorldName: profile.name,
    avatarUrl: profile.avatarUrl,
  });

  if (outcome === "duplicate") {
    return {
      status: "error",
      message: DUPLICATE_FAILED_MESSAGE,
      fieldErrors: { profileId: DUPLICATE_PROFILE_ERROR },
    };
  }

  if (outcome === "failed") {
    return { status: "error", message: FAILED_MESSAGE, fieldErrors: {} };
  }

  revalidatePath("/admin");
  revalidatePath("/admin/jugadores");

  return { status: "success", message: CONFIRMATION, fieldErrors: {} };
}
