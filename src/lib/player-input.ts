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
 * Handle de YouTube: 3 a 30 caracteres de `[A-Za-z0-9._-]`.
 *
 * El rango es el que publica YouTube para los handles y **no** el de un nombre de
 * canal de Twitch: son dos plataformas con reglas propias, y por eso hay dos
 * patrones en vez de uno compartido.
 */
const YOUTUBE_HANDLE = /^[a-zA-Z0-9._-]{3,30}$/;

/**
 * Slug de Kick: 3 a 25 caracteres en minúsculas, más restrictivo que el de YouTube
 * porque es lo que acepta la propia URL del canal (`kick.com/<slug>`).
 */
const KICK_SLUG = /^[a-z0-9._-]{3,25}$/;

/**
 * Prefijos de las URLs de YouTube que **no** contienen el handle.
 *
 * `/c/<nombre>` y `/user/<nombre>` son las dos formas antiguas: el identificador
 * del canal es un `UC…` y el handle no se puede deducir de ahí sin preguntar a la
 * API (`channels.list` no acepta esos nombres). Adivinarlos sería inventar un
 * canal, así que se rechazan con un motivo explícito para que el formulario pueda
 * decir "usa el @nombre del canal" en vez de un "el valor no es válido" que no
 * explica nada.
 */
const YOUTUBE_URL_SIN_HANDLE = /^(?:https?:\/\/)?(?:[\w-]+\.)*youtube\.com\/(?:c|user)\//i;

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
 * ¿Lo que se ha escrito es una URL antigua de canal de YouTube?
 *
 * Existe para que los dos formularios puedan decir algo útil: `/c/…` y `/user/…`
 * no llevan el handle dentro, así que `parseYoutubeChannel` las rechaza igual que
 * cualquier otra cosa inválida, pero el motivo que le importa a quien está
 * escribiendo no es "esto no vale" sino "esto no lleva el @nombre". Sin esta
 * pregunta, el formulario solo podría ofrecer el mismo texto para un `/c/` y para
 * un nombre con una barra.
 */
export function isLegacyYoutubeUrl(value: FormDataEntryValue | null): boolean {
  return YOUTUBE_URL_SIN_HANDLE.test(String(value ?? "").trim());
}

/**
 * Canal de YouTube: el handle canónico, **sin arroba** y en minúsculas.
 *
 * Acepta a propósito tres formas porque las tres se teclean en la práctica: el
 * `@nombre` que dice el propio canal, la URL del canal (`youtube.com/@nombre`,
 * con o sin `https://` y con o sin `www.`) y la URL de un directo o de una pestaña
 * del canal, que es la misma con `/live`, `/streams` o `/videos` detrás. Lo que se
 * guarda es siempre el handle pelado: es la forma que consume `forHandle` de la
 * API de YouTube y la que se compone en la URL del enlace, así que guardarlo con
 * arroba o con la URL obligaría a recortarlo en cada uso.
 *
 * **Las URLs `/c/…` y `/user/…` se rechazan a propósito**, no por prudencia
 * regexp sino porque no hay forma de llegar al handle sin una llamada a la API: el
 * identificador del canal es un `UC…` que no lo contiene. Aceptarlas guardando el
 * trozo de la URL produciría un canal que no existe, y probarlo ya es trabajo de
 * una pasada por cada participante. Quien las escriba recibe el motivo con
 * `isLegacyYoutubeUrl()` y el formulario le pide el `@nombre`.
 *
 * Un canal vacío y uno inválido devuelven ambos `null`, como en el de Twitch: el
 * campo es opcional y quien llama los distingue mirando el valor crudo.
 */
export function parseYoutubeChannel(value: FormDataEntryValue | null) {
  const raw = String(value ?? "").trim();

  if (!raw) {
    return null;
  }

  // Si el valor parece una URL de YouTube se lee el handle de dentro, que es el
  // caso largo (con esquema o sin él, con `www.` o sin él, y con `/live`,
  // `/streams` o un `?sub_confirmation=1` detrás). Si no, lo que se ha escrito es
  // el handle a secas y solo hay que quitarle la arroba.
  const fromUrl = raw.match(/youtube\.com\/@([A-Za-z0-9._-]{3,30})/i);
  const handle = (fromUrl === null ? raw : fromUrl[1]).replace(/^@/, "");

  if (!handle) {
    return null;
  }

  return YOUTUBE_HANDLE.test(handle) ? handle.toLowerCase() : null;
}

/**
 * Canal de Kick: el slug canónico, en minúsculas y sin esquema.
 *
 * Acepta el slug suelto y la URL (`kick.com/slug`, con o sin `https://` y con o
 * sin `www.`). No necesita un motivo especial para las formas antiguas: Kick no
 * tuvo nombres de canal antes del slug, así que una URL que no sea
 * `kick.com/<algo>` no es un canal y no hay de dónde sacarlo.
 *
 * El rango es más corto que el de YouTube (25 frente a 30) porque es lo que admite
 * la URL del canal, y los caracteres son los mismos en minúsculas: son las reglas
 * de la plataforma, no una decisión de este repositorio.
 */
export function parseKickChannel(value: FormDataEntryValue | null) {
  const raw = String(value ?? "").trim();

  if (!raw) {
    return null;
  }

  const fromUrl = raw.match(/kick\.com\/([a-z0-9._-]{3,25})/i);
  const slug = fromUrl === null ? raw : fromUrl[1];

  if (!slug) {
    return null;
  }

  // El patrón es de minúsculas y el valor puede venir con mayúsculas (`Kick.com/`),
  // así que la comprobación y el guardado usan la misma forma canónica: validar una
  // cosa y guardar otra dejaría filas que el enlace no puede resolver.
  const canonical = slug.toLowerCase();

  return KICK_SLUG.test(canonical) ? canonical : null;
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
