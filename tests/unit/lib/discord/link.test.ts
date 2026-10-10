import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  DISCORD_LINK_COOKIE,
  DISCORD_STATE_COOKIE,
  signDiscordLink,
  verifyDiscordLink,
  type DiscordLink,
} from "@/lib/discord/link";

/**
 * La cookie del vínculo con Discord: qué se acepta, qué se rechaza y por qué.
 *
 * Es la única barrera entre la identidad que devuelve Discord y la fila que se
 * escribe en `Player`, así que lo que se comprueba aquí es lo único que separa "la
 * cuenta que la persona conectó" de "el id que alguien puso en una cookie". Todo es
 * puro —sin base de datos, sin red, sin variables de entorno y con el reloj en la
 * mano—, que es lo que permite probar la caducidad sin esperar veinte minutos.
 */

/** El instante de referencia de todos los casos: 2026-10-06 12:00:00 UTC. */
const AHORA = Date.parse("2026-10-06T12:00:00.000Z");

/** Veinte minutos, el TTL que usa el módulo de entorno. */
const TTL = 20 * 60;

const SECRETO = "secreto-de-prueba";

const VINCULO: Omit<DiscordLink, "iat"> = {
  userId: "1234567890123456789",
  username: "jugador_de_la_liga",
  joined: true,
};

function cookieValida(overrides: Partial<Omit<DiscordLink, "iat">> = {}): string {
  return signDiscordLink({ ...VINCULO, ...overrides }, SECRETO, AHORA);
}

/** Reescribe el cuerpo de la cookie y deja la firma vieja: es alterar la identidad. */
function alterarCuerpo(cookie: string, cambios: Record<string, unknown>): string {
  const cuerpo = Buffer.from(cookie.split(".")[0], "base64url").toString("utf8");
  const alterado = Buffer.from(
    JSON.stringify({ ...(JSON.parse(cuerpo) as Record<string, unknown>), ...cambios }),
    "utf8",
  ).toString("base64url");

  return `${alterado}.${cookie.slice(cookie.indexOf(".") + 1)}`;
}

describe("los nombres de las cookies", () => {
  it("son dos cookies distintas, con los nombres que espera el resto del código", () => {
    // El nombre de `discord_link` aparece en el callback, en la página y en la Server
    // Action; el de `state`, en el arranque del OAuth y en el callback. Que se
    // renombre uno sin el otro rompe el paso entero sin que nada falle en el sitio.
    expect(DISCORD_LINK_COOKIE).toBe("discord_link");
    expect(DISCORD_STATE_COOKIE).toBe("discord_oauth_state");
  });
});

describe("una cookie válida", () => {
  it("devuelve exactamente lo que se firmó", () => {
    const verificado = verifyDiscordLink(cookieValida(), SECRETO, TTL, AHORA);

    expect(verificado.ok).toBe(true);
    expect(verificado.ok && verificado.link).toEqual({
      ...VINCULO,
      iat: Math.floor(AHORA / 1000),
    });
  });

  it("viaja en un solo valor con dos partes separadas por un punto", () => {
    // El formato es `base64url(payload).base64url(firma)`: sin el punto no se podría
    // separar lo firmado de lo que firma, y con `=`, `+` o `/` dentro el valor no
    // sobreviviría a un viaje en una cabecera de cookie.
    const cookie = cookieValida();

    expect(cookie.split(".")).toHaveLength(2);
    expect(cookie).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });

  it("también vale cuando el bot no pudo unir a la persona al servidor", () => {
    // `joined: false` es un estado **legítimo**, no un fallo: la inscripción se acepta
    // igual y el formulario enseña la invitación de respaldo. Si `joined: false`
    // invalidara la cookie, el paso no podría completarse en el caso que
    // precisamente se decidió no bloquear.
    const verificado = verifyDiscordLink(cookieValida({ joined: false }), SECRETO, TTL, AHORA);

    expect(verificado.ok).toBe(true);
    expect(verificado.ok && verificado.link.joined).toBe(false);
  });

  it("aguanta un minuto de desfase de reloj hacia delante, y no más", () => {
    // La tolerancia es solo hacia delante: si el isolate que verifica va un poco
    // atrasado con el que firmó, la cookie vale; más de un minuto y ya no se sabe qué
    // reloj marcó el `iat`, así que no vale.
    const dentro = verifyDiscordLink(cookieValida(), SECRETO, TTL, AHORA - 60_000);
    const fuera = verifyDiscordLink(cookieValida(), SECRETO, TTL, AHORA - 61_000);

    expect(dentro.ok).toBe(true);
    expect(fuera).toEqual({ ok: false, reason: "caducada" });
  });
});

