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
 *
 * Este módulo **no importa nada**: vive también en el bundle del cliente
 * (`registration-form.tsx` saca de aquí `CONTACT_EMAIL_MAX_LENGTH` para el
 * `maxLength` del campo), así que nada de lo que añada puede tirar de la base de
 * datos. Lo que necesita leer `Setting` —la lista de países admitidos— lo recibe
 * quien llama, ya resuelto.
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

/** Marcas diacríticas que deja `normalize("NFD")` debajo de cada letra acentuada. */
const COMBINING_MARKS = /[\u0300-\u036f]/g;

/**
 * Reduce un nombre de país a la forma en la que se puede **comparar** con otro:
 * sin tildes, sin mayúsculas y con los espacios de fuera quitados.
 *
 * Existe por un caso concreto y real: una persona puede elegir bien su país en el
 * desplegable y escribirlo distinto en un formulario que no lo tenía —"Republica
 * Dominicana" sin tilde, " PUERTO RICO " con espacios de los dos lados— y en ese
 * caso el valor no está mal, está escrito de otra manera. Tratar eso como un
 * rechazo sería una respuesta falsa a algo que era correcto.
 *
 * ## Lo que se dobla: diacríticos, no letras
 *
 * La `ñ` también se dobla, porque en Unicode es una `n` con tilde encima, y por lo
 * mismo que la `á`: "Espana" resuelve a "España" y "Panama" a "Panamá". Una letra
 * sin tilde nunca se convierte en otra. Y ser más generoso de aquí **no** puede
 * guardar un país inventado, porque lo único que se puede devolver es un rótulo que
 * esté en la lista: en el peor caso se acepta el que la persona quería escribir. Y
 * como el campo es un desplegable, el valor sale de la lista por construcción y esto
 * solo decide qué se acepta en un `FormData` hecho a mano.
 *
 * ## Por qué el `NFC` previo no sobra
 *
 * Sin él, el resultado dependería de **cómo** se escribió la `ñ`: `ñ` (U+00F1) y una
 * `n` con tilde encima son la misma letra escrita de dos maneras, y solo la primera
 * se descompone. Normalizar a `NFC` antes de quitar las marcas deja un único
 * resultado por texto, en vez de uno que dependa de si quien escribió el fichero usó
 * una cosa u otra.
 *
 * ## Por qué vive aquí y no en el módulo de países
 *
 * Porque `src/lib/countries.ts` necesita **el mismo criterio** para detectar que una
 * lista guardada trae dos veces el mismo país, y duplicar la comparación en dos
 * sitios haría que un día una reconociera "Colombia" y "colombia" y la otra no: la
 * lista y el formulario dejarían de hablar el mismo idioma. Este módulo es el que
 * no importa nada (lo usa también el cliente), así que es el sitio donde un criterio
 * compartido no arrastra la base de datos.
 *
 * No decide nada: solo compara. El rótulo que se guarda es el de la lista.
 */
export function foldCountryName(value: string): string {
  return value
    .trim()
    .normalize("NFC")
    .normalize("NFD")
    .replace(COMBINING_MARKS, "")
    .toLowerCase();
}

/**
 * País: devuelve el **rótulo canónico** de la lista admitida, o `null`.
 *
 * La lista llega como parámetro y no se lee de aquí a propósito: el módulo que la
 * guarda en `Setting` es de servidor y este se usa también en el cliente. Quien
 * llama la lee una vez y se la pasa a las dos validaciones de la acción, que es lo
 * que garantiza que el desplegable del formulario y esta validación ofrezcan los
 * mismos países.
 *
 * Es el único parser que devuelve algo distinto de lo que se escribió, y es
 * deliberado: de la lista admitida solo se puede devolver un rótulo que esté en
 * ella, y ese es el que se guarda en `Player.country`. Guardar "españa" en vez de
 * "España" haría que el mismo país tuviera dos formas en la tabla y que agrupar
 * por él dejara de funcionar en cuanto alguien escribiera distinto.
 *
 * Como el resto, devuelve `null` sin decir por qué: un vacío (el campo es
 * opcional en el alta de admin) y un valor que no está en la lista (no se admite)
 * son dos cosas distintas, y quien llama las distingue mirando el valor crudo.
 */
export function parseCountry(
  value: FormDataEntryValue | null,
  allowed: readonly string[],
): string | null {
  const escrito = foldCountryName(String(value ?? ""));

  if (escrito === "") {
    return null;
  }

  for (const country of allowed) {
    if (foldCountryName(country) === escrito) {
      return country;
    }
  }

  return null;
}
