import "server-only";

import type { PrismaClient } from "@/generated/prisma/client";
import type { ObjectKind } from "@/generated/prisma/enums";
import { db } from "@/lib/db";
import { postChannelMessage } from "@/lib/discord/channel";
import { getDiscordConfig, isDiscordAnnounceConfigured, type DiscordConfig } from "@/lib/discord/env";
import { createDiscordHttpClient } from "@/lib/discord/http";
import { OBJECT_CATALOG } from "@/lib/objects";

/**
 * Los avisos de **objetos utilizables** al canal de Discord (issue 134).
 *
 * Tres momentos: el premio nuevo (lo llama el worker al crear la fila), el
 * lanzamiento y el cumplimiento de la desventaja (los llaman las Server Actions del
 * panel). El texto se compone en funciones **puras** (`newObjectAwardAnnouncementText()`,
 * `objectThrowAnnouncementText()`, `objectFulfillmentAnnouncementText()`) para poder
 * probarlo sin base ni red; aquí solo quedan la lectura de nombres y el envío.
 *
 * ## Degradación
 *
 * Sin `DISCORD_BOT_TOKEN` o sin `DISCORD_ANNOUNCE_CHANNEL_ID` no se manda nada y no
 * falla: es el mismo criterio que el resto de avisos del torneo. Tampoco falla si la
 * base o Discord contestan mal: cada función pública envuelve todo en `try`/`catch` y
 * deja el motivo en `console.warn`. Un aviso no puede tumbar la acción del panel ni
 * una pasada del worker.
 *
 * ## Sin menciones
 *
 * Los mensajes llevan nombres que escribe una persona, así que se envían con
 * `suppressMentions`: un `@` en un nombre de jugador no puede acabar pingueando al
 * servidor. No se menciona al rol de participante: un objeto no es un aviso del
 * torneo que todo el mundo tenga que atender.
 */

/** Cliente con lo que necesitan estos avisos: el premio, sus lanzamientos y los nombres. */
export type ObjectAnnouncementsClient = Pick<
  PrismaClient,
  "objectAward" | "objectThrow" | "player"
>;

/** Opciones comunes: la configuración de Discord y el cliente se inyectan en tests. */
export type ObjectAnnouncementOptions = {
  config?: DiscordConfig;
  client?: ObjectAnnouncementsClient;
};

/* -------------------------------------------------------------------------- */
/* Textos: puros y probados sin base                                           */
/* -------------------------------------------------------------------------- */

/** Cómo se nombra a alguien sin ficha: el jugador de un premio antiguo borrado. */
const MISSING_PLAYER_LABEL = "un participante";

/** Qué se dice cuando el `penaltyId` guardado ya no está en el catálogo. */
const UNKNOWN_PENALTY_TEXT = "desventaja no reconocida en el catálogo.";

/** El nombre del jugador, o una fórmula de respaldo si la fila ya no existe. */
function playerLabel(name: string | null | undefined): string {
  return name === null || name === undefined || name === "" ? MISSING_PLAYER_LABEL : name;
}

/**
 * El texto de la desventaja, resuelto contra el catálogo.
 *
 * Devuelve `null` si el `penaltyId` no está: el premio se guarda con su id y el
 * catálogo puede cambiar de redacción (o perder una entrada), y el aviso no puede
 * inventarse un texto.
 */
export function objectPenaltyText(kind: ObjectKind, penaltyId: string): string | null {
  return OBJECT_CATALOG[kind].penalties.find((penalty) => penalty.id === penaltyId)?.text ?? null;
}

/**
 * La probabilidad de devolución tal y como se lee en el canal: un porcentaje entero
 * (`12 %`).
 *
 * Se redondea porque la probabilidad es una proporción de puestos y el decimal no
 * aporta nada a quien lee el aviso; el valor exacto queda en `ObjectThrow.roll` y en
 * el mensaje del panel, que sí lo necesita.
 */
export function formatReturnProbability(probability: number): string {
  return `${Math.round(probability * 100)} %`;
}

/**
 * Un premio recién creado, con lo mínimo para avisarlo.
 *
 * Es la forma que devuelve `syncDailyObjectAwards()`: el nombre del ganador no viene
 * en la fila y se resuelve aquí.
 */
export type NewObjectAward = {
  kind: ObjectKind;
  /** `Player.id` del ganador. */
  winnerId: string;
  /** Id de la desventaja que le tocó; el texto sale del catálogo. */
  penaltyId: string;
};

/** Datos del aviso de premio nuevo, ya con el nombre resuelto. */
export type NewObjectAwardAnnouncement = {
  kind: ObjectKind;
  /** Nombre del ganador, o `null` si su fila ya no existe. */
  winnerName: string | null;
  /** Id de la desventaja que le tocó; el texto sale del catálogo. */
  penaltyId: string;
};

