/**
 * El dominio público del sitio, de una sola fuente.
 *
 * Vive aparte de `src/app/layout.tsx` porque lo necesitan dos sitios que no se hablan:
 * el layout, para las rutas absolutas de las imágenes para compartir y los canónicos, y
 * los avisos del bot (`src/lib/standings-report.ts`), para el enlace a la web que
 * acompaña al informe diario. Tenerlo dos veces sería tener dos dominios en cuanto uno
 * de los dos se tocara.
 *
 * ## De dónde sale, y por capas
 *
 * `NEXT_PUBLIC_SITE_URL` manda cuando está definida (dominio propio, con protocolo). Si
 * no, se usa `VERCEL_PROJECT_PRODUCTION_URL`, que Vercel inyecta en tiempo de build. Son
 * variables de **build** —`NEXT_PUBLIC_*` las sustituye Next por un literal al
 * compilar—, así que se leen con `process.env` directo y no con `readRuntimeEnv()`
 * (ver `src/lib/runtime-env.ts`): en el Worker no son bindings, son un valor incrustado.
 *
 * ## Las dos formas
 *
 * `readSiteUrl()` devuelve un `URL` y **cae a `localhost`** cuando no hay nada
 * configurado: es lo que necesita el layout para que el build y el desarrollo local no
 * se rompan. `readPublicOrigin()` devuelve solo el origen (`https://laligahispana.es`) y
 * **`null` cuando no hay dominio configurado**: para un mensaje que lee una persona,
 * `localhost` no es un enlace a ninguna parte, así que quien lo use debe degradar sin
 * enlace en vez de publicar una dirección inventada.
 */

/** El respaldo de desarrollo, solo para el `URL` del layout. */
export const SITE_URL_FALLBACK = "http://localhost:3000";

/**
 * El dominio del sitio como `URL`, con respaldo a `localhost`.
 *
 * Se evalúa al importar el módulo, o sea en `next build`: son variables de build, no de
 * runtime. Es el comportamiento que ya tenía `layout.tsx`.
 */
export function readSiteUrl(): URL {
  const configured = process.env.NEXT_PUBLIC_SITE_URL;
  if (configured) {
    return new URL(configured);
  }

  const vercelProduction = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  if (vercelProduction) {
    return new URL(`https://${vercelProduction}`);
  }

  return new URL(SITE_URL_FALLBACK);
}

/**
 * El origen público del sitio para un enlace, o `null` si no hay dominio configurado.
 *
 * A diferencia de `readSiteUrl()` **no cae a `localhost`**: un informe que se publica en
 * Discord no puede mandar a nadie a `localhost`, y "no hay enlace" es más honesto que una
 * dirección que solo funciona en la máquina de quien despliega. La resolución es la
 * misma por capas; solo cambia el último escalón.
 */
export function readPublicOrigin(): string | null {
  const configured = process.env.NEXT_PUBLIC_SITE_URL;

  if (configured) {
    try {
      return new URL(configured).origin;
    } catch {
      return null;
    }
  }

  const vercelProduction = process.env.VERCEL_PROJECT_PRODUCTION_URL;

  if (vercelProduction) {
    try {
      return new URL(`https://${vercelProduction}`).origin;
    } catch {
      return null;
    }
  }

  return null;
}
