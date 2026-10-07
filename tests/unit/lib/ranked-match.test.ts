import { describe, expect, it } from "vitest";

import { Prisma } from "@/generated/prisma/client";
import {
  RANKED_MODES,
  classificatoryWhere,
  countsAsRanked,
  countsWithinWindow,
  isRankedMode,
  parseWindow,
  rankedMatchSql,
  rankedMatchWhere,
  rankedModesWhere,
  readInstant,
  scoringCutoff,
  windowWhere,
  type ScoringWindow,
} from "@/lib/ranked-match";

/**
 * La definición única de "qué cuenta como partida clasificatoria".
 *
 * Este módulo tiene tres traducciones al mundo real —el `where` de Prisma, el
 * predicado SQL y `countsAsRanked()` fila a fila— y su docblock avisa de que si se
 * toca una hay que tocar las otras dos. Aquí se comprueban las tres, y por encima
 * de eso la semántica de la ventana con su corte de inscripción, que es donde están
 * los bordes que deciden si el torneo puntúa o no.
 */

const VENTANA: ScoringWindow = {
  from: "2026-09-15T00:00:00.000Z",
  to: "2026-10-15T00:00:00.000Z",
};

describe("isRankedMode", () => {
  it("reconoce las dos familias ranked y nada más", () => {
    expect(isRankedMode("rm_solo")).toBe(true);
    expect(isRankedMode("rm_team")).toBe(true);
  });

  it("`rm_1v1` y `rm_ffa` no son familias: son valores literales de la API", () => {
    // El colapso a familia ocurre en `normalize.ts`; aquí solo se compara con la
    // lista, que es la que lee también el SQL.
    for (const valor of ["rm_1v1", "rm_2v2", "qm_ffa", "ew_1v1", "custom_8v8", null, ""]) {
      expect(isRankedMode(valor), String(valor)).toBe(false);
    }
  });

  it("la constante de familias y la lista por defecto del motor coinciden", () => {
    expect([...RANKED_MODES]).toEqual(["rm_solo", "rm_team"]);
  });
});

describe("readInstant", () => {
  it("acepta un instante con zona explícita, en `Z` o con offset", () => {
    expect(readInstant("2026-09-15T00:00:00Z")?.toISOString()).toBe("2026-09-15T00:00:00.000Z");
    expect(readInstant("2026-09-15T02:00:00+02:00")?.toISOString()).toBe(
      "2026-09-15T00:00:00.000Z",
    );
  });

  it("rechaza lo que `Date.parse` admitiría pero no es un instante con zona", () => {
    // `"2026-09-15T00:00:00"` sin zona lo interpretaría Node como hora **local**,
    // así que un `Setting` escrito a mano acabaría aplicando un offset distinto
    // según desde dónde se mirase.
    for (const valor of [
      "2026-09-15",
      "2026-09-15T00:00:00",
      "2026-09-15 00:00:00Z",
      "15/09/2026",
      "ayer",
      "",
      1_700_000_000,
      null,
      undefined,
    ]) {
      expect(readInstant(valor), String(valor)).toBeNull();
    }
  });
});