/**
 * El aviso de un premio recién creado: objeto, ganador, motivo y desventaja.
 *
 * El motivo (`obtainedBy`) sale del catálogo, no de la partida: es la regla con la
 * que se gana ese objeto, que es lo que un participante necesita saber para entender
 * por qué le ha tocado.
 */
export function newObjectAwardAnnouncementText(input: NewObjectAwardAnnouncement): string {
  const definition = OBJECT_CATALOG[input.kind];
  const penalty = objectPenaltyText(input.kind, input.penaltyId) ?? UNKNOWN_PENALTY_TEXT;

  return `Objeto nuevo: «${definition.name}» para ${playerLabel(input.winnerName)}, por ${definition.obtainedBy}. Desventaja: ${penalty}`;
}

/** Datos del aviso de lanzamiento. */
export type ObjectThrowAnnouncement = {
  kind: ObjectKind;
  /** Nombre del portador que lanza, o `null` si su fila ya no existe. */
  fromName: string | null;
  /** Nombre del jugador que recibe el lanzamiento, o `null` si su fila ya no existe. */
  toName: string | null;
  /** `true` = se devolvió y el objeto sigue en el lanzador. */
  returned: boolean;
  /** Probabilidad de devolución que se aplicó. */
  probability: number;
  /** Id de la desventaja que viaja con el objeto; el texto sale del catálogo. */
  penaltyId: string;
};

/**
 * El aviso de un lanzamiento: quién se lo tira a quién, con qué probabilidad, qué ha
 * pasado y qué desventaja lleva el objeto.
 *
 * La probabilidad se enseña siempre, se devuelva o no: es lo que explica por qué el
 * objeto se ha quedado o ha viajado, y el panel no tiene que repetir esa frase. La
 * desventaja se recuerda porque el portador cambia y quien lee tiene que saber qué
 * carga le acaba de llegar.
 */
export function objectThrowAnnouncementText(input: ObjectThrowAnnouncement): string {
  const definition = OBJECT_CATALOG[input.kind];
  const from = playerLabel(input.fromName);
  const to = playerLabel(input.toName);
  const penalty = objectPenaltyText(input.kind, input.penaltyId) ?? UNKNOWN_PENALTY_TEXT;
  const outcome = input.returned
    ? `Se ha devuelto: el objeto sigue en manos de ${from}.`
    : `No se ha devuelto: el objeto pasa a manos de ${to}.`;

  return `Objeto lanzado: «${definition.name}» de ${from} a ${to}, con un ${formatReturnProbability(input.probability)} de probabilidad de devolución. ${outcome} Desventaja: ${penalty}`;
}

/** Datos del aviso de desventaja cumplida. */
export type ObjectFulfillmentAnnouncement = {
  kind: ObjectKind;
  /** Nombre del portador que la cumple, o `null` si su fila ya no existe. */
  holderName: string | null;
  /** Id de la desventaja cumplida; el texto sale del catálogo. */
  penaltyId: string;
};

/**
 * El aviso de una desventaja cumplida: objeto, portador y desventaja superada.
 *
 * No nombra la partida: lo que le importa a quien lee es que el jugador vuelve a
 * puntuar, y el `gameId` de una partida concreta no le dice nada sin abrir la web.
 */
export function objectFulfillmentAnnouncementText(input: ObjectFulfillmentAnnouncement): string {
  const definition = OBJECT_CATALOG[input.kind];
  const penalty = objectPenaltyText(input.kind, input.penaltyId) ?? UNKNOWN_PENALTY_TEXT;

  return `Objeto cumplido: «${definition.name}» en manos de ${playerLabel(input.holderName)}. Desventaja superada: ${penalty} La partida con la que se cumple vuelve a puntuar.`;
}

/* -------------------------------------------------------------------------- */
/* Envío                                                                       */
/* -------------------------------------------------------------------------- */

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : `Error desconocido: ${String(error)}`;
}

/**
 * Los nombres de una lista de ids, en una consulta.
 *
 * Un id sin fila no está en el mapa y el texto cae en `MISSING_PLAYER_LABEL`: el
 * premio sobrevive al borrado de un jugador, así que puede nombrar a alguien que ya
 * no está.
 */
async function readPlayerNames(
  client: ObjectAnnouncementsClient,
  ids: readonly string[],
): Promise<Map<string, string>> {
  const unique = [...new Set(ids)];

  if (unique.length === 0) {
    return new Map();
  }

  const players = await client.player.findMany({
    where: { id: { in: unique } },
    select: { id: true, name: true },
  });

  return new Map(players.map((player) => [player.id, player.name]));
}

