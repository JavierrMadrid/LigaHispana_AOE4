/**
 * La verificación del alta de admin por privado de Discord (issue 119).
 *
 * ## Qué decide este módulo
 *
 * Hasta ahora, dar de alta a alguien desde el panel lo dejaba dentro sin hacer nada:
 * el `@usuario` lo escribe una persona de la organización y nadie le preguntaba a la
 * persona si quería participar. Desde la issue 119, el bot le manda un privado con
 * dos botones y el alta **no queda firme** hasta que confirma desde su cuenta.
 *
 * Aquí vive todo lo que se puede decidir sin tocar la base ni la red: el texto del
 * privado, los `custom_id` de los botones, cuándo la puerta aplica, qué hacer al
 * pulsar aprobar y qué se contesta al resolver la interacción. Es el mismo reparto
 * que `membership.ts` y por el mismo motivo: la parte que no se puede dejar suelta
 * —la diferencia entre "hay que esperar" y "se puede aprobar"— se prueba entera sin
 * base de datos, y quien escribe (`verification-send.ts`,
 * `verification-resolve.ts`, `src/app/admin/actions.ts`) solo obedece.
 *
 * ## La puerta, en una línea
 *
 * Un jugador con `discordVerificationRequestedAt` informado y `discordVerifiedAt`
 * a `null` **no puede quedar `APPROVED`**, salvo la aprobación explícita sin
 * verificación del superadministrador. `requestedAt = null` es el estado de todo lo
 * que ya existía y de lo que entra por `/participar`, y es lo que hace que esta
 * funcionalidad no re-verifique a nadie: las filas antiguas no se tocan.
 *
 * ## Por qué los estados son literales y no el enum de Prisma
 *
 * Igual que `AdminActPlayerStatus` en `admin-acts.ts`: para que el módulo no
 * arrastre el cliente generado y se pueda importar en un test sin nada alrededor.
 * `PlayerStatus` es asignable a esta unión sin conversión en las dos direcciones que
 * se usan.
 */

/** Los estados de `PlayerStatus` que le importan a la puerta. */
export type VerificationPlayerStatus = "PENDING" | "APPROVED" | "REJECTED" | "BANNED";

/* -------------------------------------------------------------------------- */
/* La configuración                                                            */
/* -------------------------------------------------------------------------- */

/** Las cuatro credenciales de la verificación, ya leídas del entorno. */
export type VerificationConfig = {
  /** `DISCORD_BOT_TOKEN`. */
  botToken: string | null;
  /** `DISCORD_GUILD_ID`. */
  guildId: string | null;
  /** `DISCORD_CLIENT_ID`. */
  clientId: string | null;
  /** `DISCORD_PUBLIC_KEY`. */
  publicKey: string | null;
};

/**
 * Cada credencial con el nombre de la variable de la que sale, en el orden en que
 * se lee y se informa. Es la **única** lista: el guard de `env.ts` y el aviso del
 * panel deciden con ella.
 */
const VERIFICATION_ENV: readonly (readonly [name: string, key: keyof VerificationConfig])[] = [
  ["DISCORD_BOT_TOKEN", "botToken"],
  ["DISCORD_GUILD_ID", "guildId"],
  ["DISCORD_CLIENT_ID", "clientId"],
  ["DISCORD_PUBLIC_KEY", "publicKey"],
];

/** Los nombres de las cuatro variables, en el mismo orden que `missingVerificationEnv()`. */
export const VERIFICATION_ENV_NAMES: readonly string[] = VERIFICATION_ENV.map(
  ([name]) => name,
);

/**
 * Qué credenciales faltan para la verificación del alta, por su nombre de variable.
 *
 * Existe para que el aviso del panel pueda decir **cuál** falta en vez de un "no
 * está configurada" que obliga a adivinar entre cuatro. Y para que el guard de
 * `env.ts` y ese aviso decidan con la misma lista: si divergieran, el panel podría
 * decir que todo está puesto mientras el alta se aprueba sin privado —que es justo
 * la degradación silenciosa que se quiere dejar de tener—.
 *
 * Devuelve los nombres en el orden de `VERIFICATION_ENV_NAMES`, y el array vacío
 * cuando están las cuatro.
 */
export function missingVerificationEnv(config: VerificationConfig): string[] {
  return VERIFICATION_ENV.filter(([, key]) => config[key] === null).map(([name]) => name);
}