describe("parseWindow", () => {
  it("normaliza a ISO-8601 UTC lo que venga con otro offset", () => {
    const { window, warnings } = parseWindow(
      { from: "2026-11-01T01:00:00+01:00", to: "2026-12-01T00:00:00+01:00" },
      VENTANA,
    );

    expect(warnings).toEqual([]);
    expect(window).toEqual({ from: "2026-11-01T00:00:00.000Z", to: "2026-11-30T23:00:00.000Z" });
  });

  it("`to: null` abre la ventana por la derecha", () => {
    const { window, warnings } = parseWindow({ from: "2026-11-01T00:00:00Z", to: null }, VENTANA);

    expect(warnings).toEqual([]);
    expect(window.to).toBeNull();
  });

  it("sin `to` se hereda el del documento por defecto y se avisa", () => {
    // El `from` es anterior al `to` por defecto a propósito: si no, la ventana
    // heredada sería inválida y se descartaría entera, que es otro caso.
    const { window, warnings } = parseWindow({ from: "2026-10-01T00:00:00Z" }, VENTANA);

    expect(window).toEqual({ from: "2026-10-01T00:00:00.000Z", to: VENTANA.to });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("escribe null");
  });

  it("un `to` ilegible avisa y cae al del documento por defecto, sin perder el `from`", () => {
    const { window, warnings } = parseWindow({ from: "2026-10-01T00:00:00Z", to: "2026-12-01" }, VENTANA);

    // El `from` era bueno, así que se aplica: la ventana no se tira entera por un
    // `to` que no se ha podido leer.
    expect(window).toEqual({ from: "2026-10-01T00:00:00.000Z", to: VENTANA.to });
    expect(warnings.some((w) => w.includes("window.to"))).toBe(true);
  });

  it("sin `from` la ventana se descarta entera", () => {
    for (const valor of [undefined, null, "", "2026-11-01", 3]) {
      const { window, warnings } = parseWindow({ from: valor, to: null }, VENTANA);

      expect(window).toEqual(VENTANA);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("window.from");
    }
  });

  it("un `to` anterior o igual al `from` se descarta: no puntuaría nada", () => {
    const { window, warnings } = parseWindow(
      { from: "2026-10-15T00:00:00Z", to: "2026-09-15T00:00:00Z" },
      VENTANA,
    );

    expect(window).toEqual(VENTANA);
    expect(warnings.some((w) => w.includes("no puntuaría nada"))).toBe(true);
  });

  it("una ventana que no es un objeto se descarta sin lanzar", () => {
    for (const valor of [null, "2026-11-01", 42, []]) {
      const { window, warnings } = parseWindow(valor, VENTANA);

      expect(window).toEqual(VENTANA);
      expect(warnings).toEqual(["window no es un objeto"]);
    }
  });

  it("el documento por defecto se puede volver a guardar sin avisos", () => {
    const { window, warnings } = parseWindow(VENTANA, VENTANA);

    expect(warnings).toEqual([]);
    expect(window).toEqual(VENTANA);
  });
});

describe("countsWithinWindow", () => {
  it("`from` es inclusive y `to` es exclusivo", () => {
    expect(countsWithinWindow(new Date("2026-09-15T00:00:00.000Z"), VENTANA, null)).toBe(true);
    expect(countsWithinWindow(new Date("2026-10-14T23:59:59.999Z"), VENTANA, null)).toBe(true);
    expect(countsWithinWindow(new Date("2026-10-15T00:00:00.000Z"), VENTANA, null)).toBe(false);
    expect(countsWithinWindow(new Date("2026-09-14T23:59:59.999Z"), VENTANA, null)).toBe(false);
  });

  it("con `to` a `null` no hay límite por la derecha", () => {
    const abierta: ScoringWindow = { from: "2026-09-15T00:00:00.000Z", to: null };

    expect(countsWithinWindow(new Date("2099-01-01T00:00:00Z"), abierta, null)).toBe(true);
  });

  it("un límite ilegible hace que no cuente, en vez de comparar con `NaN`", () => {
    // La dirección segura: repartir puntos que no tocan sería peor que no
    // repartir ninguno.
    const rota: ScoringWindow = { from: "ayer", to: "mañana" };

    expect(countsWithinWindow(new Date("2026-09-20T00:00:00Z"), rota, null)).toBe(false);
    // Tampoco un `registeredAt` válido rescata un `from` ilegible: `Math.max` lo
    // propaga, así que el corte queda en `NaN` y la comparación vuelve a fallar.
    expect(
      countsWithinWindow(new Date("2026-09-20T00:00:00Z"), rota, new Date("2020-01-01T00:00:00Z")),
    ).toBe(false);
  });
});

