import { describe, expect, it } from "vitest";

import {
  camposQueCambian,
  campoSiCambia,
  COUNTRY_UNKNOWN_ERROR,
  DISCORD_USERNAME_INVALID_ERROR,
  DISCORD_USERNAME_REQUIRED_ERROR,
  EMAIL_INVALID_ERROR,
  KICK_INVALID_ERROR,
  NAME_REQUIRED_ERROR,
  parsePlayerField,
  parsePlayerFieldsWithoutCountry,
  PLAYER_FIELD_LABELS,
  PLAYER_FIELDS,
  TWITCH_INVALID_ERROR,
  YOUTUBE_INVALID_ERROR,
  YOUTUBE_LEGACY_URL_ERROR,
  type CamposEditables,
  type PlayerFieldsInput,
} from "@/lib/player-fields";

/**
 * Las reglas de los siete campos editables, que comparten el alta, la edición y la
 * reversión de una edición.
 *
 * Todo lo que se prueba aquí es **puro**: los parsers no tocan la base ni la red, y la
 * lista de países entra como parámetro. Lo que se fija es lo que el panel no puede
 * permitirse que se separe en tres sitios: qué valor canónico sale de cada campo, qué
 * texto se enseña cuando no vale, y en qué **orden** se comprueban (porque de eso
 * depende cuál de los errores se lee).
 */

const COUNTRIES = ["España", "Argentina"];

/** Un formulario con los seis campos que no necesitan leer nada, todos válidos. */
const VALIDO: PlayerFieldsInput = {
  name: "BeastWizard",
  contactEmail: "beast@correo.com",
  twitchChannel: "beast",
  youtubeChannel: "beast",
  kickChannel: "beast",
  discordUsername: "@beast",
};

describe("PLAYER_FIELDS", () => {
  it("está en el orden del formulario, con el @usuario al final", () => {
    expect(PLAYER_FIELDS).toEqual([
      "name",
      "contactEmail",
      "twitchChannel",
      "youtubeChannel",
      "kickChannel",
      "country",
      "discordUsername",
    ]);
  });

  it("cada campo tiene su rótulo, y ninguno se queda sin él", () => {
    for (const field of PLAYER_FIELDS) {
      expect(PLAYER_FIELD_LABELS[field]).toBeTruthy();
    }
  });
});

describe("parsePlayerField", () => {
  it("el nombre es obligatorio y no pasa de 64 caracteres", () => {
    expect(parsePlayerField("name", "BeastWizard", COUNTRIES)).toEqual({
      ok: true,
      value: "BeastWizard",
    });
    expect(parsePlayerField("name", "", COUNTRIES)).toEqual({
      ok: false,
      error: NAME_REQUIRED_ERROR,
    });
    expect(parsePlayerField("name", null, COUNTRIES)).toEqual({
      ok: false,
      error: NAME_REQUIRED_ERROR,
    });
    expect(parsePlayerField("name", "x".repeat(65), COUNTRIES)).toEqual({
      ok: false,
      error: NAME_REQUIRED_ERROR,
    });
  });

  it("un canal vacío es `null` y uno mal escrito es un error", () => {
    expect(parsePlayerField("twitchChannel", "", COUNTRIES)).toEqual({ ok: true, value: null });
    expect(parsePlayerField("twitchChannel", null, COUNTRIES)).toEqual({ ok: true, value: null });
    expect(parsePlayerField("twitchChannel", "ab", COUNTRIES)).toEqual({
      ok: false,
      error: TWITCH_INVALID_ERROR,
    });
    // El canal se guarda en minúsculas y sin la arroba inicial.
    expect(parsePlayerField("twitchChannel", "@Beast", COUNTRIES)).toEqual({
      ok: true,
      value: "beast",
    });
  });

  it("el canal de YouTube distingue el valor mal escrito de la URL antigua", () => {
    expect(parsePlayerField("youtubeChannel", "https://youtube.com/c/beast", COUNTRIES)).toEqual({
      ok: false,
      error: YOUTUBE_LEGACY_URL_ERROR,
    });
    expect(parsePlayerField("youtubeChannel", "no vale!", COUNTRIES)).toEqual({
      ok: false,
      error: YOUTUBE_INVALID_ERROR,
    });
    expect(parsePlayerField("youtubeChannel", "", COUNTRIES)).toEqual({ ok: true, value: null });
  });

  it("el canal de Kick acepta el slug y la URL, y guarda el slug", () => {
    expect(parsePlayerField("kickChannel", "kick.com/Beast", COUNTRIES)).toEqual({
      ok: true,
      value: "beast",
    });
    expect(parsePlayerField("kickChannel", "a", COUNTRIES)).toEqual({
      ok: false,
      error: KICK_INVALID_ERROR,
    });
  });

  it("el correo vacío es `null` y uno mal escrito es un error", () => {
    expect(parsePlayerField("contactEmail", "", COUNTRIES)).toEqual({ ok: true, value: null });
    expect(parsePlayerField("contactEmail", "no-es-un-correo", COUNTRIES)).toEqual({
      ok: false,
      error: EMAIL_INVALID_ERROR,
    });
    expect(parsePlayerField("contactEmail", "Beast@Correo.COM", COUNTRIES)).toEqual({
      ok: true,
      value: "beast@correo.com",
    });
  });

  it("el país vacío es `null`, uno de la lista sale con su rótulo y otro es un error", () => {
    expect(parsePlayerField("country", "", COUNTRIES)).toEqual({ ok: true, value: null });
    expect(parsePlayerField("country", "españa", COUNTRIES)).toEqual({
      ok: true,
      value: "España",
    });
    expect(parsePlayerField("country", "Narnia", COUNTRIES)).toEqual({
      ok: false,
      error: COUNTRY_UNKNOWN_ERROR,
    });
  });

  it("el @usuario es obligatorio, se escribe con arroba y se guarda sin ella", () => {
    expect(parsePlayerField("discordUsername", "@Pepito", COUNTRIES)).toEqual({
      ok: true,
      value: "pepito",
    });
    expect(parsePlayerField("discordUsername", "", COUNTRIES)).toEqual({
      ok: false,
      error: DISCORD_USERNAME_REQUIRED_ERROR,
    });
    expect(parsePlayerField("discordUsername", "pepito", COUNTRIES)).toEqual({
      ok: false,
      error: DISCORD_USERNAME_INVALID_ERROR,
    });
  });
});