/* -------------------------------------------------------------------------- */
/* Los botones                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Prefijo del `custom_id` de cada botón.
 *
 * `pv` es "participación verificada" y es corto a propósito: `custom_id` tiene un
 * tope de 100 caracteres y el token va detrás. El prefijo es lo que distingue estos
 * botones de cualquier otro componente futuro de la misma aplicación; el `d:` y el
 * `c:` son la decisión, para que se pueda leer en el log de Discord sin mirar la
 * base.
 */
export const VERIFICATION_CONFIRM_PREFIX = "pv:c:";

/** Prefijo del botón "No, no participo". */
export const VERIFICATION_DECLINE_PREFIX = "pv:d:";

/** Lo que puede responder la persona en el privado. */
export type VerificationDecision = "confirm" | "decline";

/**
 * A qué se ha dado al botón.
 *
 * - `approve`: `status = APPROVED` y `discordVerifiedAt`.
 * - `reject`: `status = REJECTED` y `discordDeclinedAt`.
 * - `stale`: el botón ya no vale. Se contesta lo mismo que si no fuera de nadie:
 *   un token resuelto, una fila que ya no está pendiente o una pulsación de otra
 *   cuenta no pueden contarse.
 */
export type VerificationResolution = "approve" | "reject" | "stale";

/** El `custom_id` que lleva un botón del privado. */
export function verificationCustomId(
  decision: VerificationDecision,
  token: string,
): string {
  return `${decision === "confirm" ? VERIFICATION_CONFIRM_PREFIX : VERIFICATION_DECLINE_PREFIX}${token}`;
}

/**
 * Lee un `custom_id` y devuelve qué botón es, o `null` si no es de este módulo.
 *
 * No valida la **forma** del token: quien llama lo busca en la base, que es la
 * única comprobación que dice si vale. Un token con espacios o larguísimo no
 * encontrará fila y saldrá como `stale`, que es lo mismo que un token viejo.
 */
export function parseVerificationCustomId(
  customId: string,
): { decision: VerificationDecision; token: string } | null {
  const prefijos: [string, VerificationDecision][] = [
    [VERIFICATION_CONFIRM_PREFIX, "confirm"],
    [VERIFICATION_DECLINE_PREFIX, "decline"],
  ];

  for (const [prefijo, decision] of prefijos) {
    if (!customId.startsWith(prefijo)) {
      continue;
    }

    const token = customId.slice(prefijo.length);

    return token === "" ? null : { decision, token };
  }

  return null;
}

/* -------------------------------------------------------------------------- */
/* El privado                                                                  */
/* -------------------------------------------------------------------------- */

/** Lo que hace falta para redactar el privado. */
export type VerificationDmInput = {
  /** Nombre de la edición (`edition.config`), ya resuelto por quien manda. */
  editionName: string;
  /** `Player.name`, el nombre de display. */
  playerName: string;
  /** `Player.profileId`, para que se pueda comprobar que el perfil es el suyo. */
  profileId: number;
};

/**
 * El texto del privado.
 *
 * Tres datos y una pregunta: de qué edición es, cómo se llama la ficha que se ha
 * dado de alta y **qué perfil de AoE4World** es. El `profileId` es lo que permite a
 * la persona reconocer si el alta es suya, y decir que no si no lo es —un alta
 * equivocada se corrige desde el panel, pero no puede colarse sin que nadie la vea—.
 * Por eso el texto también dice explícitamente que puede negarse: el silencio no
 * puede convertirse en un "sí" por defecto.
 *
 * Sin emojis, y sin el `@usuario`: el privado ya va a su cuenta, y repetirlo solo
 * añadiría un dato que la persona no necesita para decidir.
 */
export function verificationDmText(input: VerificationDmInput): string {
  return (
    `La organización de ${input.editionName} te ha dado de alta como participante ` +
    `(${input.playerName}, perfil de AoE4World ${input.profileId}). ` +
    "¿Confirmas que quieres participar? Si no reconoces esta alta, pulsa No."
  );
}

/** Un botón de Discord (`type: 2`), con lo mínimo que usa este módulo. */
export type VerificationButton = {
  type: 2;
  style: 3 | 4;
  label: string;
  custom_id: string;
};

/** Cuerpo de `POST /channels/{id}/messages` del privado de verificación. */
export type VerificationDmMessage = {
  content: string;
  components: { type: 1; components: VerificationButton[] }[];
  /**
   * `parse: []` es deliberado: el texto lleva el nombre de la edición y el de la
   * persona, y cualquiera de los dos podría empezar por `@`. Sin esto, un nombre
   * así pingearía a medio servidor desde el privado de la organización.
   */
  allowed_mentions: { parse: [] };
};

