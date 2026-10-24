/**
 * Actuaciones administrativas: los tipos, los textos y la validación **pura**.
 *
 * Una **actuación** es la unidad con la que la organización expulsa a un
 * participante, anula partidas ganadas o revierte actuaciones anteriores. Tiene una
 * sola acción, una razón pública (la que se anuncia) y, opcionalmente, información
 * privada (la que no sale del panel).
 *
 * Este módulo no toca la base de datos ni Discord a propósito: se puede probar entero
 * sin red ni entorno, y la regla de qué se dice en el aviso no depende de si el bot
 * está configurado. La escritura vive en `admin-act-service.ts` y el envío en
 * `admin-act-notice-send.ts`.
 *
 * ## La información privada no entra en los avisos
 *
 * Las firmas de `adminActChannelText()` y `adminActDmText()` reciben
 * `AdminActNoticeFields`, un tipo que **no tiene** `privateInfo`. No es una
 * comprobación en tiempo de ejecución: es imposible pasar el dato sin un `as`, así
 * que no se puede filtrar por descuido. El test lo fija con un `@ts-expect-error`.
 */

/** Tope de la razón pública obligatoria, en caracteres. */
export const ADMIN_ACT_PUBLIC_REASON_MAX_LENGTH = 600;

/** Tope de la información privada opcional, en caracteres. */
export const ADMIN_ACT_PRIVATE_INFO_MAX_LENGTH = 4000;

/**
 * Tope de un mensaje de Discord. Los mensajes de canal y de DM se truncan a esta
 * longitud para no ser rechazados por la API.
 */
export const ADMIN_ACT_DISCORD_MESSAGE_MAX_LENGTH = 2000;

/**
 * Cuántos caracteres antes del límite se acepta un espacio para cortar el mensaje por
 * palabra. Más lejos que esto, el hueco desperdiciado se nota más que la palabra
 * partida.
 */
const WORD_BOUNDARY_SLACK = 80;

/**
 * Los tipos de actuación, como unión local.
 *
 * Es asignable desde el enum de Prisma (`AdminActKind`) y evita que este módulo
 * arrastre el cliente generado, igual que `RemovedPlayerStatus` en
 * `admin-notices.ts`.
 */
export type AdminActKind = "BAN" | "MATCH_ANNULMENT" | "REVERSAL";

/** Los estados de un jugador que una actuación puede dejar escrito o restaurar. */
export type AdminActPlayerStatus = "PENDING" | "APPROVED" | "REJECTED" | "BANNED";

/** Los tres tipos en el orden en que se ofrecen en el panel. */
export const ADMIN_ACT_KINDS: readonly AdminActKind[] = ["BAN", "MATCH_ANNULMENT", "REVERSAL"];

/** Rótulo de cada tipo, para la interfaz. */
export const ADMIN_ACT_KIND_LABELS: Record<AdminActKind, string> = {
  BAN: "Expulsión",
  MATCH_ANNULMENT: "Anulación de partidas",
  REVERSAL: "Reversión de actuaciones",
};

/** El valor de la URL o del formulario, si es un tipo conocido. */
export function readAdminActKind(value: string | null | undefined): AdminActKind | null {
  return value === "BAN" || value === "MATCH_ANNULMENT" || value === "REVERSAL" ? value : null;
}

/**
 * ¿Se puede revertir una actuación de este tipo?
 *
 * Todo menos una reversión: una reversión es **final**. Devolver a la vida una
 * reversión dejaría dos actuaciones describiendo el mismo cambio y no hay forma de
 * saber cuál manda.
 */
export function isAdminActRevertible(kind: AdminActKind): boolean {
  return kind !== "REVERSAL";
}

/** Estado de una actuación: vigente, revertida o final. */
export type AdminActState = "active" | "reverted" | "final";

/**
 * El estado de una actuación, a partir de su tipo y de la marca de revertida.
 *
 * - `final`: es una reversión; nunca se revierte.
 * - `reverted`: otra actuación la deshizo.
 * - `active`: sigue vigente.
 */
export function adminActState(
  kind: AdminActKind,
  revertedAt: Date | string | null,
): AdminActState {
  if (kind === "REVERSAL") {
    return "final";
  }

  return revertedAt === null ? "active" : "reverted";
}

/* -------------------------------------------------------------------------- */
/* Resumen                                                                     */
/* -------------------------------------------------------------------------- */

