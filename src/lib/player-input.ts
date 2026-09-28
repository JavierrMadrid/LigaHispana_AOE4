/**
 * Parseo de los campos de jugador que escriben los formularios: el alta manual
 * de `/admin/jugadores` y la inscripción pública de `/participar`.
 *
 * Vive fuera de las Server Actions para que las dos validen lo mismo. Si el
 * patrón del canal o el tope del nombre cambian, cambian a la vez, y el
 * formulario público no puede acabar aceptando algo que el panel no acepta.
 *
 * Cada parser devuelve `null` cuando el valor no vale, sin decir por qué: el
 * texto del error lo pone quien llama, que es quien sabe si el campo es
 * obligatorio u opcional y, por tanto, cómo se lee un `null`.
 */

const TWITCH_CHANNEL = /^[a-zA-Z0-9_]{3,25}$/;

/**
 * Tope del correo de contacto. 254 es el máximo de la parte "ruta" de una
 * dirección según RFC 5321; se exporta para que el formulario pueda ponerlo en
 * el `maxLength` del campo y así el navegador avise antes de enviar.
 */
export const CONTACT_EMAIL_MAX_LENGTH = 254;

/** Máximo de la parte local (RFC 5321). */
const EMAIL_LOCAL_MAX_LENGTH = 64;

/** Máximo de una etiqueta del dominio (`www`, `aoe4world`, `com`…). */
const EMAIL_LABEL_MAX_LENGTH = 63;

/**
 * Parte local en forma de *dot-atom* de RFC 5321: uno o más átomos separados por
 * puntos, sin punto inicial, final ni doble. Se rechazan las formas entre
 * comillas y con escapes porque no las usa nadie de verdad y aceptarlas sería
 * guardar una dirección que ningún servidor de correo va a interpretar igual.
 */
const EMAIL_LOCAL = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;

/** Etiqueta de dominio: alfanuméricos y guiones, sin guion en los extremos. */
const EMAIL_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;

/** La última etiqueta tiene que ser alfabética: así se descarta "a@b.c" o "a@b.1". */
const EMAIL_TLD = /^[A-Za-z]{2,}$/;

/** Identificador de perfil de AoE4World: solo dígitos y mayor que cero. */
export function parseProfileId(value: FormDataEntryValue | null) {
  const raw = String(value ?? "").trim();

  if (!/^\d+$/.test(raw)) {
    return null;
  }

  const profileId = Number(raw);

  return profileId > 0 ? profileId : null;
}

/** Nombre público: obligatorio y de 64 caracteres como mucho. */
export function parseName(value: FormDataEntryValue | null) {
  const name = String(value ?? "").trim();

  return name.length > 0 && name.length <= 64 ? name : null;
}

/**
 * Canal de Twitch: se le quita la arroba inicial y se guarda en minúsculas.
 *
 * Un canal vacío y uno inválido devuelven ambos `null` porque el campo es
 * opcional; quien llama los distingue mirando el valor crudo.
 */
export function parseTwitchChannel(value: FormDataEntryValue | null) {
  const channel = String(value ?? "").trim().replace(/^@/, "");

  if (!channel) {
    return null;
  }

  return TWITCH_CHANNEL.test(channel) ? channel.toLowerCase() : null;
}

/**
 * Correo de contacto: obligatorio en la inscripción pública y se guarda en
 * minúsculas.
 *
 * Solo lo usa hoy `/participar` (el alta de admin no lo pide, y por eso la
 * columna es nullable), pero vive aquí y no en la acción por la misma razón que
 * los otros: si el patrón cambia, cambian los dos sitios a la vez.
 *
 * **Por qué se guarda en minúsculas.** RFC 5321 dice que la parte local distingue
 * mayúsculas, pero ningún proveedor de correo las distingue y guardarlas en dos
 * formatos solo crea duplicados que después nadie sabe a cuál pertenece. Para
 * responder dudas da igual, así que se normaliza.
 *
 * La comprobación es deliberadamente conservadora: `null` significa "esto no es
 * una dirección que vayamos a escribir", y quien llama decide si eso es un campo
 * obligatorio o uno opcional.
 */
export function parseEmail(value: FormDataEntryValue | null): string | null {
  const email = String(value ?? "").trim();

  if (email.length === 0 || email.length > CONTACT_EMAIL_MAX_LENGTH) {
    return null;
  }

  // Se parte por la **última** arroba, que es la que separa el dominio. Con dos
  // o más, la parte local se queda con una arroba dentro y falla `EMAIL_LOCAL`,
  // así que el caso queda descartado sin una regla aparte.
  const at = email.lastIndexOf("@");

  if (at <= 0) {
    return null;
  }

  const local = email.slice(0, at);
  const domain = email.slice(at + 1);

  if (local.length > EMAIL_LOCAL_MAX_LENGTH || !EMAIL_LOCAL.test(local)) {
    return null;
  }

  const labels = domain.split(".");

  // Menos de dos etiquetas no es un dominio con TLD ("a@localhost"), y la última
  // tiene que ser alfabética: es lo que descarta "a@b.c" y "a@b.1".
  if (labels.length < 2 || !EMAIL_TLD.test(labels[labels.length - 1] ?? "")) {
    return null;
  }

  for (const label of labels) {
    if (label.length > EMAIL_LABEL_MAX_LENGTH || !EMAIL_LABEL.test(label)) {
      return null;
    }
  }

  return email.toLowerCase();
}
