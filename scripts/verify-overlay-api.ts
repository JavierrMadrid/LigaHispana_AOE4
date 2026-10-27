import "./load-env.mjs";

import assert from "node:assert/strict";

import { ObjectiveProgressKind, PlayerStatus } from "@/generated/prisma/enums";
import { db } from "@/lib/db";
import { divisionFromRankLevel, subdivisionNumber } from "@/lib/divisions";
import {
  OBJECTIVE_DEFINITIONS,
  VICTORIAS_ID,
  objectiveKind,
  objectiveRepeatable,
  type ObjectiveDefinition,
} from "@/lib/objectives";
import { objectiveMaxProgress } from "@/lib/objective-progress";
import {
  loadOverlayClassification,
  loadOverlayObjectives,
  loadOverlayParticipants,
  overlayEventosObjetivos,
  type OverlayClasificacion,
  type OverlayEventoObjetivo,
  type OverlayProgressEventSource,
} from "@/lib/overlay-api";
import { resolveStandingsVersion } from "@/lib/public";
import { windowBounds } from "@/lib/ranked-match";
import { RULESET_VERSION, compareStandings, readRuleset, type ScoringRuleset } from "@/lib/scoring";
import { readMapPool } from "@/lib/settings";

/**
 * Verificación de la API del overlay contra la base de `DATABASE_URL`.
 *
 *   npm run verify:overlay-api
 *
 * **Solo lee.** Compara lo que devuelven los lectores de `src/lib/overlay-api.ts`
 * —los mismos que sirven `/api/v0`— con lo que hay en la base, para detectar que
 * el contrato publicado y los datos no se han separado: vecinos que no son los
 * inmediatos, un reparto de puntos que no suma el total, un feed que no coincide
 * con `ObjectiveProgressEvent`, un estado sin su evento o un `PERDIDO` en un logro.
 *
 * No sustituye a los tests: `tests/unit/lib/overlay-api.test.ts` comprueba la
 * parte pura sin base de datos, y esto comprueba lo que solo se puede saber con
 * filas de verdad.
 *
 * El origen de las URLs de icono es inventado a propósito: lo que se verifica es
 * que la URL se compone con el origen de la petición, no que el asset exista en
 * un dominio concreto.
 */

/** Origen con el que se piden los objetivos; la URL del icono debe colgar de aquí. */
const ORIGEN_VERIFICACION = "https://verify.local";
const DIRECTORIO_ICONOS = `${ORIGEN_VERIFICACION}/imagenes/civilizaciones/`;

let passed = 0;
const failures: string[] = [];

/**
 * Ejecuta una comprobación y anota el resultado.
 *
 * Una que falla no aborta las siguientes: interesa la lista entera de
 * desviaciones de una pasada, no la primera.
 */
