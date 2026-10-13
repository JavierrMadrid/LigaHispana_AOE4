import type { CampoEditado } from "@/lib/admin-actions";
import {
  isLegacyYoutubeUrl,
  parseCountry,
  parseDiscordUsername,
  parseEmail,
  parseKickChannel,
  parseName,
  parseTwitchChannel,
  parseYoutubeChannel,
} from "@/lib/player-input";

/**
 * Los siete campos de `Player` que el panel escribe, con su validación en un solo
 * sitio.
 *
 * ## Por qué existe
 *
 * Tres acciones del panel escriben estos campos y las tres tienen que aceptar y
 * rechazar **lo mismo**: el alta (`createPlayer`), la edición (`updatePlayer`) y la
 * reversión de una edición (`revertAdminAction`). Las tres pasan por los mismos
 * parsers de `src/lib/player-input.ts`, pero con entradas distintas: un `FormData` en
 * las dos primeras y el valor **anterior** guardado en el rastro de `AdminAction` en
 * la tercera. Con la validación escrita dentro de cada acción, la reversión habría
 * nacido con una segunda copia del criterio **y de los textos**, y en cuanto una de
 * las dos se tocara el panel podría rechazar al deshacer algo que había aceptado al
 * editar.
 *
 * Aquí está el criterio una vez: el rótulo de cada campo (el que sale en el mensaje
 * y en el `summary` del rastro), el mensaje de cada error y el parser que decide.
 *
 * ## Lo que este módulo NO decide
 *
 * Ni cuándo se lee la lista de países ni qué hacer si no se puede leer: `parseCountry`
 * la recibe como parámetro porque el módulo que la guarda (`src/lib/countries.ts`) es
 * de servidor, y quien llama es el que sabe si ya tocaba leerla. Tampoco la unicidad
 * del `@usuario`: eso es una consulta a la base y vive en las acciones.
 *
 * ## Por qué el orden importa
 *
 * `PLAYER_FIELDS` está en el orden del formulario, no en el alfabético, y de ahí salen
 * el **primer** error que se enseña, el orden de los campos en el mensaje de la
 * edición y el de la frase del historial. El correo va detrás del nombre porque es un
 * dato de la persona y no un canal; el `@usuario` de Discord va al final porque es el
 * campo que más se toca por una regla (el alta y su corrección), y así se lee primero
 * lo que es el jugador y después su identidad en Discord.
 */

/**
 * Los siete campos editables, tal y como están en la fila.
 *
 * Los nombres son los de las columnas de `Player` y no los del formulario: son la
 * clave del `details` del rastro, y ahí lo que interesa es poder escribir una consulta
 * sin traducir.
 */
export type CamposEditables = {
  name: string;
  /**
   * Correo de contacto, que es `null` cuando no se sabe.
   *
   * A diferencia del `@usuario`, aquí sí admite `null` y el vacío lo escribe: el correo
   * es un dato de contacto que se puede no tener, y "no lo sabemos" es una información,
   * no una fila a medias. Es el mismo criterio que el país.
   */
  contactEmail: string | null;
  twitchChannel: string | null;
  youtubeChannel: string | null;
  kickChannel: string | null;
  country: string | null;
  /**
   * `@usuario` de Discord en su forma canónica (**sin arroba**).
   *
   * El tipo admite `null` porque las filas anteriores a F12 lo tienen así, pero
   * **ningún valor que salga de aquí es nulo**: el campo es obligatorio, y una fila sin
   * `@usuario` no se puede comprobar ni buscar en el servidor. Las filas antiguas se
   * editan escribiéndolo, y el panel no inventa datos.
   */
  discordUsername: string | null;
};

export type PlayerField = keyof CamposEditables;

/** Los siete campos en el orden del formulario. Ver el docblock del módulo. */
export const PLAYER_FIELDS = [
  "name",
  "contactEmail",
  "twitchChannel",
  "youtubeChannel",
  "kickChannel",
  "country",
  "discordUsername",
] as const satisfies readonly PlayerField[];

