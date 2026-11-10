import { describe, expect, it } from "vitest";

import type {
  OverlayClasificacion,
  OverlayEventoObjetivo,
  OverlayEventoObjetivoListado,
  OverlayObjetivo,
  OverlayParticipante,
} from "@/lib/overlay-api";
import {
  DEFAULT_OVERLAY_CONFIG,
  overlayConfigQuery,
  overlayConfiguratorParticipants,
  overlayEventBadge,
  overlayEventKey,
  overlayEventProgress,
  overlayEventView,
  overlayEventViews,
  overlayMaxEventTime,
  overlayMergeEvents,
  overlayMetricUnit,
  overlayNewEventViews,
  overlayPollSince,
  overlayPreviewUrl,
  overlayRankingRows,
  overlayRecentCombined,
  overlayRecentEventViews,
  overlayRecentFromFeed,
  overlayReconnectDelay,
  overlayTotalPoints,
  readOverlayConfig,
} from "@/lib/overlay-view";

/**
 * La vista del overlay, en lo que se puede comprobar sin DOM ni red: la
 * resolución del ranking, el orden y la deduplicación de eventos, el recorte de
 * los últimos, el cálculo de `desde` y los textos de progreso.
 */

function objetivo(overrides: Partial<OverlayObjetivo> & Pick<OverlayObjetivo, "id">): OverlayObjetivo {
  return {
    nombre: overrides.id,
    descripcion: "",
    icono_url: "",
    puntos: 0,
    volatil: false,
    repetible: false,
    max_progreso: null,
    metrica: "victorias",
    ...overrides,
  };
}

const OBJETIVOS = new Map<string, OverlayObjetivo>([
  [
    "victorias",
    objetivo({ id: "victorias", nombre: "Victorias", puntos: 2, repetible: true, metrica: "victorias" }),
  ],
  [
    "imparable",
    objetivo({
      id: "imparable",
      nombre: "Imparable",
      puntos: 14,
      max_progreso: 14,
      repetible: true,
      metrica: "dias",
    }),
  ],
  [
    "lider-japanese",
    objetivo({
      id: "lider-japanese",
      nombre: "Líder Japoneses",
      descripcion: "Gana al menos 3 partidas con Japoneses.",
      icono_url: "https://liga.example/imagenes/civilizaciones/Japanese_AoE4.webp",
      puntos: 12,
      max_progreso: 3,
      metrica: "victorias",
    }),
  ],
  [
    "loco-por-ganar",
    objetivo({ id: "loco-por-ganar", nombre: "Loco por ganar", puntos: 25, volatil: true, metrica: "partidas" }),
  ],
]);

function evento(
  tipo: OverlayEventoObjetivo["tipo"],
  fechahora: string,
  extra: Partial<OverlayEventoObjetivo> = {},
): OverlayEventoObjetivo {
  return { tipo, fechahora, progreso: { propio: 1 }, ...extra };
}

function listado(
  objetivo_id: string,
  tipo: OverlayEventoObjetivo["tipo"],
  fechahora: string,
  extra: Partial<OverlayEventoObjetivo> = {},
): OverlayEventoObjetivoListado {
  return { objetivo_id, ...evento(tipo, fechahora, extra) };
}

function fila(id: string, posicion: number, volatiles: number, permanentes: number): OverlayClasificacion {
  return {
    id,
    posicion,
    partidas: 0,
    puntos: { volatiles, permanentes },
    rango: null,
    victorias: 0,
    derrotas: 0,
    racha: null,
    eventos_objetivos: {},
  };
}

const PARTICIPANTES = new Map<string, OverlayParticipante>([
  [
    "1",
    {
      id: "1",
      alias: "Miguel",
      pais: "España",
      avatar_url: "https://cdn.example/miguel.png",
    },
  ],
  ["2", { id: "2", alias: "Mecroid", pais: null, avatar_url: null }],
]);

describe("overlayTotalPoints", () => {
  it("suma volátiles y permanentes", () => {
    expect(overlayTotalPoints({ puntos: { volatiles: 480, permanentes: 94 } })).toBe(574);
  });

  it("admite una fila sin puntos", () => {
    expect(overlayTotalPoints({ puntos: { volatiles: 0, permanentes: 0 } })).toBe(0);
  });
});

