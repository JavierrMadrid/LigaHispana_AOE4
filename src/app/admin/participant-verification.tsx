import type { AdminParticipant } from "@/lib/admin";

/**
 * Estado de la verificación del alta por privado de Discord (issue 119), tal y como
 * se pinta en el panel.
 *
 * Vive aparte de `participant-status.ts` por el mismo motivo que aquel: la cola de
 * pendientes (servidor), el listado (cliente) y el diálogo de edición tienen que
 * llamar igual a lo mismo. Aquí no se decide nada de la puerta —eso es
 * `@/lib/discord/verification` y la base—, solo se traduce a un rótulo, un tono y
 * una frase; los predicados de "qué botones caben" son la cara visible de las
 * condiciones que el servidor vuelve a comprobar.
 */

export type VerificationTone = "verified" | "waiting" | "unsent" | "declined" | "unverified";

/**
 * Tono de cada estado. El color refuerza la palabra, nunca la sustituye, y sigue el
 * reparto del resto del panel: verde de victoria para lo confirmado, el oro de la
 * liga para lo que está en espera, rojo de derrota para lo que la persona rechazó y
 * el filete neutro para lo meramente informativo. `unsent` va en neutro con el texto
 * en primer plano porque no es un fallo de nadie: es un alta sujeta a la que todavía
 * no se le ha mandado el privado, y la acción que lo arregla está en la misma fila.
 */
export const VERIFICATION_TONE_STYLES: Record<VerificationTone, string> = {
  verified: "border-win/40 text-win",
  waiting: "border-accent/40 text-accent",
  unsent: "border-line-strong text-foreground",
  declined: "border-loss/40 text-loss",
  unverified: "border-line-strong text-muted",
};

export type VerificationSummary = {
  tone: VerificationTone;
  /** Rótulo corto: es el que cabe bajo el estado y en la cola. */
  label: string;
  /** La misma cosa, en una frase, para el `title` y para el diálogo. */
  hint: string;
};

/**
 * Qué se cuenta de una fila, o `null` si no hay nada que contar.
 *
 * El orden de las comprobaciones **es** la precedencia, y no es arbitrario:
 *
 * 1. **Verificado** manda sobre todo lo demás. Un alta que se rechazó y luego se
 *    volvió a aprobar conserva `discordDeclinedAt` de la vez anterior; si además
 *    confirmó, lo que vale es la confirmación, no el rechazo viejo.
 * 2. **Esperando** y **sin enviar** llegan ya resueltos desde el DAL
 *    (`discordVerificationPending` exige `PENDING`), así que no se puede pintar un
 *    "esperando confirmación" en un rechazado ni en un aprobado: en esos estados no
 *    se espera nada de nadie.
 * 3. **Rechazó la participación** es la autoría del "no": el estado ya dice
 *    "Rechazado", esto dice que lo decidió la persona desde su cuenta. Por eso
 *    exige `status === "REJECTED"`: `discordDeclinedAt` **no se limpia** al
 *    re-aprobar, así que en un alta que después se aprobó (y más aún si el
 *    superadministrador la aprobó sin verificación) ese rechazo es historia, no el
 *    estado actual. Pintarlo ahí diría que la persona sigue diciendo que no cuando
 *    la fila ya está dentro; en un expulsado, por lo mismo, el estado que manda es
 *    la expulsión.
 * 4. **Aprobado sin verificar**: la aprobación sin verificación del superadministrador
 *    limpia `requestedAt`, así que lo que queda como rastro es el privado enviado y
 *    la ausencia de confirmación. Sin `sentAt` no hay nada que distinga esa renuncia
 *    de un alta que nunca estuvo sujeta, y entonces no se pinta: afirmar "sin
 *    verificar" en una fila anterior a esta funcionalidad sería inventarse un pasado.
 */