async function check(name: string, run: () => void | Promise<void>): Promise<void> {
  try {
    await run();
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (error) {
    failures.push(name);
    console.log(`  FALLA ${name}`);
    console.log(`        ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Una fila de `PlayerScore` de la versión publicada, con lo que se compara. */
type FilaPublicada = {
  rank: number;
  total: number;
  wins: number;
  matches: number;
  streak: number | null;
  player: { id: string; profileId: number; elo: number | null; rankLevel: string | null };
};

/** Un evento del feed, con el jugador y la edición que la API filtra. */
type EventoEnBase = OverlayProgressEventSource & { playerId: string; editionFrom: Date };

/** Todo lo que se lee una vez y comparten las comprobaciones. */
type Contexto = {
  ruleset: ScoringRuleset;
  mapPoolSize: number;
  editionFrom: Date;
  activeObjectiveIds: Set<string>;
  /** Definiciones activas, por id. */
  activeDefinitions: Map<string, ObjectiveDefinition>;
  eventos: EventoEnBase[];
  eventosPorJugador: Map<string, EventoEnBase[]>;
};

/* -------------------------------------------------------------------------- */
/* Participantes                                                               */
/* -------------------------------------------------------------------------- */

async function checkParticipantes(): Promise<number> {
  const aprobados = await db.player.count({ where: { status: PlayerStatus.APPROVED } });
  const participantes = await loadOverlayParticipants();

  assert.equal(
    participantes.length,
    aprobados,
    `la API publica ${participantes.length} participantes y hay ${aprobados} aprobados`,
  );

  let anterior = 0;

  for (const participante of participantes) {
    assert.match(
      participante.id,
      /^[1-9]\d{0,9}$/,
      `el id ${participante.id} no es un profileId canónico`,
    );

    const profileId = Number(participante.id);

    assert.ok(profileId > anterior, "la lista no está ordenada por profileId");
    anterior = profileId;

    assert.ok(participante.alias.trim() !== "", `el participante ${participante.id} no tiene alias`);
  }

  if (participantes.length > 0) {
    const primero = participantes[0];
    const uno = await loadOverlayParticipants(Number(primero.id));

    assert.equal(uno.length, 1, `el profileId ${primero.id} debería devolver una fila`);
    assert.deepEqual(uno[0], primero, "el filtro por id no devuelve la misma fila que la lista");
  }

  const maximo = await db.player.aggregate({ _max: { profileId: true } });
  const inventado = (maximo._max.profileId ?? 0) + 1;

  assert.deepEqual(
    await loadOverlayParticipants(inventado),
    [],
    `el profileId inventado ${inventado} no debería devolver filas`,
  );

  return participantes.length;
}

/* -------------------------------------------------------------------------- */
/* Objetivos                                                                   */
/* -------------------------------------------------------------------------- */

async function checkObjetivos(contexto: Contexto): Promise<number> {
  const objetivos = await loadOverlayObjectives(ORIGEN_VERIFICACION);
  const activos = [...contexto.activeDefinitions.values()];

  assert.equal(
    objetivos.length,
    activos.length,
    `la API publica ${objetivos.length} objetivos y hay ${activos.length} activos`,
  );

  const porId = new Map(objetivos.map((objetivo) => [objetivo.id, objetivo]));

  for (const id of contexto.ruleset.disabledObjectives) {
    assert.ok(!porId.has(id), `el objetivo apagado ${id} no debería publicarse`);
  }

  for (const definicion of activos) {
    const objetivo = porId.get(definicion.id);

    assert.ok(objetivo !== undefined, `falta el objetivo activo ${definicion.id}`);
    assert.equal(objetivo.nombre, definicion.label, `el nombre de ${definicion.id} no es el del catálogo`);
    assert.equal(
      objetivo.max_progreso,
      objectiveMaxProgress(definicion, contexto.mapPoolSize),
      `max_progreso de ${definicion.id} no coincide con el del catálogo y el pool`,
    );

    // `victorias` paga por victoria y su `points` del catálogo es documental: la
    // misma excepción que hace el motor.
    const puntos =
      definicion.id === VICTORIAS_ID
        ? contexto.ruleset.pointsPerWin
        : (contexto.ruleset.objectives[definicion.id] ?? definicion.points);

    assert.equal(objetivo.puntos, puntos, `los puntos de ${definicion.id} no coinciden con el ruleset`);
    assert.equal(
      objetivo.volatil,
      definicion.kind === "competition",
      `volatil de ${definicion.id} no coincide con su tipo`,
    );
    assert.equal(
      objetivo.repetible,
      objectiveRepeatable(definicion.id),
      `repetible de ${definicion.id} no coincide con el catálogo`,
    );
    assert.ok(
      objetivo.icono_url === "" || objetivo.icono_url.startsWith(DIRECTORIO_ICONOS),
      `el icono de ${definicion.id} no es una URL absoluta del origen pedido: ${objetivo.icono_url}`,
    );
  }

  return objetivos.length;
}

/* -------------------------------------------------------------------------- */
/* Clasificación                                                               */
/* -------------------------------------------------------------------------- */

/**
 * La versión de reglas publicada, resuelta como la API: la activa o, si aún no
 * tiene filas, la anterior más alta. Sin ese respaldo la comprobación pediría
 * filas de una versión que la API no está sirviendo.
 */
async function publishedRuleSetVersion(): Promise<number> {
  const activas = await db.playerScore.count({ where: { ruleSetVersion: RULESET_VERSION } });
  let anterior: number | null = null;

  if (activas === 0) {
    const maximo = await db.playerScore.aggregate({
      where: { ruleSetVersion: { lt: RULESET_VERSION } },
      _max: { ruleSetVersion: true },
    });

    anterior = maximo._max.ruleSetVersion;
  }

  return resolveStandingsVersion(RULESET_VERSION, activas, anterior).ruleSetVersion;
}

/**
 * Las filas que la API debe devolver para la fila `indice` del orden completo.
 *
 * Es la ventana del contrato: dos del lado disponible en los extremos y uno por
 * cada lado en medio.
 */
function neighborhood(filas: readonly FilaPublicada[], indice: number): FilaPublicada[] {
  const ultimo = filas.length - 1;

  if (indice === 0) {
    return filas.slice(0, 3);
  }

  if (indice === ultimo) {
    return filas.slice(Math.max(0, filas.length - 3));
  }

  return filas.slice(indice - 1, indice + 2);
}

/** La ladder que debería publicar una fila, o `null` si le falta una pieza. */
function expectedRango(fila: FilaPublicada): OverlayClasificacion["rango"] {
  const { elo, rankLevel } = fila.player;

  if (elo === null) {
    return null;
  }

  const liga = divisionFromRankLevel(rankLevel);
  const division = subdivisionNumber(rankLevel);

  if (liga === null || division === null) {
    return null;
  }

  return { puntos: elo, liga, division };
}

/**
 * Comprueba la forma de un evento publicado.
 *
 * Es la parte del contrato que no depende de la base: los valores admitidos por
 * tipo, que `ajeno` solo exista en `perdido`, que `repeticion` solo esté en los
 * repetibles y que un `perdido` sea siempre de una competición.
 */
function assertEventoValido(id: string, evento: OverlayEventoObjetivo, contexto: Contexto): void {
  assert.ok(contexto.activeObjectiveIds.has(id), `el evento del objetivo ${id} no está activo`);
  assert.ok(
    evento.tipo === "cumplido" || evento.tipo === "perdido" || evento.tipo === "progresado",
    `el evento de ${id} tiene un tipo desconocido: ${String(evento.tipo)}`,
  );

  const fecha = new Date(evento.fechahora);

  assert.ok(
    !Number.isNaN(fecha.getTime()) && fecha.toISOString() === evento.fechahora,
    `la fechahora de ${id} no es ISO 8601 con zona: ${evento.fechahora}`,
  );

  assert.ok(Number.isInteger(evento.progreso.propio), `el progreso propio de ${id} no es entero`);

  if (evento.tipo === "perdido") {
    assert.equal(
      objectiveKind(id),
      "competition",
      `el objetivo ${id} no es una competición y no puede perder`,
    );
    assert.ok(
      evento.progreso.propio >= 0,
      `el progreso propio de un perdido de ${id} no puede ser negativo`,
    );
    assert.equal(evento.repeticion, undefined, `el perdido de ${id} no puede llevar repeticion`);

    if (evento.progreso.ajeno !== undefined) {
      assert.ok(
        Number.isInteger(evento.progreso.ajeno) && evento.progreso.ajeno >= 1,
        `el progreso ajeno de ${id} debe ser un entero mayor o igual que 1`,
      );
    }

    return;
  }

  assert.ok(evento.progreso.propio >= 1, `el progreso propio de ${id} debe ser mayor o igual que 1`);
  assert.equal(evento.progreso.ajeno, undefined, `el evento ${evento.tipo} de ${id} no lleva ajeno`);

  if (evento.repeticion !== undefined) {
    assert.ok(
      objectiveRepeatable(id),
      `el objetivo ${id} no es repetible y su evento lleva repeticion`,
    );
    assert.ok(
      Number.isInteger(evento.repeticion) && evento.repeticion >= 1,
      `la repeticion de ${id} debe ser un entero mayor o igual que 1`,
    );
  }
}

async function checkClasificacion(contexto: Contexto): Promise<number> {
  const version = await publishedRuleSetVersion();
  const filas = await db.playerScore.findMany({
    where: { ruleSetVersion: version, player: { status: PlayerStatus.APPROVED } },
    select: {
      rank: true,
      total: true,
      wins: true,
      matches: true,
      streak: true,
      player: { select: { id: true, profileId: true, elo: true, rankLevel: true } },
    },
  });

  const orden = [...filas].sort((a, b) =>
    compareStandings(
      { total: a.total, wins: a.wins, matches: a.matches, profileId: a.player.profileId },
      { total: b.total, wins: b.wins, matches: b.matches, profileId: b.player.profileId },
    ),
  );
  const porRank = [...filas].sort(
    (a, b) => a.rank - b.rank || a.player.profileId - b.player.profileId,
  );

  assert.deepEqual(
    orden.map((fila) => fila.player.profileId),
    porRank.map((fila) => fila.player.profileId),
    "el orden por criterios y el orden por rank/profileId no coinciden",
  );

  for (let indice = 0; indice < orden.length; indice += 1) {
    const fila = orden[indice];
    const esperados = neighborhood(orden, indice).map((vecino) =>
      String(vecino.player.profileId),
    );
    const respuesta = await loadOverlayClassification(fila.player.profileId, null);

    assert.ok(
      respuesta !== null,
      `la clasificación de ${fila.player.profileId} devuelve null y tiene fila publicada`,
    );
    assert.deepEqual(
      respuesta.map((publicada) => publicada.id),
      esperados,
      `los vecinos de ${fila.player.profileId} no son los inmediatos del orden publicado`,
    );

    const solicitado = respuesta.find((publicada) => publicada.id === String(fila.player.profileId));

    assert.ok(solicitado !== undefined, `la respuesta de ${fila.player.profileId} no incluye al solicitado`);
    assert.equal(solicitado.posicion, fila.rank, `la posición de ${fila.player.profileId} no es su rank`);
    assert.equal(solicitado.partidas, fila.matches, `las partidas de ${fila.player.profileId} no cuadran`);
    assert.equal(solicitado.victorias, fila.wins, `las victorias de ${fila.player.profileId} no cuadran`);
    assert.equal(
      solicitado.derrotas,
      fila.matches - fila.wins,
      `las derrotas de ${fila.player.profileId} no son partidas menos victorias`,
    );
    assert.equal(solicitado.racha, fila.streak, `la racha de ${fila.player.profileId} no es la del torneo`);
    assert.equal(
      solicitado.puntos.volatiles + solicitado.puntos.permanentes,
      fila.total,
      `el reparto de puntos de ${fila.player.profileId} no suma su total`,
    );
    assert.deepEqual(
      solicitado.rango,
      expectedRango(fila),
      `el rango de ${fila.player.profileId} no coincide con su ELO y su división`,
    );

    for (const publicada of respuesta) {
      if (publicada.id === solicitado.id) {
        continue;
      }

      assert.deepEqual(
        publicada.eventos_objetivos,
        {},
        `el vecino ${publicada.id} de ${fila.player.profileId} lleva eventos y debería llevar un mapa vacío`,
      );
    }

    const eventos = contexto.eventosPorJugador.get(fila.player.id) ?? [];
    const esperado = overlayEventosObjetivos(eventos, contexto.activeObjectiveIds);

    assert.deepEqual(
      solicitado.eventos_objetivos,
      esperado,
      `el feed de ${fila.player.profileId} no coincide con el último evento de la edición`,
    );

    for (const [id, evento] of Object.entries(solicitado.eventos_objetivos)) {
      assertEventoValido(id, evento, contexto);
    }
  }

  await checkDesde(contexto, orden);

  return orden.length;
}

/**
 * Comprueba el recorte de `desde` con los dos primeros jugadores que tengan feed.
 *
 * El instante elegido es el del último evento del jugador, así que la respuesta
 * tiene que ser exactamente el mapa de los eventos de ese instante en adelante:
 * el corte es inclusivo y, si dos eventos comparten `at`, entran los dos.
 */
async function checkDesde(contexto: Contexto, orden: readonly FilaPublicada[]): Promise<void> {
  const conEventos = orden
    .map((fila) => ({ fila, eventos: contexto.eventosPorJugador.get(fila.player.id) ?? [] }))
    .filter(({ eventos }) => eventos.length > 0)
    .slice(0, 2);

  for (const { fila, eventos } of conEventos) {
    const desde = eventos.reduce(
      (maximo, evento) => (evento.at.getTime() > maximo.getTime() ? evento.at : maximo),
      eventos[0].at,
    );
    const respuesta = await loadOverlayClassification(fila.player.profileId, desde);

    assert.ok(respuesta !== null, `la clasificación de ${fila.player.profileId} con desde devuelve null`);

    const solicitado = respuesta.find((publicada) => publicada.id === String(fila.player.profileId));

    assert.ok(solicitado !== undefined, `la respuesta con desde de ${fila.player.profileId} no lo incluye`);

    const esperado = overlayEventosObjetivos(
      eventos.filter((evento) => evento.at.getTime() >= desde.getTime()),
      contexto.activeObjectiveIds,
    );

    assert.deepEqual(
      solicitado.eventos_objetivos,
      esperado,
      `el recorte de desde de ${fila.player.profileId} no es el de los eventos con at >= desde`,
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Estado y eventos de progreso                                                */
/* -------------------------------------------------------------------------- */

/**
 * Comprueba las dos tablas del progreso, que son las que alimentan el feed.
 *
 * El estado es la memoria del motor y el evento es lo publicado: cada estado tiene
 * que tener su feed y el último evento no puede quedarse por detrás de él. La
 * igualdad exacta no siempre se da, porque una bajada de progreso reescribe el
 * estado sin dejar evento; el techo sí es una invariante.
 */
async function checkProgreso(contexto: Contexto): Promise<{ eventos: number; estados: number }> {
  const estados = await db.objectiveProgressState.findMany({
    where: { editionFrom: contexto.editionFrom },
    select: { playerId: true, objectiveId: true, value: true, repetition: true },
  });

  const ultimoPorClave = new Map<string, EventoEnBase>();

  for (const evento of contexto.eventos) {
    const clave = `${evento.playerId}\u0000${evento.objectiveId}`;
    const anterior = ultimoPorClave.get(clave);

    if (anterior === undefined || evento.at.getTime() >= anterior.at.getTime()) {
      ultimoPorClave.set(clave, evento);
    }
  }

  for (const estado of estados) {
    const clave = `${estado.playerId}\u0000${estado.objectiveId}`;
    const ultimo = ultimoPorClave.get(clave);

    assert.ok(
      ultimo !== undefined,
      `el estado de ${estado.playerId} en ${estado.objectiveId} no tiene ningún evento`,
    );

    // El feed solo publica subidas: una bajada —una partida revertida, un objetivo
    // que deja de contar— reescribe el estado sin dejar evento (`diffObjectiveProgress`
    // no anota pérdidas de progreso). Por eso el último evento es el **techo** del
    // estado y no siempre su valor exacto; lo que no puede pasar es que el estado vaya
    // por delante de su feed, que sería un evento perdido.
    assert.ok(
      ultimo.ownValue >= estado.value,
      `el último evento de ${estado.playerId} en ${estado.objectiveId} se queda por detrás del estado (${ultimo.ownValue} < ${estado.value})`,
    );
    assert.ok(
      (ultimo.repetition ?? 0) >= (estado.repetition ?? 0),
      `el último evento de ${estado.playerId} en ${estado.objectiveId} se queda por detrás de la repetición del estado`,
    );

    const definicion = contexto.activeDefinitions.get(estado.objectiveId);

    assert.ok(
      definicion !== undefined,
      `el estado de ${estado.playerId} apunta a un objetivo que no está en el catálogo activo: ${estado.objectiveId}`,
    );

    const maximo = objectiveMaxProgress(definicion, contexto.mapPoolSize);

    if (maximo !== null) {
      assert.ok(
        estado.value <= maximo,
        `el estado de ${estado.playerId} en ${estado.objectiveId} supera su tope (${estado.value} > ${maximo})`,
      );
    }
  }

  for (const evento of contexto.eventos) {
    assert.equal(
      evento.editionFrom.getTime(),
      contexto.editionFrom.getTime(),
      `el evento de ${evento.playerId} en ${evento.objectiveId} no es de la edición activa`,
    );
    assert.ok(
      evento.ownValue >= 0,
      `el evento de ${evento.playerId} en ${evento.objectiveId} tiene un progreso negativo`,
    );

    if (evento.kind === ObjectiveProgressKind.PERDIDO) {
      assert.equal(
        objectiveKind(evento.objectiveId),
        "competition",
        `el evento PERDIDO de ${evento.objectiveId} no es de una competición`,
      );
      assert.equal(
        evento.repetition,
        null,
        `el evento PERDIDO de ${evento.objectiveId} lleva repetición`,
      );
    }

    if (evento.repetition !== null) {
      assert.ok(
        objectiveRepeatable(evento.objectiveId),
        `el evento de ${evento.objectiveId} lleva repetición y el objetivo no es repetible`,
      );
    }
  }

  return { eventos: contexto.eventos.length, estados: estados.length };
}

/* -------------------------------------------------------------------------- */
/* Contexto y arranque                                                         */
/* -------------------------------------------------------------------------- */

async function loadContexto(): Promise<Contexto> {
  const [ruleset, mapPool] = await Promise.all([readRuleset(), readMapPool()]);
  const editionFrom = windowBounds(ruleset.window).from;
  const activeDefinitions = new Map(
    OBJECTIVE_DEFINITIONS.filter(
      (definicion) => !ruleset.disabledObjectives.includes(definicion.id),
    ).map((definicion) => [definicion.id, definicion]),
  );

  const eventos = await db.objectiveProgressEvent.findMany({
    where: { editionFrom },
    select: {
      playerId: true,
      editionFrom: true,
      objectiveId: true,
      kind: true,
      at: true,
      ownValue: true,
      otherValue: true,
      repetition: true,
    },
    orderBy: [{ at: "asc" }, { objectiveId: "asc" }],
  });

  const eventosPorJugador = new Map<string, EventoEnBase[]>();

  for (const evento of eventos) {
    const grupo = eventosPorJugador.get(evento.playerId);

    if (grupo === undefined) {
      eventosPorJugador.set(evento.playerId, [evento]);
    } else {
      grupo.push(evento);
    }
  }

  return {
    ruleset,
    mapPoolSize: mapPool.length,
    editionFrom,
    activeObjectiveIds: new Set(activeDefinitions.keys()),
    activeDefinitions,
    eventos,
    eventosPorJugador,
  };
}

async function main(): Promise<void> {
  if (process.env.DATABASE_URL === undefined || process.env.DATABASE_URL.trim() === "") {
    console.error(
      "Falta DATABASE_URL: esta comprobación lee la base de datos. Rellena .env.local con la cadena del proyecto de desarrollo.",
    );
    process.exitCode = 1;
    return;
  }

  console.log("API del overlay: comprobación contra la base de datos (solo lectura)");
  console.log("");

  const contexto = await loadContexto();

  console.log(`Edición: desde ${contexto.editionFrom.toISOString()}`);
  console.log(`Objetivos activos: ${contexto.activeDefinitions.size}`);
  console.log("");

  let participantes = 0;
  let objetivos = 0;
  let clasificaciones = 0;

  await check("participantes", async () => {
    participantes = await checkParticipantes();
  });
  await check("objetivos", async () => {
    objetivos = await checkObjetivos(contexto);
  });
  await check("clasificación de los aprobados", async () => {
    clasificaciones = await checkClasificacion(contexto);
  });

  let progreso = { eventos: contexto.eventos.length, estados: 0 };

  await check("estado y eventos de progreso", async () => {
    progreso = await checkProgreso(contexto);
  });

  console.log("");
  console.log("--- Resumen ---");
  console.log(`Participantes aprobados: ${participantes}`);
  console.log(`Objetivos activos: ${objetivos}`);
  console.log(`Clasificaciones comprobadas: ${clasificaciones}`);
  console.log(`Eventos de la edición: ${progreso.eventos}`);
  console.log(`Estados de la edición: ${progreso.estados}`);
  console.log("");
  console.log(`${passed} comprobaciones correctas, ${failures.length} con errores.`);

  if (failures.length > 0) {
    process.exitCode = 1;
  }
}

void main();
