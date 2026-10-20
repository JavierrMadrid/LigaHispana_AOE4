import { describe, expect, it } from "vitest";

import {
  ALERT_KIND_LABELS,
  ALERT_RULE_LABELS,
  ALERTS_RULESET_KEY,
  ALERTS_RULESET_VERSION,
  DEFAULT_ALERTS_RULESET,
  SELF_SUBJECT,
  alertDedupeKey,
  alertDetails,
  alertSummary,
  buildTriggeredAlert,
  hasStreamChannel,
  mergeAlertsRuleset,
  minutos,
  partidas,
  type AlertTriggerInput,
} from "@/lib/alerts/rules";

/**
 * Los umbrales, las frases y las claves de dedupe de las alertas.
 *
 * `Alert.summary` se pinta tal cual en el panel y en el CSV, y `Alert.dedupeKey` es
 * lo único que hace idempotente la evaluación, así que los dos son contrato: lo
 * que se prueba aquí es que un dato que falta se lea en español y que dos hechos
 * distintos nunca compartan clave.
 */

const VENTANA = { from: "2026-09-15T00:00:00.000Z", to: "2026-10-15T00:00:00.000Z" };

/** Sujeto con nombre, como el rival o el compañero de R2 y R3. */
const SUJETO = { key: "92000004", profileId: 9_200_004, name: "Rival Externo" };

function disparo(overrides: Partial<AlertTriggerInput> = {}): AlertTriggerInput {
  return {
    rule: "REPEATED_OPPONENT_STREAK",
    kind: "STREAK_CLOSED",
    playerId: "jugador-alertas",
    playerProfileId: 9_100_001,
    subject: SUJETO,
    count: 3,
    threshold: 3,
    anchorGameId: "800-004",
    anchorStartedAt: new Date("2026-09-16T04:00:00.000Z"),
    window: VENTANA,
    ...overrides,
  };
}

describe("etiquetas", () => {
  it("las dieciséis reglas y los cinco tipos tienen su rótulo en español", () => {
    // El `satisfies Record<...>` del módulo obliga a decidir la etiqueta al añadir
    // una regla; aquí se comprueba que ninguna se quedó sin él ni con el mismo
    // texto que otra. Las dieciséis etiquetas son las **seis** reglas de
    // comportamiento que se calculan por racha o acumulado, las **dos retiradas**
    // (R4 y R5, que se quedan por las filas históricas), las **cinco de estado**
    // (historial, ladder, Discord, canal de directo y resumen sin revisar) y las
    // **tres de partida** que salen del resumen; los cinco tipos son las tres
    // rachas/acumulados, `STATE_DETECTED` y `MATCH_DETECTED`.
    const etiquetas = Object.values(ALERT_RULE_LABELS);

    expect(Object.keys(ALERT_RULE_LABELS)).toHaveLength(16);
    expect(Object.keys(ALERT_KIND_LABELS)).toHaveLength(5);
    expect(new Set(etiquetas).size).toBe(etiquetas.length);
    for (const etiqueta of [...etiquetas, ...Object.values(ALERT_KIND_LABELS)]) {
      expect(etiqueta.length).toBeGreaterThan(0);
    }
  });

  it("la etiqueta de una regla no lleva el nombre del jugador ni ningún número", () => {
    // La etiqueta describe la regla, no el hallazgo: si llevara un número, dejaría
    // de ser cierta en cuanto se retocara un umbral en `Setting`.
    for (const etiqueta of Object.values(ALERT_RULE_LABELS)) {
      expect(etiqueta).not.toMatch(/\d/);
    }
  });
});

describe("el plural de las partidas", () => {
  it("una partida es singular y dos no", () => {
    expect(partidas(1)).toBe("1 partida");
    expect(partidas(0)).toBe("0 partidas");
    expect(partidas(2)).toBe("2 partidas");
  });
});

describe("los minutos", () => {
  it("los segundos exactos se dicen sin decimal", () => {
    expect(minutos(300)).toBe("5 minutos");
    expect(minutos(60)).toBe("1 minuto");
    expect(minutos(0)).toBe("0 minutos");
  });

  it("lo que no es exacto va con un decimal y coma", () => {
    // Los umbrales son segundos y quien los retoca puede poner 330.
    expect(minutos(330)).toBe("5,5 minutos");
    expect(minutos(90)).toBe("1,5 minutos");
  });
});