describe("scoringCutoff", () => {
  const antes = new Date("2026-09-01T00:00:00.000Z");
  const dentro = new Date("2026-09-20T12:00:00.000Z");
  const despues = new Date("2026-09-30T00:00:00.000Z");

  it("un `registeredAt` anterior a la ventana no la acorta", () => {
    expect(scoringCutoff(VENTANA, antes).toISOString()).toBe(VENTANA.from);
    expect(scoringCutoff(VENTANA, antes).toISOString()).toBe(new Date(VENTANA.from).toISOString());
  });

  it("un `registeredAt` posterior mueve el corte hasta él", () => {
    expect(scoringCutoff(VENTANA, despues).toISOString()).toBe(despues.toISOString());
  });

  it("`null` deja el corte donde estaba: el principio de la ventana", () => {
    expect(scoringCutoff(VENTANA, null).toISOString()).toBe(new Date(VENTANA.from).toISOString());
  });

  it("el corte es inclusivo, igual que `window.from`", () => {
    // El mismo milisegundo cuenta: quien se inscribe a las 12:00 juega a las 12:00.
    expect(scoringCutoff(VENTANA, dentro).toISOString()).toBe(dentro.toISOString());
    expect(countsWithinWindow(dentro, VENTANA, dentro)).toBe(true);
    expect(countsWithinWindow(new Date(dentro.getTime() - 1), VENTANA, dentro)).toBe(false);
  });

  it("un `registeredAt` posterior al `to` deja al jugador sin nada que puntúe", () => {
    // Es la dirección correcta y no un borde raro: un alta posterior al fin del
    // torneo no tiene ninguna partida que le pueda puntuar. El corte se lleva por
    // delante el `to`, así que ni una partida posterior al `to` cuenta.
    const altaTardisima = new Date("2026-10-20T00:00:00.000Z");

    expect(countsWithinWindow(new Date("2026-10-01T00:00:00Z"), VENTANA, altaTardisima)).toBe(
      false,
    );
    expect(countsWithinWindow(new Date("2026-10-19T00:00:00Z"), VENTANA, altaTardisima)).toBe(
      false,
    );
    // Y el `to` exclusivo sigue mandando por encima del corte: con `registeredAt`
    // anterior a `to`, la partida de justo en `to` no cuenta igual.
    expect(countsWithinWindow(new Date(VENTANA.to!), VENTANA, dentro)).toBe(false);
    expect(countsWithinWindow(new Date("2026-10-14T23:59:59.999Z"), VENTANA, dentro)).toBe(true);
  });
});

