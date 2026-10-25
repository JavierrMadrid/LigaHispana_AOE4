/**
 * Avisos de las acciones de administración (issue 56, fase 4).
 *
 * ## Qué avisa
 *
 * Solo la **baja de un participante** (`deletePlayer`, `PLAYER_REMOVED`), la acción
 * que quita algo del torneo y cambia lo que ve todo el mundo. Las actuaciones
 * administrativas (expulsiones, anulaciones y reversiones) tienen su propio módulo
 * (`src/lib/admin-acts.ts` y `src/lib/admin-act-notice-send.ts`) porque llevan razón
 * pública y tienen que anunciarse siempre, no solo cuando se quita algo.
 *
 * No avisa de deshacer una acción ni de aprobar o rechazar: ni quitan nada ni son
 * noticia para nadie. Si algún día hiciera falta avisar de otra, es una rama más aquí
 * y no un aviso suelto en la acción.
 *
 * ## Dos mensajes, independientes
 *
 * Por cada baja salen hasta dos mensajes: uno **privado** a la persona afectada y uno
 * **global** al canal de avisos. Son independientes: que no se pueda mandar uno no
 * impide el otro (ver `adminNoticePlan()`). Los textos viven aquí y no en la acción
 * porque son lo que se decide según la acción y **el estado del jugador**, y eso es
 * justo lo que no se puede pintar a ojo en el sitio del cambio.
 *
 * ## El matiz de la baja: PENDING no es «participante»
 *
 * Quien se da de baja puede no haber entrado nunca al torneo: una solicitud `PENDING`
 * (o ya `REJECTED`) que se descarta no es «se le ha retirado del torneo». Por eso la
 * baja tiene **dos redacciones** —«retirado del torneo» solo cuando el estado era
 * `APPROVED` o `BANNED`, y «solicitud descartada» cuando no— y la decisión está en
 * `playerRemovedIsParticipant()`, pura y probada.
 *
 * Este módulo es puro: no importa `db`, `server-only` ni la API de Discord, así que se
 * prueba entero sin base de datos ni red. Quien resuelve las cuentas y envía es
 * `src/lib/admin-notice-send.ts`.
 */

/** La única acción que avisa desde este módulo. */
export type AdminNoticeKind = "player-removed";

/**
 * El estado del jugador, solo como texto.
 *
 * Es una unión de literales y no el enum de Prisma (`PlayerStatus`) para que este módulo
 * siga siendo puro y no arrastre el cliente generado; el enum de Prisma es asignable a
 * esta unión sin conversión.
 */
export type RemovedPlayerStatus = "PENDING" | "APPROVED" | "REJECTED" | "BANNED";

/** Baja de participante. */
export type PlayerRemovedNotice = {
  kind: "player-removed";
  editionName: string;
  name: string;
  /** Estado que tenía la fila **antes** de borrarse. */
  status: RemovedPlayerStatus;
  /** Partidas clasificatorias que se han borrado con la fila. */
  matchCount: number;
};

/** Un aviso, con lo que hace falta para redactarlo. */
export type AdminNotice = PlayerRemovedNotice;

/* -------------------------------------------------------------------------- */
/* La decisión                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * ¿La baja era de un participante de verdad, o de una solicitud?
 *
 * Solo un `APPROVED` había entrado al torneo; un `PENDING` es una solicitud que se
 * descarta y un `REJECTED` una que ya lo estaba. El texto no puede decir «se le ha
 * retirado del torneo» de quien nunca entró, y por eso la decisión vive aquí y no en la
 * frase.
 */
export function playerRemovedIsParticipant(status: RemovedPlayerStatus): boolean {
  return status === "APPROVED" || status === "BANNED";
}

/** Qué mensajes se pueden mandar, según lo que haya configurado y resoluble. */
export type AdminNoticePlan = {
  /** Mensaje privado a la persona afectada. */
  dm: boolean;
  /** Mensaje al canal de avisos. */
  channel: boolean;
};

/**
 * Qué avisos se pueden mandar.
 *
 * Sin **token del bot** no se puede mandar nada: es la credencial de las dos llamadas.
 * A partir de ahí los dos mensajes son **independientes**: el privado necesita una
 * **cuenta resoluble** de la persona, y el global necesita un **canal**. Faltando uno,
 * el otro sigue saliendo. No es un fallo en ningún caso: es una acción interactiva, y lo
 * único que pasa es que no se avisa.
 */
export function adminNoticePlan(input: {
  hasToken: boolean;
  hasAccount: boolean;
  hasChannel: boolean;
}): AdminNoticePlan {
  if (!input.hasToken) {
    return { dm: false, channel: false };
  }

  return { dm: input.hasAccount, channel: input.hasChannel };
}

/* -------------------------------------------------------------------------- */
/* Los textos                                                                  */
/* -------------------------------------------------------------------------- */

/** El cierre de contexto que se le da a la persona en el privado. */
const DM_FOOTER = "Si crees que es un error, habla con la organización.";

/**
 * El mensaje **global**, para el canal de avisos.
 *
 * Corto y sin decir **quién** lo hizo: quien lo hizo ya está en el historial del panel.
 * `url` es el dominio público, o `null`: si no hay, el mensaje sale sin la coletilla del
 * enlace en vez de con una dirección inventada.
 *
 * La baja cambia de redacción según el estado: «retirado del torneo» para un
 * `APPROVED` o un `BANNED`, y «solicitud descartada» para lo demás (ver
 * `playerRemovedIsParticipant()`).
 */
export function adminNoticeChannelText(notice: AdminNotice, url: string | null): string {
  const enlace = url === null ? "" : ` Más información: ${url}`;

  if (!playerRemovedIsParticipant(notice.status)) {
    return `${notice.editionName}: la solicitud de ${notice.name} ha sido descartada.${enlace}`;
  }

  const partidas =
    notice.matchCount === 0
      ? ""
      : notice.matchCount === 1
        ? " Su partida clasificatoria deja de contar."
        : ` Sus ${notice.matchCount} partidas clasificatorias dejan de contar.`;

  return `${notice.editionName}: ${notice.name} ha sido retirado del torneo.${partidas}${enlace}`;
}

/**
 * El mensaje **privado**, para la persona afectada.
 *
 * Habla en segunda persona y cierra con la invitación a reclamar. No lleva el enlace:
 * quien lo recibe ya es de la casa y el mensaje tiene que caber en una frase.
 */
export function adminNoticeDmText(notice: AdminNotice): string {
  if (!playerRemovedIsParticipant(notice.status)) {
    return `${notice.editionName}: tu solicitud de inscripción ha sido descartada. ${DM_FOOTER}`;
  }

  return `${notice.editionName}: se te ha retirado del torneo. ${DM_FOOTER}`;
}