describe("alertSummary", () => {
  it("cada regla tiene su frase, sin el nombre del jugador", () => {
    // El jugador se renombra y la fila es suya: guardar el nombre congelaría un
    // texto que dejaría de ser cierto.
    expect(alertSummary(disparo({ rule: "SHORT_MATCH_STREAK", count: 2 }))).toBe(
      "2 partidas cortas seguidas",
    );
    expect(alertSummary(disparo({ rule: "SHORT_MATCH_TOTAL", count: 5 }))).toBe(
      "5 partidas cortas en total",
    );
    expect(alertSummary(disparo({ rule: "REPEATED_OPPONENT_STREAK", count: 3 }))).toBe(
      "3 partidas seguidas contra Rival Externo",
    );
    expect(alertSummary(disparo({ rule: "REPEATED_OPPONENT_TOTAL", count: 10 }))).toBe(
      "10 partidas contra Rival Externo en total",
    );
    expect(alertSummary(disparo({ rule: "REPEATED_TEAMMATE_STREAK", count: 3 }))).toBe(
      "3 partidas de equipo seguidas con Rival Externo",
    );
    expect(alertSummary(disparo({ rule: "REPEATED_TEAMMATE_TOTAL", count: 7 }))).toBe(
      "7 partidas de equipo con Rival Externo en total",
    );
  });

  it("una regla cuyo sujeto no tiene nombre usa el texto genérico", () => {
    // El sujeto puede no estar en la liga y su nombre puede no haber llegado: la
    // frase no puede quedar con un `null` en medio ni quedarse a medias.
    const sinNombre = { key: "92000009", profileId: 9_200_009, name: null };

    expect(alertSummary(disparo({ subject: sinNombre }))).toContain("el mismo rival");
    expect(
      alertSummary(disparo({ rule: "REPEATED_TEAMMATE_STREAK", subject: sinNombre })),
    ).toContain("el mismo compañero");
  });

  it("las dos reglas retiradas conservan su frase genérica, para las filas históricas", () => {
    // R4 y R5 ya no se calculan, pero sus valores del enum y sus etiquetas siguen
    // porque hay filas de `Alert` escritas con ellos. Sus frases se quedan en la
    // forma genérica: ya no hay detalle (`eloGap`, `steps`) que las concrete.
    expect(
      alertSummary(disparo({ rule: "TEAMMATE_ELO_GAP", count: 1 })),
    ).toContain("muy por encima o por debajo");
    expect(alertSummary(disparo({ rule: "LOW_DIVISION_TEAM_GAME", count: 1 }))).toContain(
      "en una división muy distinta",
    );
  });

  it("el cierre de torneo se dice en la frase, y solo en las de racha", () => {
    expect(alertSummary(disparo({ kind: "STREAK_AT_TOURNAMENT_END", count: 2 }))).toBe(
      "2 partidas seguidas contra Rival Externo al cerrar el torneo",
    );
    // Un acumulado no "se cierra": cruzó un número y ya está.
    expect(
      alertSummary(disparo({ rule: "REPEATED_OPPONENT_TOTAL", kind: "TOTAL_REACHED", count: 10 })),
    ).not.toContain("al cerrar el torneo");
  });

  it("las dos reglas de estado dicen lo que se comprobó, sin causa y sin acusar", () => {
    // La diferencia con el resto no es de estilo: estas frases las lee gente que no
    // ha hecho nada malo. Ninguna dice por qué (si el jugador cambió el ajuste, si se
    // le olvidó, si es un problema de la web, no lo sabemos), y ninguna acusa. La
    // columna `rule` ya dice qué regla es, así que la frase no repite el nombre.
    expect(
      alertSummary(
        disparo({
          rule: "HISTORY_NOT_PUBLIC",
          kind: "STATE_DETECTED",
          count: 3,
          threshold: 3,
          anchorGameId: null,
          detail: { probedCount: 3, probedGameIds: ["1", "2", "3"] },
        }),
      ),
    ).toBe("Su historial de partidas no es público");
    expect(
      alertSummary(
        disparo({
          rule: "MISSING_LADDER_MATCHES",
          kind: "STATE_DETECTED",
          count: 320,
          threshold: 75,
          anchorGameId: null,
          detail: { lagMinutes: 320 },
        }),
      ),
    ).toBe("La ladder registra partidas que no nos llegan");
  });

  it("las frases de estado no llevan el nombre del jugador ni la causa", () => {
    for (const rule of [
      "HISTORY_NOT_PUBLIC",
      "MISSING_LADDER_MATCHES",
      "NO_STREAM_CHANNEL",
      "SUMMARY_NOT_REVIEWED",
    ] as const) {
      const frase = alertSummary(
        disparo({
          rule,
          kind: "STATE_DETECTED",
          subject: SUJETO,
          count: 3,
          anchorGameId: null,
        }),
      );

      expect(frase).not.toContain("Rival Externo");
      // Habla en primera persona del sistema ("no nos llegan") o del jugador ("su
      // historial"), nunca en tercera persona con nombre. Las de partida hablan de lo
      // que pasó, sin sujeto.
      if (rule === "SUMMARY_NOT_REVIEWED") {
        expect(frase).toMatch(/partidas? no se han? podido revisar/);
      } else {
        expect(frase).toMatch(/^(Su |La ladder)/);
      }
      // Palabras que serían una acusación o una causa, que es justo lo que no se sabe.
      expect(frase).not.toMatch(/culpa|trampa|mentir|false|intencionad|mal hecho/i);
      // Y tampoco "al cerrar el torneo": un estado no se cierra, se comprueba.
      expect(frase).not.toContain("al cerrar el torneo");
    }
  });

  it("las tres del resumen dicen lo que se vio, en minutos", () => {
    // Son hallazgos de una partida, no acusaciones: no llevan causa ni nombre, y el
    // número que sale es el umbral o el tramo convertido a minutos.
    expect(
      alertSummary(
        disparo({
          rule: "NO_VILLAGERS_FIRST_MINUTES",
          kind: "MATCH_DETECTED",
          subject: SELF_SUBJECT,
          count: 0,
          threshold: 300,
          anchorGameId: "800-010",
        }),
      ),
    ).toBe("No hizo ningún aldeano en los primeros 5 minutos.");

    expect(
      alertSummary(
        disparo({
          rule: "NO_MILITARY_GAP",
          kind: "MATCH_DETECTED",
          subject: SELF_SUBJECT,
          count: 600,
          threshold: 300,
          anchorGameId: "800-010",
        }),
      ),
    ).toBe("Pasó 10 minutos seguidos sin progreso militar.");

    expect(
      alertSummary(
        disparo({
          rule: "NO_RESOURCES_GAP",
          kind: "MATCH_DETECTED",
          subject: SELF_SUBJECT,
          count: 180,
          threshold: 120,
          anchorGameId: "800-010",
        }),
      ),
    ).toBe("Pasó 3 minutos seguidos sin obtener recursos.");
  });

  it("el aviso de partidas sin revisar distingue una de varias", () => {
    const una = alertSummary(
      disparo({
        rule: "SUMMARY_NOT_REVIEWED",
        kind: "STATE_DETECTED",
        subject: SELF_SUBJECT,
        count: 1,
        threshold: 1,
        anchorGameId: null,
      }),
    );
    const varias = alertSummary(
      disparo({
        rule: "SUMMARY_NOT_REVIEWED",
        kind: "STATE_DETECTED",
        subject: SELF_SUBJECT,
        count: 4,
        threshold: 1,
        anchorGameId: null,
      }),
    );

    expect(una).toBe("1 partida no se ha podido revisar por falta de resumen");
    expect(varias).toBe("4 partidas no se han podido revisar por falta de resumen");
  });
});

