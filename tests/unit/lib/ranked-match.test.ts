import { describe, expect, it } from "vitest";

import { Prisma } from "@/generated/prisma/client";
import {
  RANKED_MODES,
  classificatoryWhere,
  countsWithinWindow,
  isRankedMode,
  parseWindow,
  rankedMatchSql,
  rankedMatchWhere,
  rankedModesWhere,
  readInstant,
  windowWhere,
  type ScoringWindow,
} from "@/lib/ranked-match";

/**
 * La definición única de "qué cuenta como partida clasificatoria".
 *
 * Este módulo tiene tres traducciones al mundo real —el `where` de Prisma, el
 * predicado SQL y `countsAsRanked()` fila a fila— y su docblock avisa de que si se
 * toca una hay que tocar las otras dos. Aquí se comprueban las tres, y por encima
 * de eso la semántica de la ventana, que es donde están los bordes que deciden si
 * el torneo puntúa o no.
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
    expect(countsWithinWindow(new Date("2026-09-15T00:00:00.000Z"), VENTANA)).toBe(true);
    expect(countsWithinWindow(new Date("2026-10-14T23:59:59.999Z"), VENTANA)).toBe(true);
    expect(countsWithinWindow(new Date("2026-10-15T00:00:00.000Z"), VENTANA)).toBe(false);
    expect(countsWithinWindow(new Date("2026-09-14T23:59:59.999Z"), VENTANA)).toBe(false);
  });

  it("con `to` a `null` no hay límite por la derecha", () => {
    const abierta: ScoringWindow = { from: "2026-09-15T00:00:00.000Z", to: null };

    expect(countsWithinWindow(new Date("2099-01-01T00:00:00Z"), abierta)).toBe(true);
  });

  it("un límite ilegible hace que no cuente, en vez de comparar con `NaN`", () => {
    // La dirección segura: repartir puntos que no tocan sería peor que no
    // repartir ninguno.
    const rota: ScoringWindow = { from: "ayer", to: "mañana" };

    expect(countsWithinWindow(new Date("2026-09-20T00:00:00Z"), rota)).toBe(false);
  });
});

describe("las tres traducciones dicen lo mismo", () => {
  it("`classificatoryWhere` es `rankedMatchWhere` menos la marca de revertida", () => {
    // La única diferencia entre las dos es deliberada: el historial del panel tiene
    // que *enseñar* las revertidas y el motor no puede contarlas.
    const completa = rankedMatchWhere(["rm_solo"], VENTANA);
    const { revertedAt, ...clasificatoria } = completa;

    expect(revertedAt).toBeNull();
    expect(clasificatoria).toEqual(classificatoryWhere(["rm_solo"], VENTANA));
  });

  it("el filtro trae familia, partida resuelta, ventana y `revertedAt` a null", () => {
    expect(rankedMatchWhere(["rm_solo", "rm_team"], VENTANA)).toEqual({
      mode: { in: ["rm_solo", "rm_team"] },
      result: { not: null },
      finishedAt: { not: null },
      startedAt: { gte: new Date("2026-09-15T00:00:00.000Z"), lt: new Date("2026-10-15T00:00:00.000Z") },
      revertedAt: null,
    });
  });

  it("`rankedModesWhere` solo aplica la familia, y la lista sale del ruleset", () => {
    // Es el filtro de `/partidas`, donde la partida en curso no puede cumplir la
    // regla entera por definición; no por eso el motor puede quedarse solo con la
    // familia.
    expect(rankedModesWhere(["rm_solo"])).toEqual({ mode: { in: ["rm_solo"] } });
  });

  it("`windowWhere` con `to: null` solo pone el límite inferior", () => {
    expect(windowWhere({ from: "2026-09-15T00:00:00.000Z", to: null })).toEqual({
      startedAt: { gte: new Date("2026-09-15T00:00:00.000Z") },
    });
  });

  it("el predicado SQL lleva las mismas cuatro condiciones", () => {
    const sql = rankedMatchSql(Prisma.sql`m`, [...RANKED_MODES], VENTANA) as unknown as {
      sql: string;
      values: unknown[];
    };

    expect(sql.sql).toBe(
      'm."mode" in (?,?) and m."result" is not null and m."finishedAt" is not null and ' +
        'm."revertedAt" is null and m."startedAt" >= ?::timestamp and m."startedAt" < ?::timestamp',
    );
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
    const sql = rankedMatchSql(Prisma.sql`m`, ["rm_solo"], {
      from: "2026-09-15T00:00:00.000Z",
      to: null,
    }) as unknown as { sql: string; values: unknown[] };

    expect(sql.sql).not.toContain("< ?::timestamp");
    expect(sql.values).toEqual(["rm_solo", "2026-09-15 00:00:00.000"]);
  });

  it("los modos se parametrizan, no se interpolan en el texto", () => {
    // La lista de familias viene de `Setting` y de la API, así que al SQL llega
    // como valor y no como texto: nada de lo que escriba alguien se concatena en
    // una sentencia.
    const modo = "rm_solo'; drop table \"Match\"; --";
    const sql = rankedMatchSql(Prisma.sql`m`, [modo], {
      from: "2026-09-15T00:00:00.000Z",
      to: null,
    }) as unknown as { sql: string; values: unknown[] };

    expect(sql.sql).toContain('m."mode" in (?)');
    expect(sql.sql).not.toContain("drop table");
    expect(sql.values).toEqual([modo, "2026-09-15 00:00:00.000"]);
  });
});