export function describeVerification(
  player: AdminParticipant,
): VerificationSummary | null {
  if (
    player.discordVerifiedAt !== null &&
    player.discordVerificationRequestedAt !== null
  ) {
    return {
      tone: "verified",
      label: "Verificado",
      hint: "La persona confirmó por privado de Discord que participa.",
    };
  }

  if (player.discordVerificationPending) {
    return player.discordVerificationSentAt !== null
      ? {
          tone: "waiting",
          label: "Esperando confirmación",
          hint: "Se le ha enviado el privado de Discord y falta que confirme desde su cuenta. Hasta entonces el alta no está aprobada.",
        }
      : {
          tone: "unsent",
          label: "Verificación sin enviar",
          hint: "El alta está sujeta a verificación y todavía no se ha enviado el privado de Discord.",
        };
  }

  if (player.status === "REJECTED" && player.discordDeclinedAt !== null) {
    return {
      tone: "declined",
      label: "Rechazó la participación",
      hint: "Pulsó «No, no participo» en el privado de Discord.",
    };
  }

  if (
    player.status === "APPROVED" &&
    player.discordVerifiedAt === null &&
    player.discordVerificationSentAt !== null
  ) {
    return {
      tone: "unverified",
      label: "Aprobado sin verificar",
      hint: "Se aprobó sin esperar la confirmación de la persona. Queda registrado en el historial.",
    };
  }

  return null;
}

/**
 * Distintivo secundario que va **debajo** del estado, no en su lugar.
 *
 * La píldora es la misma forma que la del estado y la de la pertenencia al servidor
 * (`rounded-full border px-2 py-0.5 text-xs`), y el rótulo no se parte:
 * «Esperando confirmación» en dos líneas dentro de una píldora redonda se lee como
 * dos cosas. Si la columna no da de sí, se desplaza la tabla, que ya lo hace.
 */
export function VerificationBadge({
  player,
  className = "",
}: {
  player: AdminParticipant;
  className?: string;
}) {
  const summary = describeVerification(player);

  if (summary === null) {
    return null;
  }

  return (
    <span
      title={summary.hint}
      className={`inline-block whitespace-nowrap rounded-full border px-2 py-0.5 text-xs ${VERIFICATION_TONE_STYLES[summary.tone]} ${className}`}
    >
      {summary.label}
    </span>
  );
}

/**
 * ¿Cabe «Reenviar verificación»? Es un alta pendiente, sujeta y sin confirmar.
 *
 * El servidor exige además que la verificación esté configurada. No se comprueba
 * aquí a propósito: una fila sujeta solo existe si lo estaba al crearse, y si la
 * configuración se ha caído después, el intento devuelve el motivo en el mismo
 * sitio donde se pulsó.
 */
export function canResendVerification(player: AdminParticipant): boolean {
  return player.discordVerificationPending;
}

/** ¿Cabe «Aprobar sin verificación»? Solo el superadministrador, y solo sobre un alta pendiente sujeta. */
export function canApproveWithoutVerification(
  player: AdminParticipant,
  canReverse: boolean,
): boolean {
  return canReverse && player.discordVerificationPending;
}

/** Una fecha del expediente de verificación, ya con su rótulo. */
export type VerificationFact = {
  key: "requested" | "sent" | "verified" | "declined";
  label: string;
  at: Date;
};

/**
 * Las fechas del **expediente del privado**, en orden cronológico.
 *
 * Solo existen si la fila está sujeta (`requestedAt` informado): un alta de
 * `/participar` no tiene expediente de privado. Y hay que decirlo aquí y no dejarlo
 * a quien pinte, porque su `discordVerifiedAt` viene del paso de OAuth y significa
 * otra cosa: pintarlo como «confirmó la participación» al lado de «sin verificación»
 * sería una contradicción en el mismo panel.
 *
 * La lista se compone con lo que hay y no con huecos: una fila sin verificación no
 * pinta cuatro "—", pinta nada y lo dice su frase. Las fechas se formatean en quien
 * las pinta (con `formatMadridDateTime`), no aquí, para que este módulo siga siendo
 * solo el reparto de qué se cuenta.
 */
export function verificationFacts(player: AdminParticipant): VerificationFact[] {
  const facts: VerificationFact[] = [];

  if (player.discordVerificationRequestedAt === null) {
    return facts;
  }

  facts.push({
    key: "requested",
    label: "Alta sujeta a verificación desde",
    at: player.discordVerificationRequestedAt,
  });

  if (player.discordVerificationSentAt !== null) {
    facts.push({
      key: "sent",
      label: "Último privado enviado",
      at: player.discordVerificationSentAt,
    });
  }

  if (player.discordVerifiedAt !== null) {
    facts.push({
      key: "verified",
      label: "Confirmó la participación",
      at: player.discordVerifiedAt,
    });
  }

  if (player.discordDeclinedAt !== null) {
    facts.push({
      key: "declined",
      label: "Rechazó la participación",
      at: player.discordDeclinedAt,
    });
  }

  return facts;
}