/**
 * Cómo se llama cada campo en un mensaje.
 *
 * Los rótulos son los del formulario y no los de la columna: son para leer, y el
 * nombre de la columna ya viaja en el `details`. Los comparten el mensaje de la
 * edición, el de la reversión y la frase del historial, así que lo que se le enseñó a
 * quien editó y lo que se lee después en `/admin/acciones` no pueden divergir.
 */
export const PLAYER_FIELD_LABELS: Record<PlayerField, string> = {
  name: "nombre",
  contactEmail: "correo de contacto",
  twitchChannel: "canal de Twitch",
  youtubeChannel: "canal de YouTube",
  kickChannel: "canal de Kick",
  country: "país",
  discordUsername: "usuario de Discord",
};

/**
 * Lo que un formulario trae de cada campo, ya recortado y **sin** el país.
 *
 * El país queda fuera a propósito: es el único que necesita leer `Setting` para
 * validarse, así que se resuelve aparte y solo cuando toca. El resto se valida sin
 * tocar la base, que es lo que permite descartar un envío mal escrito antes de pagar
 * ninguna lectura.
 */
export type PlayerFieldsInput = Record<Exclude<PlayerField, "country">, string>;

/**
 * Los seis campos que no necesitan leer nada, ya validados.
 *
 * El `name` y el `@usuario` vuelven a estar tipados como no nulos, y no es una
 * repetición: `parsePlayerField()` los **exige**, y sin decirlo aquí el `where` de una
 * consulta por `discordUsername` —que es único— no aceptaría el valor. Es la misma
 * garantía que da el parser, escrita donde el compilador la puede ver.
 */
export type PlayerFieldsWithoutCountry = Omit<CamposEditables, "country"> & {
  name: string;
  discordUsername: string;
};

/* -------------------------------------------------------------------------- */
/* Mensajes                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Los textos de cada error, en un solo sitio.
 *
 * Los comparten el alta, la edición y la reversión de una edición, por el mismo motivo
 * que el criterio: dos formularios del mismo panel que validan el mismo campo con las
 * mismas reglas no pueden explicarlo de dos maneras. Cada uno dice **qué** campo falla
 * y **cómo** se escribe bien, porque quien lo lee lo está corrigiendo.
 *
 * El país, el correo y los tres canales distinguen un vacío de un valor mal escrito:
 * un vacío es `null` ("no lo sabemos") y un valor escrito que no se puede guardar es un
 * error, no un `null` en silencio. Guardarlo como `null` diría "no tiene canal" cuando
 * lo que pasó es que lo que escribió no era un canal, y esas dos cosas son distintas
 * para quien después busca a un participante para enlazarlo.
 */
export const NAME_REQUIRED_ERROR = "El nombre es obligatorio (máx. 64 caracteres).";

export const TWITCH_INVALID_ERROR =
  "El canal de Twitch solo admite letras, números y guion bajo, de 3 a 25 caracteres.";

export const YOUTUBE_INVALID_ERROR =
  "Ese canal de YouTube no vale. Se puede escribir el @nombre del canal (3 a 30 letras, números, punto, guion o guion bajo) o la dirección del canal.";

export const YOUTUBE_LEGACY_URL_ERROR =
  "Esa dirección no lleva el @nombre del canal. Las URLs /c/ y /user/ no lo tienen, así que escribe el @nombre, que es lo que aparece en youtube.com/@nombre.";

export const KICK_INVALID_ERROR =
  "Ese canal de Kick no vale. Se puede escribir el nombre del canal o la dirección kick.com/nombre.";

export const EMAIL_INVALID_ERROR =
  "Ese correo no vale. Se puede escribir una dirección como nombre@correo.com, con algo antes y después de la arroba y el dominio acabando en una extensión de letras.";

export const COUNTRY_UNKNOWN_ERROR =
  "Ese país no está en la lista de los que admite el torneo. Elígelo en el desplegable o déjalo vacío.";