describe("overlayRankingRows", () => {
  const filas = [fila("2", 1, 100, 20), fila("1", 2, 50, 25)];

  it("conserva el orden y resuelve alias, país y avatar", () => {
    expect(overlayRankingRows(filas, PARTICIPANTES, "1")).toEqual([
      {
        id: "2",
        posicion: 1,
        alias: "Mecroid",
        pais: null,
        avatarUrl: null,
        puntos: 120,
        isRequested: false,
      },
      {
        id: "1",
        posicion: 2,
        alias: "Miguel",
        pais: "España",
        avatarUrl: "https://cdn.example/miguel.png",
        puntos: 75,
        isRequested: true,
      },
    ]);
  });

  it("sin participante en el mapa, cae al id y a nulos", () => {
    expect(overlayRankingRows([fila("9", 3, 10, 0)], PARTICIPANTES, "9")[0]).toMatchObject({
      id: "9",
      alias: "9",
      pais: null,
      avatarUrl: null,
      isRequested: true,
    });
  });
});

describe("overlayEventKey", () => {
  it("compone objetivo y fecha", () => {
    expect(overlayEventKey("victorias", { fechahora: "2026-10-24T14:30:00.000Z" })).toBe(
      "victorias@2026-10-24T14:30:00.000Z",
    );
  });
});

describe("overlayEventView", () => {
  it("resuelve todo desde el objetivo", () => {
    const view = overlayEventView(
      "lider-japanese",
      evento("cumplido", "2026-10-24T10:00:00.000Z", { progreso: { propio: 3 } }),
      OBJETIVOS.get("lider-japanese"),
    );

    expect(view).toEqual({
      key: "lider-japanese@2026-10-24T10:00:00.000Z",
      objetivoId: "lider-japanese",
      nombre: "Líder Japoneses",
      descripcion: "Gana al menos 3 partidas con Japoneses.",
      iconoUrl: "https://liga.example/imagenes/civilizaciones/Japanese_AoE4.webp",
      metrica: "victorias",
      tipo: "cumplido",
      fechahora: "2026-10-24T10:00:00.000Z",
      progresoPropio: 3,
      progresoAjeno: null,
      repeticion: null,
      maxProgreso: 3,
      volatil: false,
      repetible: false,
      puntos: 12,
    });
  });

  it("sin objetivo, usa el id y valores neutros", () => {
    const view = overlayEventView(
      "desconocido",
      evento("progresado", "2026-10-24T10:00:00.000Z", { progreso: { propio: 2 } }),
      undefined,
    );

    expect(view).toMatchObject({
      objetivoId: "desconocido",
      nombre: "desconocido",
      descripcion: "",
      iconoUrl: "",
      metrica: "",
      puntos: 0,
      maxProgreso: null,
      volatil: false,
      repetible: false,
    });
  });

  it("expone ajeno y repetición cuando existen", () => {
    const view = overlayEventView(
      "loco-por-ganar",
      evento("perdido", "2026-10-24T10:00:00.000Z", {
        progreso: { propio: 0, ajeno: 29 },
      }),
      OBJETIVOS.get("loco-por-ganar"),
    );

    expect(view.progresoPropio).toBe(0);
    expect(view.progresoAjeno).toBe(29);
    expect(view.repeticion).toBeNull();
  });
});

describe("overlayEventViews", () => {
  it("ordena ascendente por instante y desempata por objetivo", () => {
    const views = overlayEventViews(
      {
        victorias: evento("progresado", "2026-10-24T10:00:00.000Z"),
        imparable: evento("cumplido", "2026-10-22T10:00:00.000Z"),
        "loco-por-ganar": evento("perdido", "2026-10-24T10:00:00.000Z"),
      },
      OBJETIVOS,
    );

    expect(views.map((view) => view.key)).toEqual([
      "imparable@2026-10-22T10:00:00.000Z",
      "loco-por-ganar@2026-10-24T10:00:00.000Z",
      "victorias@2026-10-24T10:00:00.000Z",
    ]);
  });

  it("sin eventos, lista vacía", () => {
    expect(overlayEventViews({}, OBJETIVOS)).toEqual([]);
  });
});