export type AdminActSummaryInput = {
  kind: AdminActKind;
  playerName: string;
  /** Partidas anuladas; en una reversión, las afectadas por lo revertido. */
  matchCount?: number;
  /** Actuaciones revertidas; solo tiene sentido en una `REVERSAL`. */
  targetCount?: number;
};

/** «1 partida» / «N partidas». */
function partidas(count: number): string {
  return count === 1 ? "1 partida" : `${count} partidas`;
}

/** «1 actuación» / «N actuaciones». */
function actuaciones(count: number): string {
  return count === 1 ? "1 actuación" : `${count} actuaciones`;
}

/**
 * La frase de una actuación, ya redactada en español.
 *
 * Es la que se guarda en `AdminAct.summary` y la que el panel pinta tal cual, como
 * `adminActionSummary()`. No menciona la razón (esa vive en su columna) ni la
 * información privada: es el titular de la fila.
 */
export function adminActSummary(input: AdminActSummaryInput): string {
  switch (input.kind) {
    case "BAN":
      return `Expulsión de ${input.playerName}`;
    case "MATCH_ANNULMENT": {
      const count = input.matchCount ?? 0;

      return count === 0
        ? `Anulación de partidas de ${input.playerName}`
        : `Anulación de ${partidas(count)} de ${input.playerName}`;
    }
    case "REVERSAL": {
      const count = input.targetCount ?? 0;

      return count === 0
        ? `Reversión de actuaciones de ${input.playerName}`
        : `Reversión de ${actuaciones(count)} de ${input.playerName}`;
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Validación de la razón pública y de la información privada                  */
/* -------------------------------------------------------------------------- */

export type AdminActReasonsField = "publicReason" | "privateInfo";

export type AdminActReasonsResult =
  | { ok: true; publicReason: string; privateInfo: string | null }
  | { ok: false; field: AdminActReasonsField; error: string };

/** El mensaje de error de una razón pública vacía, compartido con el formulario. */
export const ADMIN_ACT_PUBLIC_REASON_REQUIRED =
  "La razón pública es obligatoria: es la que se anuncia a la persona y en el canal de avisos.";

/**
 * Valida la razón pública y la información privada y las normaliza.
 *
 * La razón pública es **obligatoria** y se recorta por los extremos; los saltos de
 * línea interiores se conservan porque el texto es multilínea. La información privada
 * es opcional: vacía o solo espacios se convierte en `null`, que es lo que significa
 * "no hay información privada".
 */
export function validateAdminActReasons(input: {
  publicReason: string;
  privateInfo?: string | null;
}): AdminActReasonsResult {
  const publicReason = input.publicReason.trim();

  if (publicReason === "") {
    return { ok: false, field: "publicReason", error: ADMIN_ACT_PUBLIC_REASON_REQUIRED };
  }

  if (publicReason.length > ADMIN_ACT_PUBLIC_REASON_MAX_LENGTH) {
    return {
      ok: false,
      field: "publicReason",
      error: `La razón pública no puede pasar de ${ADMIN_ACT_PUBLIC_REASON_MAX_LENGTH} caracteres.`,
    };
  }

  const privateInfo = (input.privateInfo ?? "").trim();

  if (privateInfo.length > ADMIN_ACT_PRIVATE_INFO_MAX_LENGTH) {
    return {
      ok: false,
      field: "privateInfo",
      error: `La información privada no puede pasar de ${ADMIN_ACT_PRIVATE_INFO_MAX_LENGTH} caracteres.`,
    };
  }

  return { ok: true, publicReason, privateInfo: privateInfo === "" ? null : privateInfo };
}

/* -------------------------------------------------------------------------- */
/* Avisos                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Lo que un aviso puede saber de una actuación.
 *
 * **No tiene `privateInfo`**, y no es un olvido: es la barrera de tipo que impide
 * mandarla a Discord. Si algún día el aviso necesitara otro dato, se añade aquí
 * después de decidir que puede ser público.
 */
export type AdminActNoticeFields = {
  kind: AdminActKind;
  /** Nombre de la edición, para que el mensaje se lea fuera de contexto. */
  editionName: string;
  playerName: string;
  publicReason: string;
  /** Partidas anuladas; en una reversión, total afectado. */
  matchCount?: number;
  /** Actuaciones revertidas (solo `REVERSAL`). */
  targetCount?: number;
  /** Resúmenes de las actuaciones revertidas (solo `REVERSAL`): son públicos. */
  targetSummaries?: readonly string[];
  /** Dominio público, o `null` si no hay: entonces el mensaje no inventa un enlace. */
  url?: string | null;
};

/**
 * Recorta un mensaje a lo que acepta Discord, sin partir una palabra si se puede.
 *
 * Discord rechaza el mensaje entero si pasa de 2000 caracteres, así que el aviso se
 * corta **antes** de enviarlo y se marca con puntos suspensivos. El corte busca el
 * último espacio anterior al límite y lo usa si queda a menos de
 * `WORD_BOUNDARY_SLACK` caracteres; si no hay ninguno razonablemente cerca (una URL
 * larga, por ejemplo), corta duro. El corte no afecta a lo que se guarda en la base.
 */
export function truncateAdminActMessage(
  text: string,
  limit: number = ADMIN_ACT_DISCORD_MESSAGE_MAX_LENGTH,
): string {
  if (text.length <= limit) {
    return text;
  }

  const ellipsis = "…";
  const hardCut = text.slice(0, limit - ellipsis.length);
  const lastSpace = hardCut.lastIndexOf(" ");

  // Solo se corta por palabra cuando el espacio no deja un trozo corto y feo al
  // final: con una diferencia de 80 caracteres, el mensaje sigue aprovechando casi
  // todo el límite y no se queda en una línea suelta.
  if (lastSpace > 0 && lastSpace >= hardCut.length - WORD_BOUNDARY_SLACK) {
    return `${hardCut.slice(0, lastSpace).trimEnd()}${ellipsis}`;
  }

  return `${hardCut}${ellipsis}`;
}

/** El cierre de contexto de un DM. */
const DM_FOOTER = "Si crees que es un error, habla con la organización.";

/** La parte del aviso que describe el tipo de actuación, sin la razón. */
function actHeadline(notice: AdminActNoticeFields): string {
  switch (notice.kind) {
    case "BAN":
      return `${notice.playerName} ha sido expulsado del torneo.`;
    case "MATCH_ANNULMENT": {
      const count = notice.matchCount ?? 0;

      return count === 1
        ? `Se anula 1 partida ganada de ${notice.playerName}.`
        : `Se anulan ${count} partidas ganadas de ${notice.playerName}.`;
    }
    case "REVERSAL": {
      const count = notice.targetCount ?? 0;
      const resumen =
        notice.targetSummaries === undefined || notice.targetSummaries.length === 0
          ? ""
          : ` Actuaciones revertidas: ${notice.targetSummaries.join("; ")}.`;

      return count === 1
        ? `Se revierte 1 actuación de ${notice.playerName}.${resumen}`
        : `Se revierten ${count} actuaciones de ${notice.playerName}.${resumen}`;
    }
  }
}

/** El enlace público, o nada: nunca una dirección inventada. */
function linkSuffix(notice: AdminActNoticeFields): string {
  return notice.url === undefined || notice.url === null || notice.url === ""
    ? ""
    : `\n\nMás información: ${notice.url}`;
}

/**
 * El mensaje **global**, para el canal de avisos.
 *
 * Lleva la razón pública y **solo** la razón pública: la información privada no está
 * en el tipo. No dice quién lo hizo: eso está en el panel.
 */
export function adminActChannelText(notice: AdminActNoticeFields): string {
  const text = `${notice.editionName}: ${actHeadline(notice)}\n\nMotivo: ${notice.publicReason}${linkSuffix(notice)}`;

  return truncateAdminActMessage(text);
}

/**
 * El mensaje **privado**, para la persona afectada.
 *
 * Habla en segunda persona y lleva la misma razón pública. Tampoco puede llevar la
 * información privada: el tipo no la admite.
 */
export function adminActDmText(notice: AdminActNoticeFields): string {
  const headline = (() => {
    switch (notice.kind) {
      case "BAN":
        return "Has sido expulsado del torneo.";
      case "MATCH_ANNULMENT": {
        const count = notice.matchCount ?? 0;

        return count === 1
          ? "Se ha anulado 1 de tus partidas ganadas."
          : `Se han anulado ${count} de tus partidas ganadas.`;
      }
      case "REVERSAL": {
        const count = notice.targetCount ?? 0;
        const resumen =
          notice.targetSummaries === undefined || notice.targetSummaries.length === 0
            ? ""
            : ` Actuaciones revertidas: ${notice.targetSummaries.join("; ")}.`;

        return count === 1
          ? `Se ha revertido 1 actuación sobre tu participación.${resumen}`
          : `Se han revertido ${count} actuaciones sobre tu participación.${resumen}`;
      }
    }
  })();

  const text = `${notice.editionName}: ${headline}\n\nMotivo: ${notice.publicReason}${linkSuffix(notice)}\n\n${DM_FOOTER}`;

  return truncateAdminActMessage(text);
}

/* -------------------------------------------------------------------------- */
/* DTO para la interfaz                                                        */
/* -------------------------------------------------------------------------- */

/** Una fila del listado de actuaciones. **No** lleva la información privada. */
export type AdminActRow = {
  id: string;
  kind: AdminActKind;
  kindLabel: string;
  summary: string;
  playerId: string | null;
  playerName: string;
  profileId: number;
  publicReason: string;
  matchCount: number;
  actorEmail: string;
  /** ISO-8601 UTC, ya serializable al cliente. */
  createdAt: string;
  /** ISO-8601 UTC, o `null` si sigue vigente. */
  revertedAt: string | null;
  reversedByActId: string | null;
  state: AdminActState;
};

/** Una partida que se puede anular, con las etiquetas ya resueltas. */
export type AdminActMatchCandidate = {
  id: string;
  gameId: string;
  /** ISO-8601 UTC. */
  startedAt: string;
  civ: string | null;
  civLabel: string | null;
  opponentName: string | null;
  mode: string | null;
  modeLabel: string;
  map: string | null;
  /** Lo que la partida aportaría al volver a contar. */
  points: number;
};

/** Una actuación vigente y revertible de un jugador, para el selector de reversión. */
export type AdminActTargetCandidate = {
  id: string;
  kind: AdminActKind;
  kindLabel: string;
  summary: string;
  publicReason: string;
  matchCount: number;
  /** ISO-8601 UTC. */
  createdAt: string;
  actorEmail: string;
};

/** El detalle de una actuación. Aquí **sí** viaja la información privada. */
export type AdminActDetail = AdminActRow & {
  privateInfo: string | null;
  /** Estado que tenía el jugador antes de una expulsión; `null` en el resto. */
  statusBefore: AdminActPlayerStatus | null;
  /** Estado **actual** del jugador, o `null` si la fila ya no existe. */
  playerStatus: AdminActPlayerStatus | null;
  /** La actuación que la revirtió, si la hubo. */
  reversedBy: { actId: string; actorEmail: string; createdAt: string } | null;
  /** Partidas afectadas: las anuladas o, en una reversión, las de lo revertido. */
  matches: AdminActMatchCandidate[];
  /** Actuaciones objetivo de una reversión; vacío en los otros tipos. */
  targets: AdminActTargetCandidate[];
};

/** Un jugador con actuaciones vigentes, para el desplegable de reversión. */
export type AdminActPlayer = {
  id: string;
  name: string;
  status: AdminActPlayerStatus;
  activeActs: AdminActTargetCandidate[];
};

/** Los campos que el formulario puede señalar. */
export type AdminActField =
  | "kind"
  | "playerId"
  | "publicReason"
  | "privateInfo"
  | "matchIds"
  | "targetActIds"
  | "form";

/**
 * Estado de la Server Action de alta, compatible con `useActionState`.
 *
 * En éxito, `actId` identifica la actuación creada (útil para navegar al detalle) y
 * `message` puede llevar el aviso de que la clasificación se pondrá al día sola.
 */
export type AdminActFormState = {
  status: "idle" | "success" | "error";
  message: string | null;
  errors: Partial<Record<AdminActField, string>>;
  actId: string | null;
};

/** Estado inicial del formulario de alta. */
export const INITIAL_ADMIN_ACT_FORM_STATE: AdminActFormState = {
  status: "idle",
  message: null,
  errors: {},
  actId: null,
};

/** Resultado de cargar las partidas anulables. */
export type AdminActMatchesResult =
  | { status: "ok"; data: AdminActMatchCandidate[] }
  | { status: "error"; message: string };

/** Resultado de cargar las actuaciones revertibles. */
export type AdminActTargetsResult =
  | { status: "ok"; data: AdminActTargetCandidate[] }
  | { status: "error"; message: string };