describe("alertDetails", () => {
  it("lo que no se sabe no se escribe, y lo que se sabe va en plana", () => {
    // El DAL aplana `details` a primitivos de un nivel, así que lo anidado se
    // descartaría al leer sin que nadie se enterase.
    const detalles = alertDetails(disparo({ subject: SELF_SUBJECT, anchorGameId: null }));

    expect(detalles).toEqual({
      rule: "REPEATED_OPPONENT_STREAK",
      kind: "STREAK_CLOSED",
      playerProfileId: 9_100_001,
      count: 3,
      threshold: 3,
      anchorStartedAt: "2026-09-16T04:00:00.000Z",
      windowFrom: VENTANA.from,
      windowTo: VENTANA.to,
    });
    expect(detalles).not.toHaveProperty("subjectProfileId");
    expect(detalles).not.toHaveProperty("anchorGameId");
  });

  it("con la ventana abierta solo se escribe `windowFrom`", () => {
    const detalles = alertDetails(disparo({ window: { from: VENTANA.from, to: null } }));

    expect(detalles).toHaveProperty("windowFrom");
    expect(detalles).not.toHaveProperty("windowTo");
  });

  it("el detalle de la partida se mezcla con el resto", () => {
    const detalles = alertDetails(disparo({ detail: { durationSeconds: 1800, probedCount: 3 } }));

    expect(detalles).toMatchObject({ durationSeconds: 1800, probedCount: 3 });
  });

  it("una regla que no mira partidas no escribe ventana", () => {
    // `DISCORD_NOT_IN_GUILD` se comprueba contra la API de Discord y no tiene nada
    // que ver con fechas de partidas. Ponerle la ventana del torneo afirmaría un
    // alcance que no tiene ("esto se comprobó dentro del torneo") y el `details` es
    // justo lo que se lee cuando alguien quiere saber qué se miró.
    const detalles = alertDetails(
      disparo({
        rule: "DISCORD_NOT_IN_GUILD",
        kind: "STATE_DETECTED",
        anchorGameId: null,
        anchorStartedAt: null,
        window: undefined,
        count: 1,
        threshold: 1,
        detail: {
          discordUserId: "1234567890123456789",
          discordCheckedAt: "2026-10-06T12:00:00.000Z",
          discordHttpStatus: 404,
        },
      }),
    );

    expect(detalles).not.toHaveProperty("windowFrom");
    expect(detalles).not.toHaveProperty("windowTo");
    // La evidencia con la que se comprobó sí va, y en plana: el DAL aplana `details` a
    // primitivos de un nivel, así que una estructura anidada se descartaría al leer.
    expect(detalles).toMatchObject({
      discordUserId: "1234567890123456789",
      discordCheckedAt: "2026-10-06T12:00:00.000Z",
      discordHttpStatus: 404,
    });
  });
});

