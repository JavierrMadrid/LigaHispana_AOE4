import { describe, expect, it } from "vitest";

import {
  DISCORD_CHECK_TTL_HOURS,
  DISCORD_CHECK_TTL_MS,
  DISCORD_MEMBER_STATUS,
  DISCORD_MISSING_STATUS,
  DISCORD_ROSTER_TTL_HOURS,
  DISCORD_ROSTER_TTL_MS,
  discordCheckIsDue,
  discordMembershipVerdictFromStatus,
  matchRosterUsername,
  rosterIsDue,
  type DiscordMembershipVerdict,
  type DiscordRosterMember,
} from "@/lib/discord/membership";

/**
 * La pertenencia al servidor de Discord: cuándo toca comprobar y qué se afirma con lo
 * que respondió la API.
 *
 * Lo que se comprueba aquí es **la parte que decide qué se escribe en `Player`**, y
 * por eso es lo único que hay que mirar en este módulo: un `unknown` son dos cosas
 * distintas —"no está en el servidor" y "no se ha podido comprobar"— y leerlo al revés
 * publica una afirmación que nadie ha hecho, con el nombre del jugador al lado.
 *
 * Todo es puro y sin red: el reloj va en la mano (fechas escritas a mano, no
 * `Date.now()`) y la respuesta es un número o una lista escrita a mano, así que ni la
 * base de datos ni el token del bot hacen falta para comprobar lo que decide qué se
 * escribe: ni el veredicto por cuenta, ni cuándo hay que releer la lista de miembros,
 * ni cómo se busca un `@usuario` dentro de ella.
 */

/** El instante de referencia de todos los casos: 2026-10-06 12:00:00 UTC. */
const AHORA = new Date("2026-10-06T12:00:00.000Z");

/** `checkedAt` a las 12 h exactas, el borde del TTL. */
const HACE_DOCE_HORAS = new Date(AHORA.getTime() - DISCORD_CHECK_TTL_MS);

/** Una lista de miembros de ejemplo, tal y como la devuelve `fetchGuildRoster()`. */
const ROSTER: DiscordRosterMember[] = [
  { id: "1000000000000000001", username: "beastwizard" },
  { id: "1000000000000000002", username: "pepito" },
  { id: "1000000000000000003", username: "pepito_oficial" },
];

describe("la caché de la comprobación", () => {
  it("duelve horas, que es lo que se decidió", () => {
    // El número está en el docblock de `Player` del schema:
    // si el TTL se cambiase sin actualizarlo, la comprobación y su
    // documentación empezarían a discrepar sin que nada fallara.
    expect(DISCORD_CHECK_TTL_HOURS).toBe(12);
    expect(DISCORD_CHECK_TTL_MS).toBe(12 * 3_600_000);
  });

  it("nunca comprobado vence, y es lo único que se lee sin `Date` de por medio", () => {
    // `null` es el estado de toda fila recién aprovada y de toda alta hecha sin
    // Discord. Es el caso que hace falta cubrir porque `null - now` es `NaN` y
    // `NaN >= ttl` es `false`: sin el caso explícito, esos jugadores no se
    // comprobarían nunca.
    expect(discordCheckIsDue(null, AHORA)).toBe(true);
  });

  it("antes de las doce horas no toca, y a las doce horas exactas sí", () => {
    // El borde importa por el `>=`: si fuera `>`, una comprobación hecha justo en el
    // límite se quedaría esperando otra pasada entera, y con un cron de cinco minutos
    // eso son cinco minutos de retraso en cada jugador. Y un milisegundo antes sí
    // tiene que esperar, que es lo que hace que la caché sea de doce horas y no de
    // "casi doce horas".
    expect(discordCheckIsDue(new Date(AHORA.getTime() - DISCORD_CHECK_TTL_MS + 1), AHORA)).toBe(
      false,
    );
    expect(discordCheckIsDue(HACE_DOCE_HORAS, AHORA)).toBe(true);
  });

  it("pasadas las doce horas vence, y un plazo menor se puede pedir por parámetro", () => {
    expect(discordCheckIsDue(new Date(AHORA.getTime() - DISCORD_CHECK_TTL_MS - 1), AHORA)).toBe(
      true,
    );
    // El plazo por parámetro es lo que le serviría a quien quisiera reintentar antes
    // de que se cumpliesen las doce horas; si no existiera habría que esperar a la
    // siguiente pasada natural para volver a mirar a un jugador.
    expect(discordCheckIsDue(new Date(AHORA.getTime() - 60_000), AHORA, 30_000)).toBe(true);
    expect(discordCheckIsDue(new Date(AHORA.getTime() - 10_000), AHORA, 30_000)).toBe(false);
  });
});

