import { describe, expect, it } from "vitest";

import {
  aoe4WorldProfileUrl,
  describeMode,
  describeTeamSize,
  formatRelativeTime,
  kickChannelUrl,
  teamSizesFromRawJson,
  twitchChannelUrl,
  youtubeChannelUrl,
} from "@/lib/format";

/**
 * La capa de presentación en texto.
 *
 * No hay nada que decidir aquí salvo los bordes, y son los que se prueban: los `null`
 * que llegan desde el historial del panel, la FFA que la API nombra de tres maneras
 * y los equipos desiguales de una partida que alguien abandonó.
 */

const AHORA = new Date("2026-09-20T20:00:00.000Z");

function hace(segundos: number): Date {
  return new Date(AHORA.getTime() - segundos * 1000);
}

describe("formatRelativeTime", () => {
  it("menos de un minuto dice «ahora mismo»", () => {
    expect(formatRelativeTime(AHORA, AHORA)).toBe("ahora mismo");
    expect(formatRelativeTime(hace(59), AHORA)).toBe("ahora mismo");
  });

  it("a partir de un minuto cuenta en minutos u horas", () => {
    expect(formatRelativeTime(hace(12 * 60), AHORA)).toContain("12");
    expect(formatRelativeTime(hace(3 * 3_600), AHORA)).toContain("3");
  });

  it("a partir de una semana da la fecha, que es lo único situable", () => {
    // De aquí en adelante la distancia deja de importar para quien lee.
    const resultado = formatRelativeTime(hace(14 * 24 * 3_600), AHORA);

    expect(resultado).not.toContain("hace");
    expect(resultado.length).toBeGreaterThan(0);
  });

  it("una fecha en el futuro no sale como tiempo negativo", () => {
    // Pasa con un desajuste de reloj entre el Worker y la API; lo que hay que
    // pintar es el presente, no un "dentro de 2 minutos".
    const futuro = new Date(AHORA.getTime() + 120_000);

    expect(formatRelativeTime(futuro, AHORA)).toBe("ahora mismo");
  });
});

describe("los enlaces", () => {
  it("el perfil de AoE4World se compone con el `profileId`", () => {
    expect(aoe4WorldProfileUrl(1234)).toBe("https://aoe4world.com/players/1234");
  });

  it("cada plataforma pone la arroba donde le toca, y no donde no", () => {
    // Es lo único que distingue un handle de YouTube del nombre de un canal de
    // Twitch, y por eso las tres tienen su propia función en vez de una plantilla.
    expect(twitchChannelUrl("beastwizard")).toBe("https://twitch.tv/beastwizard");
    expect(youtubeChannelUrl("beastwizard")).toBe("https://www.youtube.com/@beastwizard");
    expect(kickChannelUrl("beastwizard")).toBe("https://www.kick.com/beastwizard");
  });
});

