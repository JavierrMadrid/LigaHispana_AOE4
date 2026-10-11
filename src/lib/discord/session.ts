import "server-only";

import { cookies } from "next/headers";

import { PASO_DISCORD_INACTIVO, type DiscordStep } from "./contract";
import { DISCORD_LINK_TTL_SECONDS, getDiscordConfig, isDiscordOAuthConfigured } from "./env";
import { DISCORD_LINK_COOKIE, verifyDiscordLink } from "./link";

/**
 * Estado del paso de Discord tal y como lo necesita el formulario de `/participar`.
 *
 * Se lee aquí y no en la página porque es lógica —verifica una firma, decide si el
 * paso existe— y la regla del repositorio es que eso vive en `src/lib/` y no en un
 * componente. La página solo la llama y se pasa el resultado.
 *
 * **La cookie se verifica dos veces** en el camino de una inscripción: aquí, para
 * pintar, y otra vez en `registerPlayer`, para escribir. No es un descuido de ahorro:
 * la página es pública y su salida es el `payload` de RSC, que es caché del navegador
 * y puede guardarse en la página durante más tiempo que los veinte minutos de la
 * cookie. Lo que se guarda en la base de datos solo puede venir de una verificación
 * hecha **en el momento de escribir**, que es la capa que de verdad decide. Por eso el
 * `userId` ni siquiera viaja al cliente.
 *
 * Una cookie que no verifica sale como paso configurado **sin** cuenta conectada, que
 * es exactamente lo mismo que no haberla hecho: quien llega al formulario después de
 * veinte minutos ve el botón, no un error.
 */
export async function readDiscordStep(): Promise<DiscordStep> {
  const config = getDiscordConfig();

  if (!isDiscordOAuthConfigured(config)) {
    return PASO_DISCORD_INACTIVO;
  }

  const cookieStore = await cookies();
  const verificado = verifyDiscordLink(
    cookieStore.get(DISCORD_LINK_COOKIE)?.value,
    config.linkSecret,
    DISCORD_LINK_TTL_SECONDS,
  );

  if (!verificado.ok) {
    return {
      configured: true,
      linkedUsername: null,
      joined: false,
      inviteUrl: config.inviteUrl,
    };
  }

  return {
    configured: true,
    linkedUsername: verificado.link.username,
    joined: verificado.link.joined,
    inviteUrl: config.inviteUrl,
  };
}
