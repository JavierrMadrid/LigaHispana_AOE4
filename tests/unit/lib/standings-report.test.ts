import { describe, expect, it } from "vitest";

import {
  buildStandingsReportMessages,
  dailyReportPlan,
  DISCORD_MESSAGE_LIMIT,
  EMPTY_STANDINGS_REPORT_MEMORY,
  madridReportClock,
  parseStandingsReportMemory,
  reportMayRunToday,
  standingsReportDateLabel,
  STANDINGS_REPORT_HOUR,
  STANDINGS_REPORT_KEY,
  type StandingsReportRow,
} from "@/lib/standings-report";

/**
 * El informe diario de clasificación: cuándo toca, cómo se parte y cómo se reanuda.
 *
 * Todo es puro y sin red ni base de datos: el reloj va en la mano (instantes escritos a
 * mano) y las filas son una lista de números y nombres. Lo que se fija es lo que no puede
 * fallar: que no salga dos veces el mismo día, que un día que se pasó no se mande
 * atrasado, que ningún mensaje pase de 2000 caracteres sin partir una línea, y que una
 * reanudación no repita lo ya enviado.
 */

const ROWS: StandingsReportRow[] = [
  { rank: 1, name: "BeastWizard", points: 42 },
  { rank: 2, name: "Pepito", points: 30 },
  { rank: 2, name: "Zorro", points: 30 },
];

describe("madridReportClock", () => {
  it("lee el día y la hora de Madrid, no los del proceso", () => {
    // 19:00 UTC en verano son las 21:00 de Madrid.
    expect(madridReportClock(new Date("2026-10-14T19:00:00.000Z"))).toEqual({
      day: "2026-10-14",
      hour: 21,
    });
  });

  it("en invierno el desplazamiento es otro", () => {
    // 20:00 UTC en invierno son las 21:00 de Madrid (UTC+1).
    expect(madridReportClock(new Date("2026-01-14T20:00:00.000Z"))).toEqual({
      day: "2026-01-14",
      hour: 21,
    });
  });

  it("justo antes de las 21:00 la hora es 20", () => {
    expect(madridReportClock(new Date("2026-10-14T18:59:00.000Z")).hour).toBe(20);
  });

  it("el cambio de hora de octubre no desplaza ni el día ni la hora", () => {
    // El domingo 25 de octubre de 2026 Madrid pasa a UTC+1. A las 19:00 UTC ya son las
    // 20:00 de Madrid, no las 21:00.
    expect(madridReportClock(new Date("2026-10-25T19:00:00.000Z"))).toEqual({
      day: "2026-10-25",
      hour: 20,
    });
    expect(madridReportClock(new Date("2026-10-24T19:00:00.000Z"))).toEqual({
      day: "2026-10-24",
      hour: 21,
    });
  });
});

