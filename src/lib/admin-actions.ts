import "server-only";

import { Prisma } from "@/generated/prisma/client";
import { AdminActionType } from "@/generated/prisma/enums";

/**
 * Rastro de lo que hace una persona administradora del panel.
 *
 * Vive fuera de las Server Actions (`src/app/admin/actions.ts`) por dos motivos:
 *
 * - **El formato del texto se decide una vez.** `AdminAction.summary` es una línea en
 *   español que la pestaña de acciones pinta **tal cual**, sin joins y sin montar la
 *   frase en el cliente. Si el modelo de cada frase viviera en la acción, la interfaz
 *   tendría que adivinarlo, y en cuanto las dos veces se desviaran (un nombre con
 *   comillas, un número en cualquiera de los dos sitios) el historial empezaría a
 *   mentir.
 * - **El registro va en la misma transacción que el cambio.** Por eso el helper recibe
 *   el cliente en vez de usar el `db` del módulo: quien llama lo invoca con la
 *   transacción del propio cambio (`db.$transaction((tx) => …)`) y así, o se
 *   escriben las dos cosas, o no se escribe ninguna.
 *
 * ## Por qué hay un tipo por acción
 *
 * El enum (`AdminActionType`) es corto a propósito: registra lo que **alguien más ve**
 * —un jugador entra o sale, una partida deja de contar o vuelve a contar—. Editar
 * nombre, canales o país también cambia lo que ve el resto (el nombre y el canal salen
 * en la clasificación, en `/partidas` y en el propio panel), así que también está.
 * Aprobar o rechazar una solicitud no está, y por eso tampoco hay tipo: cuando la
 * pestaña de acciones lo necesite se añade el valor al enum y el `switch` de este
 * módulo deja de ser exhaustivo solo, que es lo que evita que un tipo nuevo salga con
 * una frase inventada.
 *
 * ## El texto de cada tipo
 *
 * | Tipo | Frase |
 * |---|---|
 * | `PLAYER_CREATED` | `Alta de BeastWizard (AoE4World 123456)` |
 * | `PLAYER_EDITED` | `Edición de BeastWizard (AoE4World 123456): nombre, canal de Twitch` |
 * | `PLAYER_REMOVED` | `Baja de BeastWizard y sus 87 partidas` |
 * | `MATCH_POINTS_REVERTED` | `Revertidos 10 puntos de la partida G-12345 de BeastWizard` |
 * | `MATCH_POINTS_RESTORED` | `Restaurados 10 puntos de la partida G-12345 de BeastWizard` |
 *
 * En las dos últimas el nombre del jugador va al final y no escondido en `details`:
 * es la parte que se lee, y un historial de "G-12345" a secas obligaría a ir al filtro
 * de la pestaña de partidas para saber de quién era. Una partida de 0 puntos (una
 * derrota) produce "Revertidos 0 puntos…", que es la verdad: no puntuaba, y aun así
 * sale de las partidas, de los ratios y de los objetivos.
 *
 * `PLAYER_EDITED` lleva **qué campos** cambiaron en la frase y no solo el jugador, por
 * la misma razón: "Edición de BeastWizard" sin más no dice qué se editó, que es justo
 * lo que se viene a mirar cuando alguien pregunta por qué un participante aparece con
 * otro nombre o con otro canal. Los rótulos son los mismos que usa el mensaje de la
 * propia acción (`camposQueCambian()` en `src/app/admin/actions.ts`), así que el
 * historial y lo que se le enseñó a quien editó no pueden divergir.
 *
 * Los tipos se escriben como literales y no como `AdminActionType.X` porque el enum
 * generado es a la vez un valor (objeto) y un tipo (unión de literales), y en una
 * posición de tipo solo vale la segunda forma. El `switch` sí compara contra los
 * valores del enum, que son esos mismos literales.
 */

/** Alta de jugador. */
type PlayerCreatedEntry = {
  type: "PLAYER_CREATED";
  /** `Player.name`: el nombre de display que se ha escrito. */
  name: string;
  profileId: number;
  /** Estado con el que se ha creado, tal como se envió (`APPROVED`…). */
  status: string;
};