describe("DISCORD_NOT_IN_GUILD: una regla, dos casos", () => {
  /** El disparo tal y como lo escribe el worker, con la evidencia de cada camino. */
  function disparoDiscord(resolvedBy: "discordUserId" | "username") {
    return disparo({
      rule: "DISCORD_NOT_IN_GUILD",
      kind: "STATE_DETECTED",
      anchorGameId: null,
      anchorStartedAt: null,
      window: undefined,
      count: 1,
      threshold: 1,
      subject: SELF_SUBJECT,
      detail: {
        resolvedBy,
        discordUsername: "pepito",
        ...(resolvedBy === "discordUserId"
          ? { discordUserId: "1234567890123456789", discordHttpStatus: 404 }
          : { discordRosterMembers: 47 }),
        discordCheckedAt: "2026-10-06T12:00:00.000Z",
      },
    });
  }

  it("los dos casos comparten frase y clave de dedupe, y se distinguen en `details`", () => {
    // Es la razón de que `resolvedBy` vaya en el `details` y no sea un valor de
    // `AlertRule`: la cuenta se ha ido del servidor y el `@usuario` no aparecen son
    // hechos distintos, pero para quien mira la alerta son **lo mismo** ("su Discord no
    // está en el servidor del torneo") y para la organización es una fila, no dos. Con
    // dos reglas habría el mismo texto duplicado y dos claves que explicar.
    const conCuenta = buildTriggeredAlert(disparoDiscord("discordUserId"));
    const conNombre = buildTriggeredAlert(disparoDiscord("username"));

    expect(conCuenta.rule).toBe(conNombre.rule);
    expect(conCuenta.kind).toBe(conNombre.kind);
    expect(conCuenta.summary).toBe(conNombre.summary);
    // Y la clave es la misma a propósito: si el dedupe las distinguiera, la segunda
    // comprobación insertaría una fila cada doce horas para siempre.
    expect(conCuenta.dedupeKey).toBe(conNombre.dedupeKey);

    expect(conCuenta.details.resolvedBy).toBe("discordUserId");
    expect(conNombre.details.resolvedBy).toBe("username");
    // La evidencia propia de cada camino: el estado HTTP cuando se preguntó por la
    // cuenta, el tamaño de la lista cuando se buscó por el nombre.
    expect(conCuenta.details.discordHttpStatus).toBe(404);
    expect(conNombre.details.discordRosterMembers).toBe(47);
    // Y el `@usuario` va en los dos, que es lo que quien tiene que arreglarlo necesita
    // para encontrar a esa persona en Discord.
    expect(conCuenta.details.discordUsername).toBe("pepito");
    expect(conNombre.details.discordUsername).toBe("pepito");
  });
});