describe("dailyReportPlan", () => {
  const ANTES = new Date("2026-10-14T18:00:00.000Z"); // 20:00 Madrid
  const DESPUES = new Date("2026-10-14T19:00:00.000Z"); // 21:00 Madrid

  const NADA = EMPTY_STANDINGS_REPORT_MEMORY;

  it("antes de las 21:00 no toca", () => {
    expect(dailyReportPlan({ now: ANTES, memory: NADA, chunkCount: 3 })).toBeNull();
  });

  it("a partir de las 21:00, con el día sin informar, toca desde el primer trozo", () => {
    expect(dailyReportPlan({ now: DESPUES, memory: NADA, chunkCount: 3 })).toEqual({
      kind: "send",
      day: "2026-10-14",
      startChunk: 0,
    });
  });

  it("el mismo día ya informado no vuelve a salir, aunque haya más filas", () => {
    expect(
      dailyReportPlan({
        now: DESPUES,
        memory: { lastDay: "2026-10-14", pendingDay: null, sentChunks: 0 },
        chunkCount: 5,
      }),
    ).toBeNull();
  });

  it("un informe a medias de hoy se retoma por donde iba", () => {
    expect(
      dailyReportPlan({
        now: DESPUES,
        memory: { lastDay: null, pendingDay: "2026-10-14", sentChunks: 2 },
        chunkCount: 5,
      }),
    ).toEqual({ kind: "send", day: "2026-10-14", startChunk: 2 });
  });

  it("un informe a medias de hoy sin trozos que mandar se cierra sin enviar", () => {
    expect(
      dailyReportPlan({
        now: DESPUES,
        memory: { lastDay: null, pendingDay: "2026-10-14", sentChunks: 2 },
        chunkCount: 2,
      }),
    ).toEqual({ kind: "finalize", day: "2026-10-14" });
  });

  it("un informe a medias de hoy con la clasificación vacía se cierra sin enviar", () => {
    // El caso de cero filas: el paso del worker lo resuelve antes de llegar aquí, pero la
    // decisión pura también lo cubre.
    expect(
      dailyReportPlan({
        now: DESPUES,
        memory: { lastDay: null, pendingDay: "2026-10-14", sentChunks: 0 },
        chunkCount: 0,
      }),
    ).toEqual({ kind: "finalize", day: "2026-10-14" });
  });

  it("un informe a medias de otro día se ignora y el de hoy empieza de cero", () => {
    // El reintento de ayer no se manda atrasado: hoy, pasadas las 21:00, empieza el de hoy.
    expect(
      dailyReportPlan({
        now: DESPUES,
        memory: { lastDay: null, pendingDay: "2026-10-13", sentChunks: 1 },
        chunkCount: 4,
      }),
    ).toEqual({ kind: "send", day: "2026-10-14", startChunk: 0 });
  });

  it("sin filas no hay informe, y no es un fallo", () => {
    expect(dailyReportPlan({ now: DESPUES, memory: NADA, chunkCount: 0 })).toBeNull();
  });

  it("un día que ya pasó no se informa atrasado al día siguiente por la mañana", () => {
    // A las 02:30 de Madrid del día 15 no toca el informe del 14: se salta ese día.
    expect(
      dailyReportPlan({
        now: new Date("2026-10-15T00:30:00.000Z"),
        memory: { lastDay: "2026-10-14", pendingDay: null, sentChunks: 0 },
        chunkCount: 3,
      }),
    ).toBeNull();
  });
});

describe("reportMayRunToday", () => {
  const NADA = EMPTY_STANDINGS_REPORT_MEMORY;
  const HOY_MANANA = { day: "2026-10-14", hour: 10 };
  const HOY_NOCHE = { day: "2026-10-14", hour: 21 };

  it("antes de las 21:00 y sin nada de hoy, no puede tocar", () => {
    expect(reportMayRunToday(HOY_MANANA, NADA)).toBe(false);
  });

  it("a partir de las 21:00, con el día sin informar, sí puede tocar", () => {
    expect(reportMayRunToday(HOY_NOCHE, NADA)).toBe(true);
  });

  it("con el día ya completo no toca, sea la hora que sea", () => {
    const memory = { lastDay: "2026-10-14", pendingDay: null, sentChunks: 0 };

    expect(reportMayRunToday(HOY_NOCHE, memory)).toBe(false);
    expect(reportMayRunToday({ day: "2026-10-14", hour: 23 }, memory)).toBe(false);
  });

  it("un informe de hoy a medias puede tocar aunque aún no sean las 21:00", () => {
    // Reanudar no depende de la hora: lo que hay que hacer es terminar el envío.
    const memory = { lastDay: null, pendingDay: "2026-10-14", sentChunks: 1 };

    expect(reportMayRunToday(HOY_MANANA, memory)).toBe(true);
  });

  it("un informe a medias de ayer no hace tocar hoy por la mañana", () => {
    const memory = { lastDay: null, pendingDay: "2026-10-13", sentChunks: 1 };

    expect(reportMayRunToday(HOY_MANANA, memory)).toBe(false);
    expect(reportMayRunToday(HOY_NOCHE, memory)).toBe(true);
  });
});