/**
 * El mensaje completo: texto, fila de botones y menciones desactivadas.
 *
 * Los estilos son los de Discord: `3` es verde (sí) y `4` es rojo (no). No se usa
 * `PRIMARY` azul para el "no" porque la acción destructiva tiene que distinguirse
 * del consentimiento de un vistazo.
 */
export function verificationDmMessage(
  input: VerificationDmInput,
  token: string,
): VerificationDmMessage {
  return {
    content: verificationDmText(input),
    components: [
      {
        type: 1,
        components: [
          {
            type: 2,
            style: 3,
            label: "Sí, participo",
            custom_id: verificationCustomId("confirm", token),
          },
          {
            type: 2,
            style: 4,
            label: "No, no participo",
            custom_id: verificationCustomId("decline", token),
          },
        ],
      },
    ],
    allowed_mentions: { parse: [] },
  };
}

/* -------------------------------------------------------------------------- */
/* La puerta                                                                   */
/* -------------------------------------------------------------------------- */

/** El estado de verificación de una fila, tal y como se lee de `Player`. */
export type VerificationState = {
  /** `Player.discordVerificationRequestedAt`. `null` = esta fila no está sujeta. */
  requestedAt: Date | null;
  /** `Player.discordVerifiedAt`. Informado = la persona ya confirmó. */
  verifiedAt: Date | null;
};

/**
 * ¿Esta fila está sujeta a la verificación del alta?
 *
 * Solo mira la fila, no la configuración: `requestedAt` se escribe únicamente
 * cuando la verificación estaba configurada, así que una fila que lo tiene es una
 * fila que la organización decidió verificar. Que la configuración se caiga después
 * no convierte esa decisión en "no hacía falta"; lo que cambia es que ya no se puede
 * mandar el privado, y eso lo resuelve quien envía.
 */
export function verificationGateApplies(state: VerificationState): boolean {
  return state.requestedAt !== null && state.verifiedAt === null;
}

/** Qué hacer cuando un admin pulsa "Aprobar". */
export type ApprovalPlan =
  /** La puerta no aplica: se aprueba como siempre. */
  | "approve"
  /** Ya se ha mandado el privado: no se duplica y se espera la confirmación. */
  | "await-confirmation"
  /** Hay que mandar el privado y la fila se queda `PENDING` hasta que confirme. */
  | "send-verification";

/**
 * La decisión de aprobar, sin tocar nada.
 *
 * | Situación | Plan |
 * |---|---|
 * | La verificación no está configurada | `approve` |
 * | La fila no está sujeta (`requestedAt` a `null`) | `approve` |
 * | Ya confirmó (`verifiedAt` informado) | `approve` |
 * | Sujeta, `PENDING`, sin privado enviado | `send-verification` |
 * | Sujeta, `PENDING`, con privado ya enviado | `await-confirmation` |
 * | Sujeta y **no** `PENDING` (un `REJECTED` que se re-aprueba) | `send-verification` |
 *
 * `await-confirmation` no es un fallo ni una aprobación a medias: es la respuesta
 * honesta a un admin que vuelve a pulsar. Reenviar el privado en cada clic llenaría
 * de mensajes la conversación y cambiaría el token que la persona quizá ya tiene
 * delante; para eso está la acción explícita de reenviar.
 */
export function planApproval(
  input: VerificationState & {
    verificationConfigured: boolean;
    sentAt: Date | null;
    status: VerificationPlayerStatus;
  },
): ApprovalPlan {
  if (!input.verificationConfigured || !verificationGateApplies(input)) {
    return "approve";
  }

  // El "esperando" solo vale si la fila **ya está en la cola de revisión**: la
  // confirmación de la persona solo se aplica sobre `PENDING` (ver
  // `resolveVerificationClick()`). Aprobar un `REJECTED` que conserva `sentAt` de un
  // intento anterior tiene que mandar un privado nuevo, porque el token de aquel se
  // limpió al rechazar y sus botones ya no valen.
  if (input.status !== "PENDING") {
    return "send-verification";
  }

  return input.sentAt === null ? "send-verification" : "await-confirmation";
}