describe("el veredicto, según lo que respondió la API", () => {
  it("los estados que sí significan algo", () => {
    // Los números están en el módulo y no escritos aquí a mano, porque son los que
    // lee la función: si alguien los cambiara sin cambiar el mapeo, el test lo diría.
    expect(DISCORD_MEMBER_STATUS).toBe(200);
    expect(DISCORD_MISSING_STATUS).toBe(404);
    expect(discordMembershipVerdictFromStatus(DISCORD_MEMBER_STATUS)).toBe("member");
    expect(discordMembershipVerdictFromStatus(DISCORD_MISSING_STATUS)).toBe("not-member");
  });

  it("cualquier otro estado es `unknown`, y un `unknown` no escribe nada", () => {
    // Esta es la lista entera de lo que no se puede convertir en un veredicto, y cada
    // caso tiene un motivo: el `401` es un token del bot caducado o mal puesto, el
    // `403` un bot sin permisos en el servidor, el `429` y el `5xx` Discord con un
    // rato malo, el `204` un `2xx` que esta ruta no devuelve, el `301` una redirección
    // y el `0` una respuesta que no llegó. Todos affirmarían "no está en el servidor"
    // sin que nadie lo haya comprobado, que es justo lo que esta regla no puede hacer.
    const indeterminados: (number | null)[] = [null, 0, 201, 204, 301, 302, 400, 401, 403, 429, 500, 502, 503];

    for (const status of indeterminados) {
      expect(
        discordMembershipVerdictFromStatus(status),
        `el estado ${status ?? "sin respuesta"} no puede afirmar nada`,
      ).toBe("unknown");
    }
  });

  it("los tres veredictos son los tres y solo los tres", () => {
    // El resumen de la pasada y el `AlertAnchorDetail` viven al otro lado de esta
    // función, así que un cuarto valor tendría a alguien indexando `verdicts` con una
    // clave que no existe.
    const veredictos: DiscordMembershipVerdict[] = ["member", "not-member", "unknown"];

    expect(new Set(veredictos).size).toBe(3);
    for (const status of [200, 404, 500, null]) {
      expect(veredictos).toContain(discordMembershipVerdictFromStatus(status));
    }
  });
});

describe("la caché del roster", () => {
  it("duelve horas, igual que la del veredicto, y son dos relojes distintos", () => {
    // Las dos cifras están en los docblocks de `Player` del schema: si una se
    // cambiara sin actualizar lo otro, la comprobación y su documentación
    // empezarían a discrepar sin que nada fallara. Que coincidan no
    // significa que sean la misma caché: la del roster es un dato compartido y la del
    // veredicto es uno por fila.
    expect(DISCORD_ROSTER_TTL_HOURS).toBe(12);
    expect(DISCORD_ROSTER_TTL_MS).toBe(12 * 3_600_000);
  });

  it("nunca leído vence, y el borde es el mismo que el del veredicto", () => {
    expect(rosterIsDue(null, AHORA)).toBe(true);
    expect(rosterIsDue(new Date(AHORA.getTime() - DISCORD_ROSTER_TTL_MS + 1), AHORA)).toBe(false);
    expect(rosterIsDue(new Date(AHORA.getTime() - DISCORD_ROSTER_TTL_MS), AHORA)).toBe(true);
    // El plazo por parámetro sirve para forzar un refresco antes de las doce horas.
    expect(rosterIsDue(new Date(AHORA.getTime() - 60_000), AHORA, 30_000)).toBe(true);
    expect(rosterIsDue(new Date(AHORA.getTime() - 10_000), AHORA, 30_000)).toBe(false);
  });
});

describe("buscar un @usuario en el roster", () => {
  it("una coincidencia exacta devuelve la cuenta", () => {
    expect(matchRosterUsername("pepito", ROSTER)).toEqual({ id: "1000000000000000002" });
  });

  it("la comparación no distingue mayúsculas, porque los dos lados son canónicos", () => {
    // Los dos lados llegan ya normalizados (el callback y `parseDiscordUsername()` por
    // un lado, la API por otro) y solo hay que ponerse de acuerdo en las mayúsculas.
    // Un roster escrito en mayúsculas no puede ser el culpable de que el alta de admin
    // no encuentre la cuenta.
    expect(matchRosterUsername("PEPITO", ROSTER)).toEqual({ id: "1000000000000000002" });
    expect(matchRosterUsername("BeastWizard", ROSTER)).toEqual({ id: "1000000000000000001" });
    // Los espacios de los extremos también se ignoran, por si algo llega sin normalizar.
    expect(matchRosterUsername("  pepito ", ROSTER)).toEqual({ id: "1000000000000000002" });
  });

  it("es una igualdad exacta: ni prefijos ni sufijos", () => {
    // Un "empieza por" o un `includes` convertirían a `pepito` en un acierto dentro del
    // servidor (`pepito_oficial`), que es justo la cuenta que hay que distinguir.
    expect(matchRosterUsername("pep", ROSTER)).toBe("no-encontrado");
    expect(matchRosterUsername("pepito_ofi", ROSTER)).toBe("no-encontrado");
    expect(matchRosterUsername("pepito_oficial", ROSTER)).toEqual({
      id: "1000000000000000003",
    });
  });

  it("ausente y ambiguo son dos respuestas distintas", () => {
    // No encontrado es un hecho sobre el `@usuario` (no hay nadie con ese nombre en el
    // servidor) y ambiguo es "no se puede saber". who llama escribe una alerta en los
    // dos casos, pero **no** escribe el `discordUserId` en ninguno, y en el ambiguo no
    // hay nada que escribir aunque se quisiera.
    expect(matchRosterUsername("noesta", ROSTER)).toBe("no-encontrado");
    expect(matchRosterUsername("pepito", [])).toBe("no-encontrado");
    expect(matchRosterUsername("", ROSTER)).toBe("no-encontrado");

    const repetido: DiscordRosterMember[] = [
      { id: "1", username: "pepito" },
      { id: "2", username: "Pepito" },
    ];

    expect(matchRosterUsername("pepito", repetido)).toBe("ambiguo");
  });

  it("el mismo id repetido no lo vuelve ambiguo", () => {
    // `roster.ts` ya lo deduplica al leer, pero la función no depende de eso: lo que
    // importa es que dos filas con el mismo `id` son la misma cuenta y no dos.
    const mismaCuenta: DiscordRosterMember[] = [
      { id: "42", username: "pepito" },
      { id: "42", username: "pepito" },
    ];

    expect(matchRosterUsername("pepito", mismaCuenta)).toEqual({ id: "42" });
  });
});