describe("el corte de inscripción", () => {
  // Inscrito antes de la ventana: cuenta desde `window.from`. Es el comportamiento
  // que ya había, y el test está para que no se rompa al añadir la condición.
  const antesDeLaVentana = new Date("2026-09-01T00:00:00.000Z");
  // La organización lo da de alta a mitad de torneo.
  const altaTardia = new Date("2026-09-20T12:00:00.000Z");

  const partida = (startedAt: string) => ({
    mode: "rm_solo",
    result: "WIN" as const,
    startedAt: new Date(startedAt),
    finishedAt: new Date("2026-10-01T00:00:00.000Z"),
    revertedAt: null,
  });

  it("un jugador inscrito antes de la ventana cuenta desde `window.from`", () => {
    const antesDelAlta = partida("2026-09-16T10:00:00.000Z");

    expect(countsAsRanked(antesDelAlta, VENTANA, antesDeLaVentana)).toBe(true);
    // Y lo que hay antes de la ventana sigue sin contar: es el comportamiento viejo.
    expect(countsAsRanked(partida("2026-09-14T23:59:59.999Z"), VENTANA, antesDeLaVentana)).toBe(
      false,
    );
  });

  it("un alta posterior no cuenta las partidas de antes de la inscripción", () => {
    const antesDelAlta = partida("2026-09-16T10:00:00.000Z");
    const justoEnElAlta = partida("2026-09-20T12:00:00.000Z");
    const despuesDelAlta = partida("2026-09-21T10:00:00.000Z");

    // La misma partida que con `null` cuenta, con un alta posterior no: es el
    // problema que la regla viene a resolver.
    expect(countsAsRanked(antesDelAlta, VENTANA, null)).toBe(true);
    expect(countsAsRanked(antesDelAlta, VENTANA, altaTardia)).toBe(false);

    // El corte es inclusivo, y lo de después sí cuenta.
    expect(countsAsRanked(justoEnElAlta, VENTANA, altaTardia)).toBe(true);
    expect(countsAsRanked(despuesDelAlta, VENTANA, altaTardia)).toBe(true);
  });

  it("`registeredAt: null` es lo mismo que inscriptionarse antes de la ventana", () => {
    for (const instante of [
      "2026-09-14T23:59:59.999Z",
      "2026-09-15T00:00:00.000Z",
      "2026-09-20T12:00:00.000Z",
      "2026-10-14T23:59:59.999Z",
      "2026-10-15T00:00:00.000Z",
    ]) {
      expect(countsAsRanked(partida(instante), VENTANA, null), instante).toBe(
        countsAsRanked(partida(instante), VENTANA, antesDeLaVentana),
      );
    }
  });

  it("el corte no destapa las otras cuatro condiciones", () => {
    // Un alta posterior no arregla una partida sin resolver, ni de una familia que
    // no puntúa, ni una revertida, ni una que empieza después de `window.to`. Se
    // comprueba con `null` y con el alta tardío: el corte solo añade una condición,
    // no quita ninguna.
    for (const override of [
      { finishedAt: null },
      { result: null },
      { revertedAt: new Date("2026-09-22T00:00:00Z") },
      { mode: "qm_1v1" },
      { mode: null },
      { startedAt: new Date("2026-10-15T00:00:00.000Z") },
    ]) {
      const conOverride = { ...partida("2026-09-21T10:00:00.000Z"), ...override };

      expect(countsAsRanked(conOverride, VENTANA, null), JSON.stringify(override)).toBe(false);
      expect(countsAsRanked(conOverride, VENTANA, altaTardia), JSON.stringify(override)).toBe(false);
    }
  });
});