/**
 * El usuario de Discord es obligatorio, y se escribe **con la arroba**.
 *
 * Los dos mensajes del `@usuario` los comparten el alta, la edición y la reversión, por
 * el mismo motivo que los de los canales: los tres escriben el mismo campo con las
 * mismas reglas, y uno que enseñara a escribirlo de una manera y el otro aceptara otra
 * sería un panel que enseña algo falso.
 *
 * ## Por qué la arroba es obligatoria
 *
 * Porque en un servidor de Discord hay muchas cuentas con el mismo nombre y **el
 * `@usuario` es lo único único en todo el servicio**. Sin la arroba, lo que se
 * guardaría sería un nombre de display —algo que alguien se ha puesto dentro del
 * servidor y que no prueba nada—, y con él el worker no podría encontrar la cuenta ni
 * el alta podría chocar con otra por un nombre repetido. El parser
 * (`parseDiscordUsername()`) es el que lo exige, y lo que sale de ahí es el nombre
 * **sin** arroba, que es la forma en que se guarda.
 */
export const DISCORD_USERNAME_REQUIRED_ERROR =
  "El usuario de Discord es obligatorio: se escribe con su arroba, como @pepito.";

export const DISCORD_USERNAME_INVALID_ERROR =
  "Ese usuario de Discord no vale. Se escribe con la arroba y después de 2 a 32 letras, números, puntos o guiones bajos, como @pepito.";

/**
 * Ese `@usuario` ya está en la liga.
 *
 * `Player.discordUsername` es única, así que dos participantes no pueden tener el
 * mismo `@usuario`: si lo tuvieran, serían la misma cuenta escrita de dos maneras —el
 * alta de admin con lo que le dicen a la organización y la inscripción pública con lo
 * que resolvió Discord— y la organización no sabría a cuál de las dos filas hablarle.
 * Quien mira la fila pone este mensaje y, si lo sabe, **nombra a quien lo tiene**: aquí
 * corregir es inmediato.
 */
export const DISCORD_USERNAME_TAKEN_ERROR =
  "Ese usuario de Discord ya está en la liga. No puede haber dos participantes con el mismo @usuario.";

/* -------------------------------------------------------------------------- */
/* Validación campo a campo                                                    */
/* -------------------------------------------------------------------------- */

export type PlayerFieldParse = { ok: true; value: string | null } | { ok: false; error: string };

/**
 * Valida **un** campo, con el criterio del alta y la edición.
 *
 * `raw` es lo que hay que validar: lo que se ha escrito en un formulario o, al deshacer
 * una edición, el valor que tenía la fila antes. Un `null` y un `""` significan lo
 * mismo —el campo vacío— porque así es como llegan las dos cosas (un campo de
 * `FormData` que no se ha rellenado y un `null` guardado en el rastro).
 *
 * Devuelve el valor **canónico** que hay que escribir en la columna: el `@usuario` sin
 * arroba, los canales en minúsculas y el país con el rótulo de la lista admitida.
 *
 * `countries` solo se usa para el país, y quien llama decide qué lista le pasa: el
 * módulo que la guarda es de servidor y este tiene que poder correr sin base de datos.
 */