describe("parsePlayerFieldsWithoutCountry", () => {
  it("un formulario válido sale entero y canónico", () => {
    const parsed = parsePlayerFieldsWithoutCountry({ ...VALIDO, discordUsername: "@Beast" });

    expect(parsed.ok).toBe(true);

    if (parsed.ok) {
      expect(parsed.campos).toEqual({
        name: "BeastWizard",
        contactEmail: "beast@correo.com",
        twitchChannel: "beast",
        youtubeChannel: "beast",
        kickChannel: "beast",
        discordUsername: "beast",
      });
    }
  });

  it("devuelve el primer error en el orden del formulario", () => {
    // El nombre y el `@usuario` están mal: se lee el del nombre, que va antes.
    const parsed = parsePlayerFieldsWithoutCountry({
      ...VALIDO,
      name: "",
      discordUsername: "",
    });

    expect(parsed).toEqual({ ok: false, error: NAME_REQUIRED_ERROR });
  });

  it("no valida el país: no está en su entrada ni en su salida", () => {
    const parsed = parsePlayerFieldsWithoutCountry(VALIDO);

    expect(parsed.ok).toBe(true);

    if (parsed.ok) {
      expect("country" in parsed.campos).toBe(false);
    }
  });
});

describe("camposQueCambian", () => {
  const antes: CamposEditables = {
    name: "Beast",
    contactEmail: null,
    twitchChannel: null,
    youtubeChannel: null,
    kickChannel: null,
    country: null,
    discordUsername: "beast",
  };

  it("sin cambios no devuelve nada", () => {
    expect(camposQueCambian(antes, { ...antes })).toEqual([]);
  });

  it("los devuelve con su rótulo, sus dos valores y en el orden del formulario", () => {
    const despues: CamposEditables = {
      ...antes,
      name: "BeastWizard",
      country: "España",
    };

    expect(camposQueCambian(antes, despues)).toEqual([
      { campo: "name", etiqueta: "nombre", antes: "Beast", despues: "BeastWizard" },
      { campo: "country", etiqueta: "país", antes: null, despues: "España" },
    ]);
  });

  it("un campo que vuelve a `null` también es un cambio", () => {
    const despues: CamposEditables = { ...antes, discordUsername: null };

    expect(camposQueCambian(antes, despues)).toEqual([
      {
        campo: "discordUsername",
        etiqueta: "usuario de Discord",
        antes: "beast",
        despues: null,
      },
    ]);
  });
});

describe("campoSiCambia", () => {
  it("mismo valor, nada; distinto, el cambio", () => {
    expect(campoSiCambia(null, null, "country", "país")).toEqual([]);
    expect(campoSiCambia("a", "a", "name", "nombre")).toEqual([]);
    expect(campoSiCambia("a", "b", "name", "nombre")).toEqual([
      { campo: "name", etiqueta: "nombre", antes: "a", despues: "b" },
    ]);
  });
});