describe("las tres traducciones dicen lo mismo", () => {
  it("`classificatoryWhere` es `rankedMatchWhere` menos la marca de revertida", () => {
    // La única diferencia entre las dos es deliberada: el historial del panel tiene
    // que *enseñar* las revertidas y el motor no puede contarlas. Y es la única,
    // también con el corte puesto: los dos filtros llevan el mismo `registeredAt`.
    for (const registeredAt of [null, new Date("2026-09-20T12:00:00.000Z")]) {
      const completa = rankedMatchWhere(["rm_solo"], VENTANA, registeredAt);
      const { revertedAt, ...clasificatoria } = completa;

      expect(revertedAt).toBeNull();
      expect(clasificatoria).toEqual(classificatoryWhere(["rm_solo"], VENTANA, registeredAt));
    }
  });

  it("el filtro trae familia, partida resuelta, corte y `revertedAt` a null", () => {
    expect(rankedMatchWhere(["rm_solo", "rm_team"], VENTANA, null)).toEqual({
      mode: { in: ["rm_solo", "rm_team"] },
      result: { not: null },
      finishedAt: { not: null },
      startedAt: { gte: new Date("2026-09-15T00:00:00.000Z"), lt: new Date("2026-10-15T00:00:00.000Z") },
      revertedAt: null,
    });
  });

  it("el filtro de Prisma sube el límite inferior al corte de inscripción", () => {
    // Es lo que esta traducción puede hacer y el SQL no: aquí el jugador ya se
    // conoce, así que el `max` se resuelve antes de generar la consulta.
    const alta = new Date("2026-09-20T12:00:00.000Z");

    expect(windowWhere(VENTANA, alta)).toEqual({
      startedAt: { gte: alta, lt: new Date("2026-10-15T00:00:00.000Z") },
    });
    // Un alta anterior a la ventana no la mueve, y `null` tampoco.
    expect(windowWhere(VENTANA, new Date("2026-09-01T00:00:00.000Z"))).toEqual(
      windowWhere(VENTANA, null),
    );
  });

  it("`rankedModesWhere` solo aplica la familia, y la lista sale del ruleset", () => {
    // Es el filtro de `/partidas`, donde la partida en curso no puede cumplir la
    // regla entera por definición; no por eso el motor puede quedarse solo con la
    // familia.
    expect(rankedModesWhere(["rm_solo"])).toEqual({ mode: { in: ["rm_solo"] } });
  });

  it("`windowWhere` con `to: null` solo pone el límite inferior", () => {
    expect(windowWhere({ from: "2026-09-15T00:00:00.000Z", to: null }, null)).toEqual({
      startedAt: { gte: new Date("2026-09-15T00:00:00.000Z") },
    });
  });

  it("el predicado SQL lleva las mismas cinco condiciones", () => {
    const sql = rankedMatchSql(
      Prisma.sql`m`,
      Prisma.sql`p`,
      [...RANKED_MODES],
      VENTANA,
    ) as unknown as {
      sql: string;
      values: unknown[];
    };

    expect(sql.sql).toBe(
      'm."mode" in (?,?) and m."result" is not null and m."finishedAt" is not null and ' +
        'm."revertedAt" is null and m."startedAt" >= ?::timestamp and m."startedAt" < ?::timestamp ' +
        'and (p."registeredAt" is null or m."startedAt" >= p."registeredAt")',
    );
    // El corte va **como columna de `Player`**, no como parámetro: por eso esta
    // traducción sirve para una consulta que abarque a todos los jugadores, que es
    // justo lo que el `where` de Prisma no puede hacer.
    expect(sql.sql).toContain('p."registeredAt" is null');
    // Los límites viajan como texto UTC **sin zona** y con el cast explícito: pasar
    // el literal a `timestamptz` y de ahí a `timestamp` sí dependería de la zona de
    // la sesión, que es lo que el docblock midió en esta base de datos.
    expect(sql.values).toEqual([
      "rm_solo",
      "rm_team",
      "2026-09-15 00:00:00.000",
      "2026-10-15 00:00:00.000",
    ]);
  });

  it("el predicado SQL con `to: null` se queda solo con el límite inferior", () => {
    const sql = rankedMatchSql(Prisma.sql`m`, Prisma.sql`p`, ["rm_solo"], {
      from: "2026-09-15T00:00:00.000Z",
      to: null,
    }) as unknown as { sql: string; values: unknown[] };

    expect(sql.sql).not.toContain("< ?::timestamp");
    expect(sql.sql).toContain('(p."registeredAt" is null');
    expect(sql.values).toEqual(["rm_solo", "2026-09-15 00:00:00.000"]);
  });

  it("los modos se parametrizan, no se interpolan en el texto", () => {
    // La lista de familias viene de `Setting` y de la API, así que al SQL llega
    // como valor y no como texto: nada de lo que escriba alguien se concatena en
    // una sentencia.
    const modo = "rm_solo'; drop table \"Match\"; --";
    const sql = rankedMatchSql(Prisma.sql`m`, Prisma.sql`p`, [modo], {
      from: "2026-09-15T00:00:00.000Z",
      to: null,
    }) as unknown as { sql: string; values: unknown[] };

    expect(sql.sql).toContain('m."mode" in (?)');
    expect(sql.sql).not.toContain("drop table");
    expect(sql.values).toEqual([modo, "2026-09-15 00:00:00.000"]);
  });
});