describe("buildStandingsReportMessages", () => {
  const BASE = {
    editionName: "Liga Hispana AoE IV",
    day: "2026-10-14",
    rows: ROWS,
    url: "https://laligahispana.es/",
  };

  it("lleva cabecera, una línea por fila y el enlace a la portada", () => {
    const messages = buildStandingsReportMessages(BASE);
    const texto = messages.join("\n");

    expect(messages).toHaveLength(1);
    expect(texto).toContain("Liga Hispana AoE IV: clasificación del 14 de octubre de 2026.");
    expect(texto).toContain("1. BeastWizard — 42 pts");
    expect(texto).toContain("2. Pepito — 30 pts");
    expect(texto).toContain("Clasificación completa en la web: https://laligahispana.es/");
  });

  it("sin dominio configurado sale sin enlace, no con un localhost", () => {
    const texto = buildStandingsReportMessages({ ...BASE, url: null }).join("\n");

    expect(texto).not.toContain("http");
    expect(texto).not.toContain("Clasificación completa");
  });

  it("sin filas no hay mensaje", () => {
    expect(buildStandingsReportMessages({ ...BASE, rows: [] })).toEqual([]);
  });

  it("parte en varios mensajes sin cortar ninguna línea por la mitad", () => {
    const rows: StandingsReportRow[] = Array.from({ length: 20 }, (_, index) => ({
      rank: index + 1,
      name: `Jugador con un nombre largo ${index + 1}`,
      points: 20 - index,
    }));

    const limit = 120;
    const messages = buildStandingsReportMessages({ ...BASE, rows, limit });

    // Cabecera + 20 filas + enlace no caben en 120, así que hay varios mensajes.
    expect(messages.length).toBeGreaterThan(1);

    for (const message of messages) {
      expect(message.length).toBeLessThanOrEqual(limit);
    }

    // Ninguna línea se parte: al rejuntar los mensajes quedan exactamente las líneas
    // esperadas, cada una entera.
    const lineas = messages.flatMap((message) => message.split("\n"));
    expect(lineas).toHaveLength(22);
    expect(lineas[0]).toContain("clasificación del");
    expect(lineas[1]).toBe("1. Jugador con un nombre largo 1 — 20 pts");
    expect(lineas[lineas.length - 1]).toContain("Clasificación completa en la web");
  });

  it("es determinista: las mismas filas dan los mismos trozos", () => {
    expect(buildStandingsReportMessages(BASE)).toEqual(buildStandingsReportMessages(BASE));
  });

  it("usa 2000 caracteres como límite por defecto, el de Discord", () => {
    expect(DISCORD_MESSAGE_LIMIT).toBe(2000);
  });
});

describe("standingsReportDateLabel", () => {
  it("la fecha del informe, en español y sin desplazarse", () => {
    expect(standingsReportDateLabel("2026-10-14")).toBe("14 de octubre de 2026");
    expect(standingsReportDateLabel("2026-01-01")).toBe("1 de enero de 2026");
  });
});

describe("parseStandingsReportMemory", () => {
  it("un valor que no se entiende se lee como 'no se ha informado'", () => {
    for (const raro of [null, undefined, 0, "2026-10-14", [], true]) {
      expect(parseStandingsReportMemory(raro)).toEqual(EMPTY_STANDINGS_REPORT_MEMORY);
    }
  });

  it("lee los tres campos y descarta los días con forma inválida", () => {
    expect(
      parseStandingsReportMemory({
        lastDay: "2026-10-14",
        pendingDay: "ayer",
        sentChunks: 2,
      }),
    ).toEqual({ lastDay: "2026-10-14", pendingDay: null, sentChunks: 2 });
  });

  it("un `sentChunks` que no es un entero positivo se lee como 0", () => {
    for (const raro of [-1, 1.5, "2", null, undefined]) {
      expect(
        parseStandingsReportMemory({ pendingDay: "2026-10-14", sentChunks: raro }).sentChunks,
      ).toBe(0);
    }
  });
});

describe("la clave y la hora", () => {
  it("la clave es la que lee y escribe `Setting`", () => {
    expect(STANDINGS_REPORT_KEY).toBe("discord.standingsReport");
  });

  it("el informe es a las 21:00 de Madrid", () => {
    expect(STANDINGS_REPORT_HOUR).toBe(21);
  });
});