describe("NO_STREAM_CHANNEL: la regla condicional de la edición", () => {
  /** El disparo tal y como lo escribe `evaluateAlerts()`: sin ancla y sin ventana. */
  function disparoSinCanal(overrides: Partial<AlertTriggerInput> = {}): AlertTriggerInput {
    return disparo({
      rule: "NO_STREAM_CHANNEL",
      kind: "STATE_DETECTED",
      subject: SELF_SUBJECT,
      count: 0,
      threshold: 1,
      anchorGameId: null,
      anchorStartedAt: null,
      window: undefined,
      ...overrides,
    });
  }

  it("dice lo que se ha comprobado, sin causa y sin nombre", () => {
    expect(alertSummary(disparoSinCanal())).toBe("Su ficha no tiene ningún canal de directo");
  });

  it("no escribe ni partida ancla ni ventana: no mira partidas", () => {
    // Es una columna de `Player`, no una partida: escribir la ventana del torneo
    // afirmaría un alcance que la comprobación no tiene.
    const detalles = alertDetails(disparoSinCanal());

    expect(detalles).not.toHaveProperty("anchorGameId");
    expect(detalles).not.toHaveProperty("anchorStartedAt");
    expect(detalles).not.toHaveProperty("windowFrom");
    expect(detalles).not.toHaveProperty("windowTo");
    // "Cero canales de los uno que se pide": la misma forma que la regla del historial.
    expect(detalles).toMatchObject({ count: 0, threshold: 1 });
  });

  it("su clave es de estado: da igual cuántas veces se reevalúe", () => {
    // La propiedad de la que depende que no llene la tabla: el motor la evalúa en
    // **cada** pasada mientras la edición exija retransmisión.
    const primera = buildTriggeredAlert(disparoSinCanal()).dedupeKey;
    const segunda = buildTriggeredAlert(disparoSinCanal({ count: 99, threshold: 99 })).dedupeKey;

    expect(segunda).toBe(primera);
    expect(primera).toContain("NO_STREAM_CHANNEL|STATE_DETECTED");
  });

  it("no se confunde con la del historial del mismo jugador", () => {
    const historial = buildTriggeredAlert(
      disparo({ rule: "HISTORY_NOT_PUBLIC", kind: "STATE_DETECTED", anchorGameId: null }),
    );

    expect(buildTriggeredAlert(disparoSinCanal()).dedupeKey).not.toBe(historial.dedupeKey);
  });
});

describe("hasStreamChannel", () => {
  const sinCanales = {
    twitchChannel: null,
    youtubeChannel: null,
    kickChannel: null,
    twitchUrl: null,
  };

  it("sin ningún canal no hay canal", () => {
    expect(hasStreamChannel(sinCanales)).toBe(false);
  });

  it("un vacío o un espacio no es un canal", () => {
    expect(hasStreamChannel({ ...sinCanales, kickChannel: "" })).toBe(false);
    expect(hasStreamChannel({ ...sinCanales, twitchChannel: "   " })).toBe(false);
  });

  it("cualquiera de los cuatro vale, incluido el de la ladder", () => {
    for (const campo of ["twitchChannel", "youtubeChannel", "kickChannel", "twitchUrl"] as const) {
      expect(hasStreamChannel({ ...sinCanales, [campo]: "canal" }), campo).toBe(true);
    }
  });
});