/** Baja de jugador, con cuántas partidas caen con ella. */
type PlayerRemovedEntry = {
  type: "PLAYER_REMOVED";
  name: string;
  profileId: number;
  /** Filas de `Match` que tenía: se borran en cascada con el jugador. */
  matchCount: number;
};

/**
 * Un campo que la edición ha cambiado.
 *
 * Los rótulos son los del formulario (`camposQueCambian()`), no los de la columna, en
 * la frase; el `details` es donde van los nombres de la columna, porque es lo que
 * sirve para investigar y lo que permite escribir una consulta sin traducir.
 */
export type CampoEditado = {
  /** Columna de `Player`: `name`, `twitchChannel`… Es la clave del `details`. */
  campo: string;
  /** Lo que el formulario llama a esa columna, para la frase del historial. */
  etiqueta: string;
  /** Valor anterior, o `null` si el campo estaba vacío. */
  antes: string | null;
  /** Valor nuevo, o `null` si la edición lo ha dejado vacío. */
  despues: string | null;
};

/** Edición de un jugador que ya estaba en el panel. */
type PlayerEditedEntry = {
  type: "PLAYER_EDITED";
  /**
   * `Player.name` **tal como queda** tras la edición.
   *
   * Es el nombre nuevo a propósito: el rastro describe el estado que se ve desde
   * entonces, que es lo que se nota al mirar la clasificación. El anterior no se
   * pierde, está en `details`.
   */
  name: string;
  profileId: number;
  /**
   * Solo los campos que han cambiado, nunca los cinco, y **siempre al menos uno**.
   *
   * Que no esté vacío es lo que decide si hace falta escribir la fila: abrir el
   * formulario y cerrarlo sin tocar nada es lo más normal del mundo y no deja rastro
   * de nada. `updatePlayer()` sale antes de escribir cuando la lista viene vacía, así
   * que una frase sin campos ("Edición de X: ") no llega a existir en la base.
   */
  cambios: CampoEditado[];
};

/** Cambio de los puntos de una partida, en las dos direcciones. */
type MatchPointsEntry = {
  type: "MATCH_POINTS_REVERTED" | "MATCH_POINTS_RESTORED";
  playerName: string;
  profileId: number;
  gameId: string;
  /**
   * Puntos que aporta la partida: los que tenía antes de revertirla, o los que
   * recupera al deshacer el revert.
   */
  points: number;
};

/** Lo que hay que saber de una acción, según su tipo. */
export type AdminActionEntry =
  | PlayerCreatedEntry
  | PlayerEditedEntry
  | PlayerRemovedEntry
  | MatchPointsEntry;

/** `1 punto` y `0 puntos`: el plural no es un detalle de estilo en un historial. */
export function puntos(count: number): string {
  return count === 1 ? "1 punto" : `${count} puntos`;
}

/** La parte que comparten los dos tipos de partida. */
function deLaPartida(entry: MatchPointsEntry): string {
  return `de la partida ${entry.gameId} de ${entry.playerName}`;
}

/**
 * La frase de una acción, en la forma en que se pinta.
 *
 * El `switch` es exhaustivo sobre el enum y no tiene `default`: si mañana aparece un
 * tipo nuevo, el compilador obliga a decidir aquí su frase en vez de dejar que salga
 * una por defecto que valdría para todo.
 */
export function adminActionSummary(entry: AdminActionEntry): string {
  switch (entry.type) {
    case AdminActionType.PLAYER_CREATED:
      return `Alta de ${entry.name} (AoE4World ${entry.profileId})`;
    case AdminActionType.PLAYER_EDITED:
      return `Edición de ${entry.name} (AoE4World ${entry.profileId}): ${entry.cambios
        .map((cambio) => cambio.etiqueta)
        .join(", ")}`;
    case AdminActionType.PLAYER_REMOVED:
      if (entry.matchCount === 0) {
        return `Baja de ${entry.name}, que no tenía partidas`;
      }

      return entry.matchCount === 1
        ? `Baja de ${entry.name} y su 1 partida`
        : `Baja de ${entry.name} y sus ${entry.matchCount} partidas`;
    case AdminActionType.MATCH_POINTS_REVERTED:
      return `Revertidos ${puntos(entry.points)} ${deLaPartida(entry)}`;
    case AdminActionType.MATCH_POINTS_RESTORED:
      return `Restaurados ${puntos(entry.points)} ${deLaPartida(entry)}`;
  }
}

