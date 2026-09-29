import { defineCloudflareConfig } from "@opennextjs/cloudflare";

/**
 * Configuracion de OpenNext.
 *
 * Se versiona junto a `wrangler.jsonc` por el mismo motivo: si el archivo no
 * existe, `@opennextjs/cloudflare` lo crea durante el build y su contenido se
 * pierde en cada despliegue. Documentacion: https://opennext.js.org/cloudflare
 */
export default defineCloudflareConfig();
