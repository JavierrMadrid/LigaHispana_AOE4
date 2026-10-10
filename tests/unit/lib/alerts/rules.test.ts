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
  mergeAlertsRuleset,
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
  it("las once reglas y los cuatro tipos tienen su rótulo en español", () => {
    // El `satisfies Record<...>` del módulo obliga a decidir la etiqueta al añadir
    // una regla; aquí se comprueba que ninguna se quedó sin él ni con el mismo
    // texto que otra. Las once reglas son las ocho de comportamiento más las tres de
    // estado (las dos del historial de partidas y la de Discord), y los cuatro tipos
    // son las tres rachas/acumulados más `STATE_DETECTED`.
    const etiquetas = Object.values(ALERT_RULE_LABELS);

    expect(Object.keys(ALERT_RULE_LABELS)).toHaveLength(11);
    expect(Object.keys(ALERT_KIND_LABELS)).toHaveLength(4);
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

  it("R4 dice la brecha cuando la trae y el texto genérico cuando no", () => {
    expect(
      alertSummary(disparo({ rule: "TEAMMATE_ELO_GAP", count: 1, detail: { eloGap: 500 } })),
    ).toBe("1 partida de equipo con un compañero a 500 de elo");
    expect(alertSummary(disparo({ rule: "TEAMMATE_ELO_GAP" }))).toContain(
      "muy por encima o por debajo",
    );
  });

  it("R5 concuerda el número de escalones y conserva el sentido", () => {
    expect(
      alertSummary(disparo({ rule: "LOW_DIVISION_TEAM_GAME", detail: { steps: 1 } })),
    ).toContain("1 escalón");
    expect(
      alertSummary(disparo({ rule: "LOW_DIVISION_TEAM_GAME", detail: { steps: 3 } })),
    ).toContain("3 escalones");
    // `steps` negativo es que la partida está por encima del jugador.
    expect(
      alertSummary(disparo({ rule: "LOW_DIVISION_TEAM_GAME", detail: { steps: -3 } })),
    ).toContain("por encima");
    expect(alertSummary(disparo({ rule: "LOW_DIVISION_TEAM_GAME" }))).toContain(
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
    for (const rule of ["HISTORY_NOT_PUBLIC", "MISSING_LADDER_MATCHES"] as const) {
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
      // historial"), nunca en tercera persona con nombre.
      expect(frase).toMatch(/^(Su |La ladder)/);
      // Palabras que serían una acusación o una causa, que es justo lo que no se sabe.
      expect(frase).not.toMatch(/culpa|trampa|mentir|false|intencionad|mal hecho/i);
      // Y tampoco "al cerrar el torneo": un estado no se cierra, se comprueba.
      expect(frase).not.toContain("al cerrar el torneo");
    }
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
    const detalles = alertDetails(disparo({ detail: { eloGap: 500, durationSeconds: 1800 } }));

    expect(detalles).toMatchObject({ eloGap: 500, durationSeconds: 1800 });
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
      thresholds: { teammateEloGap: 900 },
    });

    expect(ruleset).toEqual(DEFAULT_ALERTS_RULESET);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("se ignoran los umbrales guardados");
  });

  it("aplica un umbral suelto sin tocar los otros ocho", () => {
    const { ruleset, warnings } = mergeAlertsRuleset({
      ...VALIDO,
      thresholds: { teammateEloGap: 900, lowDivisionSteps: 4 },
    });

    expect(warnings).toEqual([]);
    expect(ruleset.thresholds.teammateEloGap).toBe(900);
    expect(ruleset.thresholds.lowDivisionSteps).toBe(4);
    expect(ruleset.thresholds.shortMatchSeconds).toBe(
      DEFAULT_ALERTS_RULESET.thresholds.shortMatchSeconds,
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
});
