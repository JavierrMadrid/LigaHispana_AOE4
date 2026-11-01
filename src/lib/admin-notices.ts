/**
 * El plan de avisos de administración: qué mensajes de Discord se pueden mandar.
 *
 * Es la única pieza que comparten los avisos que quedan, las **actuaciones
 * administrativas** (`src/lib/admin-act-notice-send.ts`): sin token del bot no se
 * manda nada, y con token el privado necesita una cuenta resoluble y el global un
 * canal. Los textos de cada aviso viven con su aviso —los de una actuación, en
 * `src/lib/admin-acts.ts`— porque son los que dependen de lo que se ha decidido.
 *
 * Aquí ya **no hay texto propio**: la baja destructiva de un participante
 * (`deletePlayer`) se retiró con la issue 167 —retirar a alguien aprobado es una
 * actuación de expulsión— y con ella sus mensajes. `AdminActionType.PLAYER_REMOVED`
 * sigue en el enum solo para leer las filas históricas.
 *
 * Este módulo es puro: no importa `db`, `server-only` ni la API de Discord, así que se
 * prueba entero sin base de datos ni red.
 */

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
