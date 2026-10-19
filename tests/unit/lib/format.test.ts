import { describe, expect, it } from "vitest";

import {
  aoe4WorldGameUrl,
  aoe4WorldProfileUrl,
  countdownParts,
  countdownTarget,
  describeMode,
  describeTeamSize,
  formatRelativeTime,
  formatTournamentWindow,
  kickChannelUrl,
  multistreamViewerUrl,
  teamSizesFromRawJson,
  twitchChannelUrl,
  youtubeChannelUrl,
  type StreamChannel,
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

  it("a partir de un día desglosa días y horas", () => {
    // Decir "hace 53 h" obliga a dividir mentalmente; el día y la hora se leen de un
    // vistazo.
    expect(formatRelativeTime(hace(24 * 3_600), AHORA)).toBe("hace 1 día");
    expect(formatRelativeTime(hace(25 * 3_600), AHORA)).toBe("hace 1 día y 1 hora");
    expect(formatRelativeTime(hace(49 * 3_600), AHORA)).toBe("hace 2 días y 1 hora");
    expect(formatRelativeTime(hace(47 * 3_600), AHORA)).toBe("hace 1 día y 23 horas");
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

  it("la partida de AoE4World cuelga del perfil y lleva el `gameId`", () => {
    expect(aoe4WorldGameUrl(1234, "161283541")).toBe(
      "https://aoe4world.com/players/1234/games/161283541",
    );
  });

  it("cada plataforma pone la arroba donde le toca, y no donde no", () => {
    // Es lo único que distingue un handle de YouTube del nombre de un canal de
    // Twitch, y por eso las tres tienen su propia función en vez de una plantilla.
    expect(twitchChannelUrl("beastwizard")).toBe("https://twitch.tv/beastwizard");
    expect(youtubeChannelUrl("beastwizard")).toBe("https://www.youtube.com/@beastwizard");
    expect(kickChannelUrl("beastwizard")).toBe("https://www.kick.com/beastwizard");
  });
});

describe("multistreamViewerUrl", () => {
  const twitch = (channel: string): StreamChannel => ({ platform: "twitch", channel });
  const kick = (channel: string): StreamChannel => ({ platform: "kick", channel });
  const youtube = (channel: string): StreamChannel => ({ platform: "youtube", channel });

  it("compone la URL con el prefijo de cada plataforma", () => {
    // El formato es el que documenta la herramienta: `t:` para Twitch, `k:` para Kick.
    expect(multistreamViewerUrl([twitch("alfa"), kick("beta")])).toBe(
      "https://streamscharts.com/tools/multistream-viewer/t:alfa,k:beta",
    );
  });

  it("respeta el orden de la lista, que es el de los participantes", () => {
    // Determinista: dos lecturas de la misma partida no pueden dar enlaces distintos.
    expect(multistreamViewerUrl([kick("uno"), twitch("dos"), twitch("tres")])).toBe(
      "https://streamscharts.com/tools/multistream-viewer/k:uno,t:dos,t:tres",
    );
  });

  it("quita los repetidos aunque estén separados", () => {
    // Dos participantes apuntando al mismo canal no son dos canales que meter.
    expect(multistreamViewerUrl([twitch("alfa"), kick("beta"), twitch("alfa")])).toBe(
      "https://streamscharts.com/tools/multistream-viewer/t:alfa,k:beta",
    );
  });

  it("un mismo nombre en dos plataformas son dos canales distintos", () => {
    // El token lleva el prefijo, así que `t:x` y `k:x` no se pisan.
    expect(multistreamViewerUrl([twitch("alfa"), kick("alfa")])).toBe(
      "https://streamscharts.com/tools/multistream-viewer/t:alfa,k:alfa",
    );
  });

  it("ignora YouTube: su prefijo no está verificado y queda fuera del visor", () => {
    // Aunque vengan dos canales de YouTube, no hay ninguno que meter.
    expect(multistreamViewerUrl([youtube("alfa"), youtube("beta")])).toBeNull();
  });

  it("YouTube no cuenta para llegar a dos, pero no estorba a Twitch ni a Kick", () => {
    expect(multistreamViewerUrl([twitch("alfa"), youtube("beta")])).toBeNull();
    expect(multistreamViewerUrl([twitch("alfa"), youtube("beta"), kick("gamma")])).toBe(
      "https://streamscharts.com/tools/multistream-viewer/t:alfa,k:gamma",
    );
  });

  it("con menos de dos canales no hay visor", () => {
    // Un "multi-stream" de uno no es nada: es el enlace de un canal.
    expect(multistreamViewerUrl([])).toBeNull();
    expect(multistreamViewerUrl([twitch("alfa")])).toBeNull();
    expect(multistreamViewerUrl([kick("beta")])).toBeNull();
  });

  it("un canal en blanco no cuenta como canal", () => {
    // Un `t:` suelto sería un visor roto que parece un visor con canal.
    expect(multistreamViewerUrl([twitch(""), kick("beta")])).toBeNull();
    expect(multistreamViewerUrl([twitch("   "), twitch("alfa"), kick("beta")])).toBe(
      "https://streamscharts.com/tools/multistream-viewer/t:alfa,k:beta",
    );
  });

  it("los repetidos se cuentan después de descartar, no antes", () => {
    // Un blanco repetido no puede colar como el segundo canal que sube el total.
    expect(multistreamViewerUrl([twitch(""), twitch(""), kick("beta")])).toBeNull();
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

describe("formatTournamentWindow", () => {
  it("con los dos límites en el mismo año, el año se dice una vez", () => {
    expect(
      formatTournamentWindow({
        from: "2026-09-15T00:00:00.000Z",
        to: "2026-10-15T00:00:00.000Z",
      }),
    ).toBe("Del 15 de septiembre al 15 de octubre de 2026");
  });

  it("una ventana abierta se lee como «desde»", () => {
    // `to: null` es una ventana sin fin: la organización puede fijarlo más tarde
    // sin desplegar.
    expect(
      formatTournamentWindow({ from: "2026-09-15T00:00:00.000Z", to: null }),
    ).toBe("Desde el 15 de septiembre de 2026");
  });

  it("si los límites cruzan el año, cada fecha lleva el suyo", () => {
    expect(
      formatTournamentWindow({
        from: "2026-12-01T00:00:00.000Z",
        to: "2027-01-15T00:00:00.000Z",
      }),
    ).toBe("Del 1 de diciembre de 2026 al 15 de enero de 2027");
  });
});

describe("countdownParts", () => {
  it("desglosa días, horas y minutos", () => {
    const to = new Date(AHORA.getTime() + ((2 * 24 + 3) * 60 + 5) * 60_000);

    expect(countdownParts(to, AHORA)).toEqual({ days: 2, hours: 3, minutes: 5 });
  });

  it("por debajo de un día, los días son cero", () => {
    const to = new Date(AHORA.getTime() + (5 * 60 + 30) * 60_000);

    expect(countdownParts(to, AHORA)).toEqual({ days: 0, hours: 5, minutes: 30 });
  });

  it("trunca al minuto, nunca redondea al alza", () => {
    // 59 s no es un minuto: prometerlo sería regalar tiempo que no queda.
    expect(countdownParts(new Date(AHORA.getTime() + 59_000), AHORA)).toEqual({
      days: 0,
      hours: 0,
      minutes: 0,
    });
    expect(countdownParts(new Date(AHORA.getTime() + 7_199_000), AHORA)).toEqual({
      days: 0,
      hours: 1,
      minutes: 59,
    });
  });

  it("cuando el torneo ya terminó devuelve `null`, no un contador a cero", () => {
    expect(countdownParts(AHORA, AHORA)).toBeNull();
    expect(countdownParts(new Date(AHORA.getTime() - 60_000), AHORA)).toBeNull();
  });
});

describe("countdownTarget", () => {
  const VENTANA = {
    from: "2026-09-15T00:00:00.000Z",
    to: "2026-10-15T00:00:00.000Z",
  };

  it("antes de empezar apunta al inicio y lo dice", () => {
    const ahora = new Date("2026-09-20T20:00:00.000Z");
    const futura = { from: "2026-10-01T00:00:00.000Z", to: "2026-11-01T00:00:00.000Z" };

    expect(countdownTarget(futura, ahora)).toEqual({
      target: new Date("2026-10-01T00:00:00.000Z"),
      phase: "before",
    });
  });

  it("en curso apunta al final", () => {
    expect(countdownTarget(VENTANA, AHORA)).toEqual({
      target: new Date("2026-10-15T00:00:00.000Z"),
      phase: "running",
    });
  });

  it("una ventana abierta antes de empezar sigue apuntando al inicio", () => {
    // Sin `to` no hay final al que contar, pero el inicio sí es un objetivo.
    expect(
      countdownTarget({ from: "2026-10-01T00:00:00.000Z", to: null }, AHORA),
    ).toEqual({ target: new Date("2026-10-01T00:00:00.000Z"), phase: "before" });
  });

  it("una ventana abierta ya arrancada no tiene nada que contar", () => {
    // Empezó y no tiene final: el contador no tiene a qué apuntar.
    expect(countdownTarget({ from: "2026-09-15T00:00:00.000Z", to: null }, AHORA)).toBeNull();
  });

  it("torneo terminado no tiene nada que contar", () => {
    expect(countdownTarget(VENTANA, new Date("2026-10-20T00:00:00.000Z"))).toBeNull();
  });

  it("el instante exacto del final ya no cuenta", () => {
    expect(countdownTarget(VENTANA, new Date("2026-10-15T00:00:00.000Z"))).toBeNull();
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