describe("overlayRecentEventViews", () => {
  it("solo positivos, sin repetir objetivo y de más reciente a más antiguo", () => {
    const views = overlayRecentEventViews(
      {
        victorias: evento("progresado", "2026-10-20T10:00:00.000Z"),
        imparable: evento("cumplido", "2026-10-24T10:00:00.000Z"),
        "loco-por-ganar": evento("perdido", "2026-10-25T10:00:00.000Z"),
      },
      OBJETIVOS,
    );

    expect(views.map((view) => view.objetivoId)).toEqual(["imparable", "victorias"]);
  });

  it("se queda con el evento más reciente de cada objetivo", () => {
    const views = overlayRecentEventViews(
      {
        victorias: evento("progresado", "2026-10-24T10:00:00.000Z", {
          progreso: { propio: 5 },
        }),
      },
      OBJETIVOS,
      3,
    );

    expect(views[0]?.progresoPropio).toBe(5);
  });

  it("recorta al límite y admite límite cero", () => {
    const events = {
      victorias: evento("progresado", "2026-10-20T10:00:00.000Z"),
      imparable: evento("cumplido", "2026-10-24T10:00:00.000Z"),
      "lider-japanese": evento("cumplido", "2026-10-23T10:00:00.000Z"),
    };

    expect(overlayRecentEventViews(events, OBJETIVOS, 2)).toHaveLength(2);
    expect(overlayRecentEventViews(events, OBJETIVOS, 0)).toEqual([]);
  });
});

describe("overlayRecentFromFeed", () => {
  it("deduplica por objetivo y ordena descendente", () => {
    const feed = [
      listado("victorias", "progresado", "2026-10-24T10:00:00.000Z"),
      listado("imparable", "cumplido", "2026-10-22T10:00:00.000Z"),
      listado("victorias", "progresado", "2026-10-23T10:00:00.000Z"),
      listado("loco-por-ganar", "perdido", "2026-10-25T10:00:00.000Z"),
    ];

    const views = overlayRecentFromFeed(feed, OBJETIVOS, 3);

    expect(views.map((view) => view.objetivoId)).toEqual(["victorias", "imparable"]);
    expect(views[0]?.fechahora).toBe("2026-10-24T10:00:00.000Z");
  });
});

describe("overlayRecentCombined", () => {
  it("un perdido posterior no borra el hito positivo del feed", () => {
    const feed = [listado("loco-por-ganar", "cumplido", "2026-10-20T10:00:00.000Z")];
    const events = {
      "loco-por-ganar": evento("perdido", "2026-10-25T10:00:00.000Z", {
        progreso: { propio: 0, ajeno: 29 },
      }),
    };

    const views = overlayRecentCombined(feed, events, OBJETIVOS, 3);

    expect(views.map((view) => view.key)).toEqual(["loco-por-ganar@2026-10-20T10:00:00.000Z"]);
  });

  it("combina ambos y se queda con el positivo más reciente por objetivo", () => {
    const feed = [listado("victorias", "progresado", "2026-10-20T10:00:00.000Z")];
    const events = {
      victorias: evento("progresado", "2026-10-24T10:00:00.000Z"),
      imparable: evento("cumplido", "2026-10-23T10:00:00.000Z"),
    };

    const views = overlayRecentCombined(feed, events, OBJETIVOS, 2);

    expect(views.map((view) => view.key)).toEqual([
      "victorias@2026-10-24T10:00:00.000Z",
      "imparable@2026-10-23T10:00:00.000Z",
    ]);
  });
});

describe("overlayMergeEvents", () => {
  it("incoming pisa por objetivo", () => {
    const merged = overlayMergeEvents(
      { victorias: evento("progresado", "2026-10-20T10:00:00.000Z") },
      { victorias: evento("progresado", "2026-10-24T10:00:00.000Z") },
    );

    expect(merged.victorias?.fechahora).toBe("2026-10-24T10:00:00.000Z");
  });
});