/**
 * Manda un mensaje al canal, sin menciones.
 *
 * Quien llama ya ha comprobado que el canal está configurado y ha estrechado el tipo
 * con `isDiscordAnnounceConfigured()`.
 */
async function postAnnouncement(
  config: DiscordConfig & { botToken: string; announceChannelId: string },
  content: string,
): Promise<void> {
  const client = createDiscordHttpClient(config);

  await postChannelMessage(client, config, content, { suppressMentions: true });
}

/**
 * Avisa de los premios **recién creados** por el worker.
 *
 * Recibe las filas que devolvió `syncDailyObjectAwards()` (solo las nuevas) y manda un
 * mensaje por premio. Sin canal configurado, sin premios o con un fallo de la base, no
 * hace nada: la pasada del worker sigue igual.
 */
export async function announceNewObjectAwards(
  awards: readonly NewObjectAward[],
  options: ObjectAnnouncementOptions = {},
): Promise<void> {
  if (awards.length === 0) {
    return;
  }

  try {
    const config = options.config ?? getDiscordConfig();

    if (!isDiscordAnnounceConfigured(config)) {
      return;
    }

    const client = options.client ?? db;
    const names = await readPlayerNames(
      client,
      awards.map((award) => award.winnerId),
    );

    for (const award of awards) {
      const content = newObjectAwardAnnouncementText({
        kind: award.kind,
        winnerName: names.get(award.winnerId) ?? null,
        penaltyId: award.penaltyId,
      });

      await postAnnouncement(config, content);
    }
  } catch (error) {
    console.warn(`[objetos] No se han podido avisar los premios nuevos: ${toErrorMessage(error)}`);
  }
}

/**
 * Avisa de un lanzamiento resuelto.
 *
 * El lanzador y el objetivo salen del `ObjectThrow` más reciente del premio: la fila
 * de `ObjectAward` ya guarda al portador **nuevo** cuando el objeto no se devuelve, así
 * que leerla no diría quién lo tiró.
 */
export async function announceObjectThrow(
  input: { awardId: string; returned: boolean; probability: number },
  options: ObjectAnnouncementOptions = {},
): Promise<void> {
  try {
    const config = options.config ?? getDiscordConfig();

    if (!isDiscordAnnounceConfigured(config)) {
      return;
    }

    const client = options.client ?? db;
    const [award, lastThrow] = await Promise.all([
      client.objectAward.findUnique({
        where: { id: input.awardId },
        select: { kind: true, penaltyId: true },
      }),
      client.objectThrow.findFirst({
        where: { awardId: input.awardId },
        orderBy: [{ at: "desc" }, { id: "desc" }],
        select: { fromId: true, toId: true },
      }),
    ]);

    if (award === null || lastThrow === null) {
      return;
    }

    const names = await readPlayerNames(client, [lastThrow.fromId, lastThrow.toId]);
    const content = objectThrowAnnouncementText({
      kind: award.kind,
      fromName: names.get(lastThrow.fromId) ?? null,
      toName: names.get(lastThrow.toId) ?? null,
      returned: input.returned,
      probability: input.probability,
      penaltyId: award.penaltyId,
    });

    await postAnnouncement(config, content);
  } catch (error) {
    console.warn(`[objetos] No se ha podido avisar el lanzamiento: ${toErrorMessage(error)}`);
  }
}

/**
 * Avisa de que una desventaja se ha dado por cumplida.
 *
 * Lee el premio ya actualizado: la desventaja es la suya y el portador sigue siendo
 * quien la cumple, porque cumplir no cambia de manos el objeto.
 */
export async function announceObjectFulfillment(
  input: { awardId: string },
  options: ObjectAnnouncementOptions = {},
): Promise<void> {
  try {
    const config = options.config ?? getDiscordConfig();

    if (!isDiscordAnnounceConfigured(config)) {
      return;
    }

    const client = options.client ?? db;
    const award = await client.objectAward.findUnique({
      where: { id: input.awardId },
      select: { kind: true, penaltyId: true, holderId: true },
    });

    if (award === null || award.holderId === null) {
      return;
    }

    const names = await readPlayerNames(client, [award.holderId]);
    const content = objectFulfillmentAnnouncementText({
      kind: award.kind,
      holderName: names.get(award.holderId) ?? null,
      penaltyId: award.penaltyId,
    });

    await postAnnouncement(config, content);
  } catch (error) {
    console.warn(`[objetos] No se ha podido avisar el cumplimiento: ${toErrorMessage(error)}`);
  }
}