describe("alertDedupeKey", () => {
  it("un acumulado se distingue por el número y una racha por la partida que la cerró", () => {
    const total = alertDedupeKey({
      rule: "SHORT_MATCH_TOTAL",
      kind: "TOTAL_REACHED",
      playerId: "jugador-alertas",
      subjectKey: "yo",
      anchorGameId: "800-004",
      count: 5,
    });
    const racha = alertDedupeKey({
      rule: "SHORT_MATCH_TOTAL",
      kind: "TOTAL_REACHED",
      playerId: "jugador-alertas",
      subjectKey: "yo",
      anchorGameId: "800-009",
      count: 10,
    });

    // Mismo jugador, mismo sujeto, distinta partida y distinto número: si el remate
    // no fuera parte de la clave, los dos avisos se comerían uno a otro.
    expect(total).not.toBe(racha);
  });

  it("sin partida que ancla la clave lo dice, en vez de quedar vacía", () => {
    const clave = alertDedupeKey({
      rule: "SHORT_MATCH_TOTAL",
      kind: "TOTAL_REACHED",
      playerId: "jugador-alertas",
      subjectKey: "yo",
      anchorGameId: null,
      count: 5,
    });

    expect(clave.endsWith("total:5")).toBe(true);
    expect(clave).toContain(`v${ALERTS_RULESET_VERSION}`);
  });

  it("el sujeto va por su `key` estable, no por su nombre", () => {
    // El nombre de un rival puede cambiar; si fuera parte de la clave, la
    // evaluación siguiente escribiría una alerta que ya existe con otro texto.
    const conNombreNuevo = buildTriggeredAlert(
      disparo({ subject: { key: "92000004", profileId: 9_200_004, name: "Rival Renombrado" } }),
    );
    const conNombreViejo = buildTriggeredAlert(disparo());

    expect(conNombreNuevo.dedupeKey).toBe(conNombreViejo.dedupeKey);
    expect(conNombreNuevo.subjectName).toBe("Rival Renombrado");
  });

  it("dos jugadores con el mismo hecho no comparten clave", () => {
    const mio = buildTriggeredAlert(disparo());
    const otro = buildTriggeredAlert(disparo({ playerId: "otro-jugador" }));

    expect(mio.dedupeKey).not.toBe(otro.dedupeKey);
  });

  it("una regla de estado tiene clave estable: da igual cuántas veces se mida", () => {
    // **La propiedad de la que depende que estas reglas no llenen la tabla.** Se
    // reevalúan cada 5 minutos (la del historial con caché de 12 h), así que si la
    // clave llevara la partida sondeada o los minutos de desfase, cada medición
    // distinta insertaría una fila: una alarma cada 12 horas y para siempre por
    // jugador. Con `remate = "estado"` la clave depende solo de (regla, tipo,
    // jugador, sujeto), y la segunda pasada inserta 0 filas.
    const clave = (overrides: Partial<AlertTriggerInput>) =>
      buildTriggeredAlert(
        disparo({
          rule: "HISTORY_NOT_PUBLIC",
          kind: "STATE_DETECTED",
          count: 3,
          threshold: 3,
          anchorGameId: null,
          subject: SELF_SUBJECT,
          ...overrides,
        }),
      ).dedupeKey;

    const primera = clave({ detail: { probedGameIds: ["1", "2", "3"], probedCount: 3 } });
    // Otra medición de otro día: otras partidas, otro desfase, otra fecha.
    const segunda = clave({ count: 3, detail: { probedGameIds: ["900", "901", "902"] } });
    const tercera = clave({
      count: 99,
      threshold: 99,
      anchorGameId: "900",
      detail: { probedGameIds: ["901"], lagMinutes: 99 },
    });

    expect(segunda).toBe(primera);
    expect(tercera).toBe(primera);
    expect(primera).toContain(`v${ALERTS_RULESET_VERSION}|HISTORY_NOT_PUBLIC|STATE_DETECTED`);
  });

  it("las dos reglas de estado no comparten clave entre sí", () => {
    const base = {
      rule: "HISTORY_NOT_PUBLIC",
      kind: "STATE_DETECTED",
      playerId: "jugador-alertas",
      subjectKey: SELF_SUBJECT.key,
      anchorGameId: null,
      count: 3,
    } as const;

    expect(alertDedupeKey(base)).not.toBe(
      alertDedupeKey({ ...base, rule: "MISSING_LADDER_MATCHES", count: 320 }),
    );
  });

  it("una regla de estado no se confunde con una de racha del mismo jugador", () => {
    // El `kind` sigue estando en la clave: sin él, "el historial no es público" y
    // "tres partidas seguidas" podrían coincidir si se mezclaran reglas y tipos.
    const estado = buildTriggeredAlert(
      disparo({ rule: "HISTORY_NOT_PUBLIC", kind: "STATE_DETECTED", anchorGameId: null }),
    );
    const racha = buildTriggeredAlert(disparo());

    expect(estado.dedupeKey).not.toBe(racha.dedupeKey);
  });

  it("un hallazgo de partida lleva la partida en la clave: uno por partida y regla", () => {
    // `MATCH_DETECTED` cae en la rama de la partida. Con la clave de estado, el
    // primer hallazgo taparía todos los demás del jugador.
    const enUna = buildTriggeredAlert(
      disparo({
        rule: "NO_VILLAGERS_FIRST_MINUTES",
        kind: "MATCH_DETECTED",
        subject: SELF_SUBJECT,
        count: 0,
        threshold: 300,
        anchorGameId: "800-010",
      }),
    );
    const enOtra = buildTriggeredAlert(
      disparo({
        rule: "NO_VILLAGERS_FIRST_MINUTES",
        kind: "MATCH_DETECTED",
        subject: SELF_SUBJECT,
        count: 0,
        threshold: 300,
        anchorGameId: "800-011",
      }),
    );
    const otraRegla = buildTriggeredAlert(
      disparo({
        rule: "NO_MILITARY_GAP",
        kind: "MATCH_DETECTED",
        subject: SELF_SUBJECT,
        count: 600,
        threshold: 300,
        anchorGameId: "800-010",
      }),
    );

    expect(enUna.dedupeKey).toContain("partida:800-010");
    expect(enUna.dedupeKey).not.toBe(enOtra.dedupeKey);
    expect(enUna.dedupeKey).not.toBe(otraRegla.dedupeKey);
  });

  it("el aviso de no revisadas es de estado: da igual cuántas partidas se midan", () => {
    const clave = (count: number, gameIds: string[]) =>
      buildTriggeredAlert(
        disparo({
          rule: "SUMMARY_NOT_REVIEWED",
          kind: "STATE_DETECTED",
          subject: SELF_SUBJECT,
          count,
          threshold: 1,
          anchorGameId: null,
          detail: { unreviewedGameIds: gameIds },
        }),
      ).dedupeKey;

    const primera = clave(2, ["800-010", "800-011"]);
    // Otra pasada: el jugador ha jugado una más y ahora hay tres sin revisar.
    const segunda = clave(3, ["800-012", "800-010", "800-011"]);

    expect(segunda).toBe(primera);
    expect(primera).toContain("SUMMARY_NOT_REVIEWED|STATE_DETECTED");
  });
});