describe("overlayNewEventViews", () => {
  it("solo claves nuevas y positivas, en orden ascendente", () => {
    const seen = new Set(["victorias@2026-10-20T10:00:00.000Z"]);
    const incoming = {
      victorias: evento("progresado", "2026-10-20T10:00:00.000Z"),
      imparable: evento("cumplido", "2026-10-24T10:00:00.000Z"),
      "loco-por-ganar": evento("perdido", "2026-10-25T10:00:00.000Z"),
      "lider-japanese": evento("cumplido", "2026-10-22T10:00:00.000Z"),
    };

    expect(overlayNewEventViews(seen, incoming, OBJETIVOS).map((view) => view.key)).toEqual([
      "lider-japanese@2026-10-22T10:00:00.000Z",
      "imparable@2026-10-24T10:00:00.000Z",
    ]);
  });

  it("recorta al límite", () => {
    const incoming = {
      victorias: evento("progresado", "2026-10-20T10:00:00.000Z"),
      imparable: evento("cumplido", "2026-10-24T10:00:00.000Z"),
      "lider-japanese": evento("cumplido", "2026-10-22T10:00:00.000Z"),
    };

    expect(overlayNewEventViews(new Set(), incoming, OBJETIVOS, 2)).toHaveLength(2);
  });
});

describe("overlayMaxEventTime", () => {
  it("devuelve el máximo ISO o null", () => {
    expect(
      overlayMaxEventTime({
        victorias: evento("progresado", "2026-10-20T10:00:00.000Z"),
        imparable: evento("cumplido", "2026-10-24T10:00:00.000Z"),
      }),
    ).toBe("2026-10-24T10:00:00.000Z");
    expect(overlayMaxEventTime({})).toBeNull();
  });
});

describe("overlayPollSince", () => {
  it("prefiere el evento más reciente", () => {
    expect(
      overlayPollSince(
        "2026-10-01T00:00:00.000Z",
        { imparable: evento("cumplido", "2026-10-24T10:00:00.000Z") },
        "Mon, 26 Oct 2026 10:00:00 GMT",
      ),
    ).toBe("2026-10-24T10:00:00.000Z");
  });

  it("sin eventos usa la fecha del servidor normalizada a ISO", () => {
    expect(overlayPollSince(null, {}, "Mon, 26 Oct 2026 10:00:00 GMT")).toBe(
      "2026-10-26T10:00:00.000Z",
    );
  });

  it("sin eventos ni fecha de servidor conserva la anterior", () => {
    expect(overlayPollSince("2026-10-01T00:00:00.000Z", {}, null)).toBe(
      "2026-10-01T00:00:00.000Z",
    );
    expect(overlayPollSince("2026-10-01T00:00:00.000Z", {}, "no es una fecha")).toBe(
      "2026-10-01T00:00:00.000Z",
    );
  });
});

describe("overlayReconnectDelay", () => {
  it("duplica con tope de 120 s", () => {
    expect(overlayReconnectDelay(1)).toBe(30_000);
    expect(overlayReconnectDelay(2)).toBe(60_000);
    expect(overlayReconnectDelay(3)).toBe(120_000);
    expect(overlayReconnectDelay(9)).toBe(120_000);
    expect(overlayReconnectDelay(0)).toBe(30_000);
  });
});

describe("overlayConfiguratorParticipants", () => {
  it("mapea las filas de clasificación al selector", () => {
    expect(
      overlayConfiguratorParticipants([
        {
          profileId: 7099800,
          name: "Miguel Narvaez",
          rank: 1,
          points: 942,
          country: "España",
          avatarUrl: "https://cdn.example/miguel.png",
        },
      ]),
    ).toEqual([
      {
        id: "7099800",
        alias: "Miguel Narvaez",
        rank: 1,
        points: 942,
        pais: "España",
        avatarUrl: "https://cdn.example/miguel.png",
      },
    ]);
  });

  it("admite país y avatar ausentes", () => {
    expect(
      overlayConfiguratorParticipants([
        { profileId: 42, name: "Mecroid", rank: 2, points: 100, country: null, avatarUrl: null },
      ])[0],
    ).toMatchObject({ pais: null, avatarUrl: null });
  });
});

