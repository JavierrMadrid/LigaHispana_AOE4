/**
 * Contrato del paso de Discord entre el servidor y el formulario de `/participar`.
 *
 * Vive en un módulo aparte y sin `server-only`, como el contrato de Turnstile
 * (`src/lib/turnstile-contract.ts`), porque lo necesitan los dos lados: el servidor
 * lee la cookie y resuelve el vínculo (`readDiscordStep()`, en `session.ts`), y el
 * componente cliente solo necesita **saber qué pintar**. Si el tipo viviera junto al
 * lector, importarlo desde el cliente arrastraría el módulo de servidor entero al
 * grafo del bundle, que es justo lo que `server-only` impide.
 *
 * ## Lo que viaja y lo que no
 *
 * Viajan cuatro datos, y son los cuatro que hacen falta para pintar el paso:
 *
 * - `configured`: si el OAuth está configurado. Con `false` **no hay botón**: es la
 *   degradación de F12 y el mismo patrón que el captcha sin `TURNSTILE_SECRET_KEY`.
 * - `linkedUsername`: el nombre de usuario de la cuenta conectada, o `null` si no hay
 *   ninguna. **Nunca el `userId`**: no lo necesita nada del lado del cliente (el
 *   formulario no manda Discord, la Server Action vuelve a leer la cookie) y sería un
 *   identificador de una cuenta ajena en el `payload` de RSC. Llega en la **forma
 *   canónica de la columna, sin arroba y en minúsculas** (`pepito`), porque el callback
 *   normaliza antes de firmar la cookie; quien lo pinte tiene que enseñarlo como se
 *   escribe —`@pepito`—, porque eso es lo que la persona reconoce, y esa decisión es de
 *   la interfaz, no del servidor.
 * - `joined`: si el bot pudo meter a la persona en el servidor. Con `false` y con
 *   invitación configurada, el formulario enseña la invitación como respaldo; es el
 *   caso en el que el auto-unión falló pero la inscripción se aceptó igual.
 * - `inviteUrl`: la invitación al servidor (`DISCORD_INVITE_URL`), o `null` si no se ha
 *   definido. Sin ella y sin unión no hay nada que enseñar, y eso también es un
 *   contrato: quien pinte tiene que poder distinguir "no se pudo unir" de "no hay
 *   invitación de respaldo".
 */
export type DiscordStep = {
  /** ¿Hay paso de Discord que exigir y que pintar? Sin esto, el paso no existe. */
  configured: boolean;
  /**
   * Nombre de usuario de la cuenta conectada **sin arroba** (`pepito`), o `null` si no
   * hay ninguna. Quien lo pinte enseña `@pepito`.
   */
  linkedUsername: string | null;
  /** `true` solo si el bot la metió en el servidor. */
  joined: boolean;
  /** Invitación de respaldo, o `null` si no se ha configurado ninguna. */
  inviteUrl: string | null;
};

/**
 * El paso tal y como está cuando no hay nada que exigir ni que pintar.
 *
 * Es un valor constante y no un objeto nuevo en cada lectura porque se compara y se
 * pasa tal cual al componente cliente: que sea siempre la misma referencia evita que
 * un Server Component que se re-renderiza por otra razón empuje un `payload` nuevo
 * sin motivo.
 */
export const PASO_DISCORD_INACTIVO: DiscordStep = {
  configured: false,
  linkedUsername: null,
  joined: false,
  inviteUrl: null,
};
