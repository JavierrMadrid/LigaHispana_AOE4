/**
 * Banderas de país: del rótulo canónico que guarda el torneo a un fichero de
 * bandera servido por `flagcdn.com`.
 *
 * ## Por qué un diccionario aquí y no un código ISO en la base de datos
 *
 * `Player.country` guarda el **rótulo canónico** de la lista admitida
 * ("República Dominicana"), no un ISO: eso es lo que hace que la fila siga siendo
 * legible para quien mire la tabla y lo que evita migrar la base cada vez que la
 * organización retoca `paises.txt`. El precio es resolver ese rótulo a un código
 * de bandera en la interfaz, y eso es exactamente esta tabla.
 *
 * El único valor que se guarda es el rótulo, así que el diccionario va del
 * rótulo al ISO-2 en minúscula (el que espera `flagcdn.com`), nunca al revés: un
 * mismo país puede tener varias formas escritas, pero el rótulo canónico es uno.
 *
 * ## Cliente-seguro
 *
 * Este módulo **no importa nada** y no puede hacerlo: viaja al bundle del
 * navegador, porque lo consume la clasificación (`standings-table.tsx`, que es un
 * componente cliente). Por eso no reutiliza nada de `countries.ts`, que es
 * `server-only`, ni puede leer la lista sembrada en `Setting`.
 *
 * ## La trampa de los dos códigos
 *
 * `pr` es **Puerto Rico** y `do` es **República Dominicana**. Es el error clásico
 * de confundir el código con el nombre en español, y aquí pintaría la bandera de
 * un país en la fila de otro.
 *
 * ## Si la organización añade un país
 *
 * `paises.txt` (raíz del repositorio) es la fuente de verdad de la lista admitida
 * y se publica con `npm run countries:seed`. Cuando se añada un país allí, hay que
 * añadirlo **también aquí** con su ISO-2. Si no, `Player.country` guardará un
 * rótulo que esta tabla no conoce y la fila se pintará sin bandera, en silencio,
 * que es justo el fallo que hay que evitar. No hay comprobación automática porque
 * este módulo no puede leer ni la lista sembrada —vive en la base de datos— ni
 * `DEFAULT_COUNTRIES` —que es `server-only`—; lo que sí existe es
 * `npm run verify:sync`, que vigila que `paises.txt` y `DEFAULT_COUNTRIES` no
 * divergan.
 */
const ISO_BY_COUNTRY: Readonly<Record<string, string>> = {
  Colombia: "co",
  España: "es",
  Venezuela: "ve",
  Perú: "pe",
  Ecuador: "ec",
  Guatemala: "gt",
  Bolivia: "bo",
  Cuba: "cu",
  "República Dominicana": "do",
  Honduras: "hn",
  Paraguay: "py",
  "El Salvador": "sv",
  Nicaragua: "ni",
  "Costa Rica": "cr",
  Panamá: "pa",
  "Guinea Ecuatorial": "gq",
  "Antigua y Barbuda": "ag",
  México: "mx",
  Argentina: "ar",
  Chile: "cl",
  Uruguay: "uy",
  "Puerto Rico": "pr",
};

/**
 * URL de la bandera de un país, o `null` si no se puede resolver.
 *
 * `null` no es un error: el país llega a `null` en la fila cuando no lo sabemos,
 * y también puede ser un rótulo recién añadido a `paises.txt` que todavía no está
 * en la tabla de arriba. En los dos casos lo correcto es devolver `null` y que
 * quien pinte no dibuje nada: ni un recuadro roto ni una bandera inventada.
 *
 * Se pide `w40` (40 px de ancho) para que se vea nítida en pantallas 2x, donde el
 * navegador la reduce a la mitad; en 1x la reducción es a un cuarto y tampoco
 * pierde.
 */
export function countryFlagUrl(country: string | null): string | null {
  if (country === null) {
    return null;
  }

  // La anotación es deliberada: los datos no activan `noUncheckedIndexedAccess`,
  // así que sin ella el tipo del acceso sería `string` y no podría comprobarse la
  // clave ausente.
  const iso: string | undefined = ISO_BY_COUNTRY[country];

  if (iso === undefined) {
    return null;
  }

  return `https://flagcdn.com/w40/${iso}.png`;
}