/**
 * ¿Se puede reenviar el privado?
 *
 * Solo para una fila **sujeta y sin confirmar**, en `PENDING` y con la
 * funcionalidad configurada. Un `REJECTED` no se reenvía porque para volver atrás
 * primero se aprueba —y eso ya dispara el envío—, y un `APPROVED` no porque la
 * puerta ya la dejó pasar o la aprobó el superadministrador.
 */
export function verificationCanBeResent(
  input: VerificationState & {
    verificationConfigured: boolean;
    status: VerificationPlayerStatus;
  },
): boolean {
  return (
    input.verificationConfigured &&
    input.status === "PENDING" &&
    verificationGateApplies(input)
  );
}

/**
 * ¿Se puede aprobar sin verificación?
 *
 * El permiso (solo el superadministrador) se comprueba en la acción, que es donde
 * está la sesión; aquí solo se decide si la fila es una candidata: `PENDING`, sujeta
 * y sin confirmar. Fuera de eso la aprobación normal ya hace lo correcto y esta vía
 * sobraría.
 */
export function verificationCanBeApprovedWithout(
  input: VerificationState & { status: VerificationPlayerStatus },
): boolean {
  return input.status === "PENDING" && verificationGateApplies(input);
}

/**
 * Qué se hace al pulsar un botón, o por qué no se hace nada.
 *
 * Es la guarda contra las cuatro formas de colar una respuesta que no es de quien
 * se cree: un token que no existe, una cuenta que no es la destinataria, una fila
 * que ya no está `PENDING` y una que ya confirmó (o que nunca estuvo sujeta). Las
 * cuatro salen por `stale`, y quien contesta no distingue entre ellas: el mensaje
 * genérico no cuenta si el token era de otra persona.
 *
 * **No se comprueba aquí que el token sea el vigente**: eso es la lectura de la
 * fila (`tokenMatches`), porque este módulo no ve la base. Y no se comprueba que la
 * fila siga teniendo ese token *en el momento de escribir*: eso lo hace el
 * `updateMany` condicionado de `verification-resolve.ts`, que es lo que cierra la
 * carrera de dos pulsaciones.
 */
export function resolveVerificationClick(input: {
  decision: VerificationDecision;
  /** El token del botón encontró una fila y es el suyo. */
  tokenMatches: boolean;
  /** Quien pulsa es la cuenta a la que se mandó el privado. */
  senderMatches: boolean;
  status: VerificationPlayerStatus;
  state: VerificationState;
}): VerificationResolution {
  if (!input.tokenMatches || !input.senderMatches) {
    return "stale";
  }

  if (input.status !== "PENDING" || !verificationGateApplies(input.state)) {
    return "stale";
  }

  return input.decision === "confirm" ? "approve" : "reject";
}

/**
 * El texto con el que se edita el privado al resolverlo.
 *
 * Sustituye al mensaje con botones (`type: 7`, UPDATE_MESSAGE) para que nadie pueda
 * volver a pulsar y para que la conversación cuente lo que pasó. Habla en segunda
 * persona, porque lo lee la persona que acaba de pulsar.
 */
export function verificationResolvedText(decision: VerificationDecision): string {
  return decision === "confirm"
    ? "Alta confirmada. Ya participas en el torneo; tu ficha aparecerá en la clasificación en la próxima actualización."
    : "Has indicado que no quieres participar. La organización lo verá y no se te dará de alta.";
}

/**
 * Lo que se contesta cuando el botón ya no vale.
 *
 * Es genérico a propósito: el mismo texto para un token caducado, una fila que ya
 * se resolvió y una pulsación desde otra cuenta. Decir cuál de los tres es contaría
 * a quien pulsa si el token era de otra persona, y no le sirve de nada a quien de
 * verdad tenía un botón viejo.
 */
export function verificationStaleText(): string {
  return "Este aviso ya no está vigente. Si crees que es un error, habla con la organización.";
}

/**
 * ¿La confirmación deja la cuenta de Discord vinculada a esta fila?
 *
 * La interacción conoce el `discordUserId` de quien pulsa, así que al confirmar se
 * puede escribir —es la única vía en la que Discord firma que esa cuenta es la
 * destinataria—. Pero `Player.discordUserId` es único: si esa cuenta ya está
 * vinculada a **otro** participante, no se escribe y se avisa. Aprobar sí se
 * aprueba: la persona ha confirmado desde su cuenta, y negarle el alta por un
 * conflicto de datos del panel sería castigarla por un error de la organización.
 */
export function verificationLinksDiscord(
  conflictingPlayerName: string | null,
): boolean {
  return conflictingPlayerName === null;
}