describe("overlayPreviewUrl", () => {
  it("compone una URL absoluta y normaliza la barra final", () => {
    expect(overlayPreviewUrl("https://liga.example", "7099800")).toBe(
      "https://liga.example/overlay/7099800",
    );
    expect(overlayPreviewUrl("https://liga.example/", "7099800")).toBe(
      "https://liga.example/overlay/7099800",
    );
  });

  it("sin origen, devuelve la ruta relativa", () => {
    expect(overlayPreviewUrl(null, "42")).toBe("/overlay/42");
  });
});

describe("configuración del overlay por URL", () => {
  it("sin parámetros, devuelve los valores por defecto", () => {
    expect(readOverlayConfig({})).toEqual(DEFAULT_OVERLAY_CONFIG);
    expect(DEFAULT_OVERLAY_CONFIG).toEqual({
      posicion: "tr",
      tamano: "normal",
      secciones: "ambas",
      animaciones: true,
    });
  });

  it("lee cada valor válido y normaliza mayúsculas y espacios", () => {
    expect(
      readOverlayConfig({
        posicion: "BL",
        tamano: " Grande ",
        secciones: "Objetivos",
        animaciones: "false",
      }),
    ).toEqual({
      posicion: "bl",
      tamano: "grande",
      secciones: "objetivos",
      animaciones: false,
    });

    expect(readOverlayConfig({ posicion: "tl", tamano: "compacto", secciones: "ranking" })).toEqual({
      posicion: "tl",
      tamano: "compacto",
      secciones: "ranking",
      animaciones: true,
    });
  });

  it("con listas de valores, usa el primero", () => {
    expect(
      readOverlayConfig({
        posicion: ["br", "tl"],
        tamano: ["grande", "compacto"],
        secciones: ["ranking", "ambas"],
        animaciones: ["0", "1"],
      }),
    ).toEqual({ posicion: "br", tamano: "grande", secciones: "ranking", animaciones: false });
  });

  it("un valor desconocido o vacío cae al defecto sin lanzar", () => {
    expect(
      readOverlayConfig({
        posicion: "arriba",
        tamano: "",
        secciones: "todo",
        animaciones: "quizá",
      }),
    ).toEqual(DEFAULT_OVERLAY_CONFIG);

    expect(readOverlayConfig({ posicion: [], tamano: undefined })).toEqual(DEFAULT_OVERLAY_CONFIG);
  });

  it("animaciones admite 0/false y 1/true", () => {
    expect(readOverlayConfig({ animaciones: "0" }).animaciones).toBe(false);
    expect(readOverlayConfig({ animaciones: "false" }).animaciones).toBe(false);
    expect(readOverlayConfig({ animaciones: "1" }).animaciones).toBe(true);
    expect(readOverlayConfig({ animaciones: "true" }).animaciones).toBe(true);
  });

  it("los valores por defecto no generan query", () => {
    expect(overlayConfigQuery(DEFAULT_OVERLAY_CONFIG)).toBe("");
  });

  it("serializa cada opción no defecto", () => {
    expect(overlayConfigQuery({ ...DEFAULT_OVERLAY_CONFIG, posicion: "bl" })).toBe("posicion=bl");
    expect(overlayConfigQuery({ ...DEFAULT_OVERLAY_CONFIG, tamano: "grande" })).toBe("tamano=grande");
    expect(overlayConfigQuery({ ...DEFAULT_OVERLAY_CONFIG, secciones: "ranking" })).toBe(
      "secciones=ranking",
    );
    expect(overlayConfigQuery({ ...DEFAULT_OVERLAY_CONFIG, animaciones: false })).toBe(
      "animaciones=0",
    );
  });

  it("serializa la combinación completa en el orden contratado", () => {
    expect(
      overlayConfigQuery({
        posicion: "tl",
        tamano: "compacto",
        secciones: "objetivos",
        animaciones: false,
      }),
    ).toBe("posicion=tl&tamano=compacto&secciones=objetivos&animaciones=0");
  });

  it("solo añade la query cuando difiere del defecto", () => {
    expect(overlayPreviewUrl("https://liga.example/", "7099800")).toBe(
      "https://liga.example/overlay/7099800",
    );
    expect(overlayPreviewUrl(null, "42", DEFAULT_OVERLAY_CONFIG)).toBe("/overlay/42");
    expect(overlayPreviewUrl("https://liga.example", "7099800", {
      ...DEFAULT_OVERLAY_CONFIG,
      posicion: "bl",
    })).toBe("https://liga.example/overlay/7099800?posicion=bl");
    expect(overlayPreviewUrl(null, "42", {
      ...DEFAULT_OVERLAY_CONFIG,
      tamano: "grande",
      animaciones: false,
    })).toBe("/overlay/42?tamano=grande&animaciones=0");
  });
});

