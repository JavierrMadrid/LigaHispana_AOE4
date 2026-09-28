"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { PlayerStatus } from "@/generated/prisma/enums";
import {
  CONTACT_EMAIL_MAX_LENGTH,
  parseEmail,
  parseName,
  parseProfileId,
  parseTwitchChannel,
} from "@/lib/player-input";
import { consumePublicFormAttempt } from "@/lib/rate-limit";
import { checkAoe4WorldProfile } from "@/lib/registration";
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
 * `twitchChannel` y `terms`. El correo es obligatorio desde F6 (está en
 * `Player.contactEmail`), así que el formulario tiene que mandar ese `input` con
 * ese nombre exacto.
 */
export type RegistrationFormState = {
  status: "idle" | "error" | "success";
  message: string | null;
  fieldErrors: {
    profileId?: string;
    name?: string;
    email?: string;
    twitchChannel?: string;
    terms?: string;
  };
};

/**
 * Confirmación de la inscripción. La comparten el envío real y el que cae en el
 * campo trampa, a propósito: un bot no debe poder distinguir uno del otro. La
 * comparte también la reinscripción de un `REJECTED`, porque para quien la manda
 * el resultado es el mismo: su solicitud vuelve a estar en la cola de revisión.
 */
const CONFIRMATION =
  "Solicitud recibida. La organización la revisa antes de que entres en la clasificación.";

const DUPLICATE_PROFILE_ERROR = "Ese perfil ya está registrado en la liga.";

const DUPLICATE_FAILED_MESSAGE = "No hemos podido completar la inscripción.";

const FAILED_MESSAGE =
  "No hemos podido guardar la inscripción. Inténtalo de nuevo en unos minutos.";

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

/** Lo que la escritura puede devolver. Ningún camino crea nada por la mitad. */
type WriteOutcome = "created" | "resubmitted" | "duplicate" | "failed";

type RegistrationInput = {
  /** Fila previa con el mismo `profileId`, o `null` si no había ninguna. */
  existing: { id: string; status: PlayerStatus } | null;
  profileId: number;
  name: string;
  contactEmail: string;
  twitchChannel: string | null;
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
          contactEmail: input.contactEmail,
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
        contactEmail: input.contactEmail,
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
    console.error(
      "[participar] No se ha podido registrar la solicitud:",
      error instanceof Error ? error.message : String(error),
    );

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
 *    igualmente.
 * 5. **Comprobación del perfil contra AoE4World** (`src/lib/registration.ts`): si
 *    el `profileId` no existe no se escribe nada, y si existe se guarda el nombre
 *    oficial en `aoe4WorldName` junto al de display, que es el que escribió
 *    quien se inscribe.
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

  // El límite va antes que los validadores por lo que se ha dicho en la cabecera:
  // lo que se protege es el formulario, no solo la escritura. Si el cubo es el
  // compartido (la petición no traía IP identificable) el mensaje no señala a
  // nadie: se dice que hay saturación, no que el límite es por tu conexión.
  const rateLimit = await consumePublicFormAttempt();

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

  const profileId = parseProfileId(profileIdRaw);
  const name = parseName(nameRaw);
  const contactEmail = parseEmail(emailRaw);
  const twitchChannel = parseTwitchChannel(twitchRaw);

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

  const existing = await db.player.findUnique({
    where: { profileId },
    select: { id: true, status: true },
  });

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

  const outcome = await persistRegistration({
    existing,
    profileId,
    name,
    contactEmail,
    twitchChannel,
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