export function parsePlayerField(
  field: PlayerField,
  raw: string | null,
  countries: readonly string[],
): PlayerFieldParse {
  const value = raw ?? "";

  switch (field) {
    case "name": {
      const name = parseName(value);

      return name === null ? { ok: false, error: NAME_REQUIRED_ERROR } : { ok: true, value: name };
    }
    case "contactEmail": {
      const email = parseEmail(value);

      return email === null && value.trim() !== ""
        ? { ok: false, error: EMAIL_INVALID_ERROR }
        : { ok: true, value: email };
    }
    case "twitchChannel": {
      const channel = parseTwitchChannel(value);

      return channel === null && value.trim() !== ""
        ? { ok: false, error: TWITCH_INVALID_ERROR }
        : { ok: true, value: channel };
    }
    case "youtubeChannel": {
      const channel = parseYoutubeChannel(value);

      if (channel === null && value.trim() !== "") {
        return {
          ok: false,
          error: isLegacyYoutubeUrl(value) ? YOUTUBE_LEGACY_URL_ERROR : YOUTUBE_INVALID_ERROR,
        };
      }

      return { ok: true, value: channel };
    }
    case "kickChannel": {
      const channel = parseKickChannel(value);

      return channel === null && value.trim() !== ""
        ? { ok: false, error: KICK_INVALID_ERROR }
        : { ok: true, value: channel };
    }
    case "country": {
      const country = parseCountry(value, countries);

      return country === null && value.trim() !== ""
        ? { ok: false, error: COUNTRY_UNKNOWN_ERROR }
        : { ok: true, value: country };
    }
    case "discordUsername": {
      const username = parseDiscordUsername(value);

      if (username === null) {
        return {
          ok: false,
          error: value.trim() === "" ? DISCORD_USERNAME_REQUIRED_ERROR : DISCORD_USERNAME_INVALID_ERROR,
        };
      }

      return { ok: true, value: username };
    }
  }
}

export type PlayerFieldsParse =
  | { ok: true; campos: PlayerFieldsWithoutCountry }
  | { ok: false; error: string };

/**
 * Valida los seis campos que **no** necesitan leer nada, en el orden del formulario.
 *
 * Devuelve el primer error y solo ese: el formulario enseña un mensaje, no una lista.
 * El país no entra aquí porque su validación depende de la lista admitida, que es una
 * lectura de `Setting`: quien llama la hace (o no) cuando ya sabe que el resto vale, y
 * después valida el país por su cuenta.
 */
export function parsePlayerFieldsWithoutCountry(
  input: PlayerFieldsInput,
): PlayerFieldsParse {
  const valores: Record<Exclude<PlayerField, "country">, string | null> = {
    name: null,
    contactEmail: null,
    twitchChannel: null,
    youtubeChannel: null,
    kickChannel: null,
    discordUsername: null,
  };

  for (const field of PLAYER_FIELDS) {
    if (field === "country") {
      continue;
    }

    const parsed = parsePlayerField(field, input[field], []);

    if (!parsed.ok) {
      return { ok: false, error: parsed.error };
    }

    valores[field] = parsed.value;
  }

  // `name` y `discordUsername` los exige `parsePlayerField` —nunca devuelve `null`
  // para ellos—, así que el objeto cumple el tipo aunque el bucle no lo demuestre.
  return { ok: true, campos: valores as PlayerFieldsWithoutCountry };
}

/* -------------------------------------------------------------------------- */
/* Comparación                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Un cambio, o nada.
 *
 * Va en un array porque el orden de la comparación es el del formulario y no el
 * alfabético: es el orden en el que se leen los campos en el mensaje y en la frase del
 * historial.
 *
 * El `campo` es la columna y la `etiqueta` el rótulo, y el rastro necesita los dos: la
 * frase del historial lleva el rótulo y el `details` el nombre de la columna con el
 * valor de antes y el de después.
 */
export function campoSiCambia(
  antes: string | null,
  despues: string | null,
  campo: string,
  etiqueta: string,
): CampoEditado[] {
  return antes === despues ? [] : [{ campo, etiqueta, antes, despues }];
}

/**
 * Qué campos editables han cambiado de valor, con su rótulo y sus dos valores.
 *
 * Decide si hace falta escribir: si la lista sale vacía, los valores ya eran estos y no
 * hay nada que hacer. Abrir un formulario y cerrarlo sin tocar nada es lo más normal
 * del mundo y no puede dejar rastro.
 */
export function camposQueCambian(
  antes: CamposEditables,
  despues: CamposEditables,
): CampoEditado[] {
  return PLAYER_FIELDS.flatMap((field) =>
    campoSiCambia(antes[field], despues[field], field, PLAYER_FIELD_LABELS[field]),
  );
}