/**
 * Los mismos datos, estructurados, en `AdminAction.details`.
 *
 * No se lee para pintar el historial (eso es `summary`): es para el que tenga que
 * investigar por qué una partida concreta está marcada, y por eso lleva los
 * identificadores (`profileId`, `gameId`) y no solo los nombres.
 */
export function adminActionDetails(entry: AdminActionEntry): Prisma.InputJsonObject {
  switch (entry.type) {
    case AdminActionType.PLAYER_CREATED:
      return { name: entry.name, profileId: entry.profileId, status: entry.status };
    case AdminActionType.PLAYER_EDITED: {
      // Una clave por campo y no un objeto anidado: el DAL aplana `details` a
      // primitivos de un nivel (`readDetails()` en `src/lib/admin.ts`), así que lo
      // anidado se descartaría al leer y no habría rastro utilizable. El nombre se
      // guarda aparte de los cambios porque es el estado **después**, y el `antes` de
      // cada campo va en su propia clave.
      //
      // `InputJsonObject` es de solo lectura (las claves son fijas en el tipo), así
      // que las claves por campo se montan en un objeto corriente y se devuelve al
      // final: solo estos valores entran, todos primitivos de primer nivel.
      const details: Record<string, string | number | null> = {
        name: entry.name,
        profileId: entry.profileId,
        campos: entry.cambios.map((cambio) => cambio.campo).join(","),
      };

      for (const cambio of entry.cambios) {
        details[`${cambio.campo}.antes`] = cambio.antes;
        details[`${cambio.campo}.despues`] = cambio.despues;
      }

      return details;
    }
    case AdminActionType.PLAYER_REMOVED:
      return { name: entry.name, profileId: entry.profileId, matchCount: entry.matchCount };
    case AdminActionType.MATCH_POINTS_REVERTED:
      return {
        playerName: entry.playerName,
        profileId: entry.profileId,
        gameId: entry.gameId,
        pointsBefore: entry.points,
        pointsAfter: 0,
      };
    case AdminActionType.MATCH_POINTS_RESTORED:
      return {
        playerName: entry.playerName,
        profileId: entry.profileId,
        gameId: entry.gameId,
        pointsBefore: 0,
        pointsAfter: entry.points,
      };
  }
}

/** Cliente con la única tabla que necesita escribir (`db` o una `tx`). */
export type AdminActionWriter = Pick<Prisma.TransactionClient, "adminAction">;

export type RecordAdminActionInput = AdminActionEntry & {
  /** Quién lo hizo: el `email` del usuario que pasó `requireAdmin()`. */
  actorEmail: string;
  /** `Player.id` o `Match.id` de la fila afectada. */
  targetId?: string | null;
};

/**
 * Escribe una fila de `AdminAction` y devuelve su `id`.
 *
 * Recibe el cliente para poder participar en la transacción de quien llama: es lo que
 * hace que el rastro y el cambio no puedan separarse. Devolver el `id` es porque la
 * compensación de un revert fallido necesita borrar **su** fila y solo la de ella
 * (ver `setMatchReverted` en `src/app/admin/actions.ts`).
 */
export async function recordAdminAction(
  client: AdminActionWriter,
  input: RecordAdminActionInput,
): Promise<string> {
  const row = await client.adminAction.create({
    data: {
      type: input.type,
      actorEmail: input.actorEmail,
      summary: adminActionSummary(input),
      targetId: input.targetId ?? null,
      details: adminActionDetails(input),
    },
    select: { id: true },
  });

  return row.id;
}