describe("buildTriggeredAlert", () => {
  it("monta clave, frase y detalles siempre del mismo tirón", () => {
    const alerta = buildTriggeredAlert(disparo());

    expect(alerta).toMatchObject({
      rule: "REPEATED_OPPONENT_STREAK",
      kind: "STREAK_CLOSED",
      playerId: "jugador-alertas",
      subjectProfileId: 9_200_004,
      subjectName: "Rival Externo",
      count: 3,
      threshold: 3,
      anchorGameId: "800-004",
      summary: "3 partidas seguidas contra Rival Externo",
    });
    expect(alerta.dedupeKey).toContain(
      "REPEATED_OPPONENT_STREAK|STREAK_CLOSED|jugador-alertas|92000004",
    );
  });
});

describe("mergeAlertsRuleset", () => {
  const VALIDO = { version: ALERTS_RULESET_VERSION };

  it("el documento por defecto se puede volver a guardar sin avisos", () => {
    const { ruleset, warnings } = mergeAlertsRuleset(DEFAULT_ALERTS_RULESET);

    expect(warnings).toEqual([]);
    expect(ruleset).toEqual(DEFAULT_ALERTS_RULESET);
  });

  it("un valor que no es un objeto se descarta entero", () => {
    for (const guardado of [null, undefined, "alerts.ruleset", 3, []]) {
      const { ruleset, warnings } = mergeAlertsRuleset(guardado);

      expect(ruleset).toEqual(DEFAULT_ALERTS_RULESET);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("no es un objeto");
    }
  });

  it("una versión distinta invalida el documento entero", () => {
    const { ruleset, warnings } = mergeAlertsRuleset({
      version: ALERTS_RULESET_VERSION + 1,
      thresholds: { shortMatchStreak: 9 },
    });

    expect(ruleset).toEqual(DEFAULT_ALERTS_RULESET);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("se ignoran los umbrales guardados");
  });

  it("aplica un umbral suelto sin tocar los demás", () => {
    const { ruleset, warnings } = mergeAlertsRuleset({
      ...VALIDO,
      thresholds: { repeatedTeammateTotal: 4, shortMatchSeconds: 240 },
    });

    expect(warnings).toEqual([]);
    expect(ruleset.thresholds.repeatedTeammateTotal).toBe(4);
    expect(ruleset.thresholds.shortMatchSeconds).toBe(240);
    expect(ruleset.thresholds.shortMatchStreak).toBe(
      DEFAULT_ALERTS_RULESET.thresholds.shortMatchStreak,
    );
  });

  it("un umbral que no es un entero positivo avisa y deja el de por defecto", () => {
    const { ruleset, warnings } = mergeAlertsRuleset({
      ...VALIDO,
      thresholds: { shortMatchStreak: 0, repeatedTeammateTotal: "muchas" },
    });

    expect(ruleset.thresholds.shortMatchStreak).toBe(
      DEFAULT_ALERTS_RULESET.thresholds.shortMatchStreak,
    );
    expect(ruleset.thresholds.repeatedTeammateTotal).toBe(
      DEFAULT_ALERTS_RULESET.thresholds.repeatedTeammateTotal,
    );
    expect(warnings).toHaveLength(2);
  });

  it("`thresholds` que no es un objeto se descarta entero", () => {
    const { ruleset, warnings } = mergeAlertsRuleset({ ...VALIDO, thresholds: [2, 3, 3, 3] });

    expect(ruleset.thresholds).toEqual(DEFAULT_ALERTS_RULESET.thresholds);
    expect(warnings).toContain("thresholds no es un objeto");
  });

  it("la etiqueta la fija el código, no el documento guardado", () => {
    const { ruleset, warnings } = mergeAlertsRuleset({ ...VALIDO, label: "otro texto" });

    expect(ruleset.label).toBe(DEFAULT_ALERTS_RULESET.label);
    expect(warnings.some((w) => w.startsWith("label se ignora"))).toBe(true);
  });

  it("un umbral que baja de 1 no se aplica: dejaría de existir el tramo", () => {
    // Con 0, `resolveRuns` avisaría de rachas de longitud 0, que no son un hecho.
    const { ruleset } = mergeAlertsRuleset({ ...VALIDO, thresholds: { shortMatchStreak: 0 } });

    expect(ruleset.thresholds.shortMatchStreak).toBeGreaterThan(0);
  });

  it("la clave de `Setting` de los umbrales es la que usa el evaluador", () => {
    expect(ALERTS_RULESET_KEY).toBe("alerts.ruleset");
  });

  it("un documento de la versión 1 anterior a las reglas del resumen sigue siendo válido", () => {
    // Es el documento que hay en producción: siete claves y ninguna de las cuatro
    // nuevas. No sube la versión (el documento no cambia de estructura), así que se
    // completa con los valores por defecto en vez de descartarse entero.
    const guardado = {
      version: 1,
      label: DEFAULT_ALERTS_RULESET.label,
      thresholds: {
        shortMatchSeconds: 240,
        shortMatchStreak: 2,
        shortMatchTotalStep: 5,
        repeatedOpponentStreak: 3,
        repeatedOpponentTotalStep: 10,
        repeatedTeammateStreak: 3,
        repeatedTeammateTotal: 9,
      },
    };

    const { ruleset, warnings } = mergeAlertsRuleset(guardado);

    expect(warnings).toEqual([]);
    expect(ALERTS_RULESET_VERSION).toBe(1);
    // Lo guardado manda donde está.
    expect(ruleset.thresholds.shortMatchSeconds).toBe(240);
    expect(ruleset.thresholds.repeatedTeammateTotal).toBe(9);
    // Y lo que no estaba se queda en el valor por defecto.
    expect(ruleset.thresholds.noVillagersFirstSeconds).toBe(
      DEFAULT_ALERTS_RULESET.thresholds.noVillagersFirstSeconds,
    );
    expect(ruleset.thresholds.noMilitaryGraceSeconds).toBe(
      DEFAULT_ALERTS_RULESET.thresholds.noMilitaryGraceSeconds,
    );
    expect(ruleset.thresholds.noMilitaryGapSeconds).toBe(
      DEFAULT_ALERTS_RULESET.thresholds.noMilitaryGapSeconds,
    );
    expect(ruleset.thresholds.noResourcesGapSeconds).toBe(
      DEFAULT_ALERTS_RULESET.thresholds.noResourcesGapSeconds,
    );
  });

  it("los cuatro umbrales del resumen se pueden retocar como los demás", () => {
    const { ruleset, warnings } = mergeAlertsRuleset({
      ...VALIDO,
      thresholds: {
        noVillagersFirstSeconds: 360,
        noMilitaryGraceSeconds: 240,
        noMilitaryGapSeconds: 480,
        noResourcesGapSeconds: 180,
      },
    });

    expect(warnings).toEqual([]);
    expect(ruleset.thresholds).toMatchObject({
      noVillagersFirstSeconds: 360,
      noMilitaryGraceSeconds: 240,
      noMilitaryGapSeconds: 480,
      noResourcesGapSeconds: 180,
    });
  });
});