describe("una cookie caducada", () => {
  it("pasado el TTL no vale, y dice por qué", () => {
    const verificado = verifyDiscordLink(
      cookieValida(),
      SECRETO,
      TTL,
      AHORA + (TTL + 1) * 1_000,
    );

    expect(verificado).toEqual({ ok: false, reason: "caducada" });
  });

  it("el TTL vive en la firma, no en el `maxAge` del navegador", () => {
    // El `maxAge` de la cookie es una cortesía del navegador: si alguien lo ignora o
    // copia el valor a mano, la caducidad tiene que estar dentro. Por eso `iat` viaja
    // en el cuerpo firmado.
    const cuerpo = JSON.parse(
      Buffer.from(cookieValida().split(".")[0], "base64url").toString("utf8"),
    ) as { iat: number };

    expect(cuerpo.iat).toBe(Math.floor(AHORA / 1000));
  });

  it("un `iat` muy en el futuro no protege nada, así que se trata como caducada", () => {
    // Con el reloj yendo hacia atrás, el TTL no protege de nada y una cookie "del
    // futuro" duraría indefinidamente: por eso un desfase grande hacia delante es
    // exactamente el caso que se rechaza.
    const verificado = verifyDiscordLink(cookieValida(), SECRETO, TTL, AHORA - 10 * 60_000);

    expect(verificado).toEqual({ ok: false, reason: "caducada" });
  });
});

describe("una cookie manipulada", () => {
  it("cambiar el id de la cuenta rompe la firma", () => {
    // Es el ataque que importa: poner el `userId` de otra persona. Con el cuerpo
    // cambiado la firma ya no cuadra, y la cookie se rechaza antes de leer el contenido.
    const cookie = alterarCuerpo(cookieValida(), { userId: "9999999999999999999" });

    expect(verifyDiscordLink(cookie, SECRETO, TTL, AHORA)).toEqual({
      ok: false,
      reason: "firma",
    });
  });

  it("cambiar `joined` para fingir que se unió también rompe la firma", () => {
    // Al revés del caso anterior: una cookie honesta de `joined: false` no se puede
    // editar a `true` sin volver a firmarla, que es lo que impide declarar como hecho
    // una unión que el bot no pudo hacer.
    const cookie = alterarCuerpo(cookieValida({ joined: false }), { joined: true });

    expect(verifyDiscordLink(cookie, SECRETO, TTL, AHORA)).toEqual({
      ok: false,
      reason: "firma",
    });
  });

  it("cambiar solo la firma no vale", () => {
    const cookie = cookieValida();
    const conOtraFirma = `${cookie.slice(0, cookie.indexOf(".") + 1)}otra-firma`;

    expect(verifyDiscordLink(conOtraFirma, SECRETO, TTL, AHORA)).toEqual({
      ok: false,
      reason: "firma",
    });
  });

  it("firmar con otro secreto no vale, aunque el contenido sea el bueno", () => {
    // Es el caso de un despliegue con el secreto cambiado: las cookies que quedaron de
    // antes dejan de valer, que es lo que tiene que pasar, y no al revés.
    expect(verifyDiscordLink(cookieValida(), "otro-secreto", TTL, AHORA)).toEqual({
      ok: false,
      reason: "firma",
    });

    const firmadaConOtro = signDiscordLink(VINCULO, "otro-secreto", AHORA);

    expect(verifyDiscordLink(firmadaConOtro, SECRETO, TTL, AHORA)).toEqual({
      ok: false,
      reason: "firma",
    });
  });

  it("la firma se comprueba antes que la caducidad", () => {
    // El orden importa: una cookie manipulada **y** vieja tiene que salir como "firma",
    // no como "caducada", porque decir "caducada" de algo que nadie ha autenticado es
    // una afirmación sobre un contenido que no se ha leído.
    const cookie = `${cookieValida().slice(0, cookieValida().indexOf(".") + 1)}otra-firma`;

    expect(verifyDiscordLink(cookie, SECRETO, TTL, AHORA + (TTL + 1) * 1_000)).toEqual({
      ok: false,
      reason: "firma",
    });
  });
});

describe("una cookie que no es una cookie", () => {
  it("lo vacío, lo ausente y lo que no tiene punto no valen", () => {
    for (const valor of [undefined, null, "", "   ", "abc", ".", "solo-el-cuerpo."]) {
      expect(verifyDiscordLink(valor, SECRETO, TTL, AHORA).ok).toBe(false);
    }
  });

  it("sin secreto ninguna cookie vale, ni una bien firmada", () => {
    // El camino de "módulo apagado": sin secreto no hay contra qué verificar, y lo
    // correcto es rechazar en vez de aceptar, que es lo que haría un `if` que solo
    // mirase el contenido.
    expect(verifyDiscordLink(cookieValida(), null, TTL, AHORA)).toEqual({
      ok: false,
      reason: "sin-secreto",
    });
    expect(verifyDiscordLink(cookieValida(), "", TTL, AHORA)).toEqual({
      ok: false,
      reason: "sin-secreto",
    });
  });

  it("un cuerpo firmado que no es un vínculo se rechaza como contenido", () => {
    // Se firma a propósito un cuerpo que no tiene la forma del vínculo (con el mismo
    // secreto, que es lo que haría alguien con acceso a él) para comprobar que la
    // validación del contenido existe y no basta con que la firma cuadre.
    const cuerpo = Buffer.from(JSON.stringify({ userId: 42 }), "utf8").toString("base64url");
    const firma = createHmac("sha256", SECRETO).update(cuerpo).digest("base64url");

    expect(verifyDiscordLink(`${cuerpo}.${firma}`, SECRETO, TTL, AHORA)).toEqual({
      ok: false,
      reason: "contenido",
    });
  });
});