describe("describeMode", () => {
  it("con tamaño en la ladder, el tamaño manda", () => {
    // `Match.mode` colapsa 2v2, 3v3 y 4v4 en `rm_team`, así que el tamaño solo se
    // puede leer de `leaderboard`.
    expect(describeMode("rm_team", "rm_2v2")).toBe("2v2");
    expect(describeMode("rm_team", "rm_3v3")).toBe("3v3");
    expect(describeMode("rm_team", "rm_4v4")).toBe("4v4");
    expect(describeMode("rm_solo", "rm_1v1")).toBe("1vs1");
  });

  it("sin tamaño se cae al nombre de la familia", () => {
    expect(describeMode("rm_team", "rm_team")).toBe("Por equipos");
    expect(describeMode("rm_solo", "rm_solo")).toBe("1vs1");
  });

  it("la FFA se reconoce por familia, no por igualdad de nombre", () => {
    // La API no la publica siempre igual, y con las tres formas hay que etiquetarla
    // igual: un `qm_ffa` suelto no le dice nada a quien está leyendo la partida.
    for (const ladder of ["qm_ffa", "ffa_ffa", "qm_ffa_nomad"]) {
      expect(describeMode(null, ladder), ladder).toBe("FFA");
    }
    expect(describeMode("ffa_ffa", null)).toBe("FFA");
  });

  it("`ffa` cuenta como segmento entero, no como subcadena", () => {
    // Los guiones bajos a los lados son los que impiden que un nombre que lleva `ffa`
    // dentro de otra palabra se etiquete como free-for-all.
    expect(describeMode("rm_ffa_equipo", null)).toBe("FFA");
    expect(describeMode("myffaqm", null)).toBe("myffaqm");
    expect(describeMode("qmaffa", null)).toBe("qmaffa");
    expect(describeMode("ffa2v2", null)).toBe("ffa2v2");
  });

  it("un modo desconocido sale tal cual, en vez de esconderse", () => {
    // Mejor un código raro que un dato que no cuadra.
    expect(describeMode("ew_1v1", "ew_1v1")).toBe("ew_1v1");
    expect(describeMode("custom_8v8", null)).toBe("custom_8v8");
  });

  it("sin ladder y sin modo devuelve cadena vacía, no un formato inventado", () => {
    // Es el caso de una fila de objetivo cumplido del historial: no es una partida y
    // no tiene por qué describirse como si lo fuera.
    expect(describeMode(null, null)).toBe("");
  });

  it("el tamaño manda también sobre la familia: un `rm_team` con tamaño es 2v2", () => {
    expect(describeMode("rm_team", "rm_1v1")).toBe("1vs1");
  });
});

describe("describeTeamSize", () => {
  it("dos bandos del mismo tamaño dan ese tamaño", () => {
    expect(describeTeamSize([1, 1])).toBe("1vs1");
    expect(describeTeamSize([2, 2])).toBe("2v2");
    expect(describeTeamSize([4, 4])).toBe("4v4");
  });

  it("equipos desiguales devuelven `null` y quien llama cae en `describeMode`", () => {
    // Un abandono deja un 2 contra 1, y llamarlo "2v2" no cuadraría con los nombres
    // que se están pintando al lado.
    expect(describeTeamSize([2, 1])).toBeNull();
    expect(describeTeamSize([1, 2])).toBeNull();
  });

  it("más de dos bandos no es un `NvN`: es una FFA", () => {
    expect(describeTeamSize([1, 1, 1, 1])).toBeNull();
    expect(describeTeamSize([1])).toBeNull();
    expect(describeTeamSize([])).toBeNull();
  });

  it("un bando vacío no da tamaño", () => {
    expect(describeTeamSize([0, 0])).toBeNull();
  });
});

describe("teamSizesFromRawJson", () => {
  it("lee el recuento de cada equipo del payload", () => {
    // El historial no tiene la alineación a la vista y aun así necesita el tamaño: en
    // las columnas un 2v2 llega con `leaderboard: "rm_team"`, que no dice cuántos
    // juegan.
    expect(
      teamSizesFromRawJson({
        teams: [
          [{ player: { profile_id: 1 } }, { player: { profile_id: 2 } }],
          [{ player: { profile_id: 3 } }, { player: { profile_id: 4 } }],
        ],
      }),
    ).toEqual([2, 2]);
  });

  it("lo que no se puede asegurar devuelve lista vacía, y no un 2v2 inventado", () => {
    for (const valor of [null, undefined, "texto", 42, {}, { teams: "no es una lista" }]) {
      expect(teamSizesFromRawJson(valor), String(valor)).toEqual([]);
    }
  });

  it("los equipos que no son listas se saltan, sin correr los índices", () => {
    // Si se dejaran, el recuento de bandos se desplazaría y `describeTeamSize`
    // compararía los equipos equivocados.
    expect(teamSizesFromRawJson({ teams: ["basura", [1, 2, 3], {}] })).toEqual([3]);
  });
});