describe("overlayMetricUnit", () => {
  it("singular y plural", () => {
    expect(overlayMetricUnit("victorias", 1)).toBe("victoria");
    expect(overlayMetricUnit("victorias", 6)).toBe("victorias");
    expect(overlayMetricUnit("dias", 14)).toBe("días");
    expect(overlayMetricUnit("racha", 2)).toBe("victorias seguidas");
  });

  it("métrica desconocida cae a progreso", () => {
    expect(overlayMetricUnit("inventada", 1)).toBe("progreso");
    expect(overlayMetricUnit("inventada", 3)).toBe("progresos");
  });
});

describe("overlayEventBadge", () => {
  const view = overlayEventView("imparable", evento("cumplido", "2026-10-24T10:00:00.000Z"), undefined);

  it("nombra cada tipo", () => {
    expect(overlayEventBadge(view)).toBe("Cumplido");
    expect(overlayEventBadge({ ...view, tipo: "progresado" })).toBe("Progreso");
    expect(overlayEventBadge({ ...view, tipo: "perdido" })).toBe("Perdido");
  });
});

describe("overlayEventProgress", () => {
  it("cumplido con tope: propio/max y unidad según el tope", () => {
    const view = overlayEventView(
      "imparable",
      evento("cumplido", "2026-10-24T10:00:00.000Z", { progreso: { propio: 14 } }),
      OBJETIVOS.get("imparable"),
    );

    expect(overlayEventProgress(view)).toBe("14/14 días");
  });

  it("cumplido sin tope: Cumplido", () => {
    const view = overlayEventView(
      "loco-por-ganar",
      evento("cumplido", "2026-10-24T10:00:00.000Z", { progreso: { propio: 29 } }),
      OBJETIVOS.get("loco-por-ganar"),
    );

    expect(overlayEventProgress(view)).toBe("Cumplido");
  });

  it("progresado con tope recorta y pinta la fracción", () => {
    const view = overlayEventView(
      "imparable",
      evento("progresado", "2026-10-24T10:00:00.000Z", { progreso: { propio: 20 } }),
      OBJETIVOS.get("imparable"),
    );

    expect(overlayEventProgress(view)).toBe("14/14 días");
  });

  it("progresado sin tope y repetible: xN", () => {
    const view = overlayEventView(
      "victorias",
      evento("progresado", "2026-10-24T10:00:00.000Z", { progreso: { propio: 6 }, repeticion: 6 }),
      OBJETIVOS.get("victorias"),
    );

    expect(overlayEventProgress(view)).toBe("x6");
  });

  it("progresado sin tope ni repetición: propio unidad", () => {
    const view = overlayEventView(
      "victorias",
      evento("progresado", "2026-10-24T10:00:00.000Z", { progreso: { propio: 1 } }),
      OBJETIVOS.get("victorias"),
    );

    expect(overlayEventProgress(view)).toBe("1 victoria");
  });

  it("perdido con nuevo poseedor y sin él", () => {
    const conAjeno = overlayEventView(
      "loco-por-ganar",
      evento("perdido", "2026-10-24T10:00:00.000Z", { progreso: { propio: 0, ajeno: 29 } }),
      OBJETIVOS.get("loco-por-ganar"),
    );
    const sinAjeno = overlayEventView(
      "loco-por-ganar",
      evento("perdido", "2026-10-24T10:00:00.000Z", { progreso: { propio: 0 } }),
      OBJETIVOS.get("loco-por-ganar"),
    );

    expect(overlayEventProgress(conAjeno)).toBe("Ahora 29 partidas");
    expect(overlayEventProgress(sinAjeno)).toBe("Perdido");
  });
});
