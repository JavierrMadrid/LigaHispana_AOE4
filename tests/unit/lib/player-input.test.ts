import { describe, expect, it } from "vitest";

import { DEFAULT_COUNTRIES } from "@/lib/countries";
import {
  canonicalDiscordUsername,
  CONTACT_EMAIL_MAX_LENGTH,
  DISCORD_USERNAME_FIELD_MAX_LENGTH,
  DISCORD_USERNAME_MAX_LENGTH,
  foldCountryName,
  isLegacyYoutubeUrl,
  parseCountry,
  parseDiscordUsername,
  parseEmail,
  parseKickChannel,
  parseName,
  parseProfileId,
  parseTwitchChannel,
  parseYoutubeChannel,
} from "@/lib/player-input";

/**
 * Los parsers de los campos que escriben los dos formularios.
 *
 * `registerPlayer` (inscripción pública) y las acciones del panel validan con este
 * mismo módulo, así que lo que se prueba aquí es que los dos caminos digan lo mismo:
 * un canal mal escrito no lo arregla nadie en la siguiente pasada, y por eso se
 * rechazan en lugar de guardarse como `null` en silencio.
 */

describe("parseProfileId", () => {
  it("acepta dígitos, con los espacios de alrededor y sin ellos", () => {
    expect(parseProfileId("1234")).toBe(1234);
    expect(parseProfileId(" 1234 ")).toBe(1234);
  });

  it("cero no es un perfil, y tampoco lo es un número con signo o decimal", () => {
    // La firma es `FormDataEntryValue | null`, así que lo que llega es texto: lo que
    // se descarta son las formas escritas a mano, no un número de JavaScript.
    for (const valor of ["0", "-1", "12.5", "12a", "", "  ", null, "١٢٣٤"]) {
      expect(parseProfileId(valor), String(valor)).toBeNull();
    }
  });
});

describe("parseName", () => {
  it("recorta los espacios de los extremos y exige que no esté vacío", () => {
    expect(parseName("  BeastWizard  ")).toBe("BeastWizard");
    expect(parseName("   ")).toBeNull();
    expect(parseName(null)).toBeNull();
  });

  it("64 caracteres es el tope", () => {
    expect(parseName("a".repeat(64))).toHaveLength(64);
    expect(parseName("a".repeat(65))).toBeNull();
  });
});

describe("parseTwitchChannel", () => {
  it("quita la arroba y guarda en minúsculas", () => {
    expect(parseTwitchChannel("@BeastWizard")).toBe("beastwizard");
    expect(parseTwitchChannel("  BeastWizard ")).toBe("beastwizard");
  });

  it("rechaza lo que no es `[A-Za-z0-9_]` de 3 a 25 caracteres", () => {
    for (const valor of ["ab", "a".repeat(26), "con guion", "con punto", "con espacio", "@@@"]) {
      expect(parseTwitchChannel(valor), valor).toBeNull();
    }
  });
});

describe("parseYoutubeChannel", () => {
  it("acepta el handle a secas, con arroba y en las tres formas de URL que se teclean", () => {
    // Lo que se guarda es siempre el handle pelado: es la forma que consume
    // `forHandle` de la API y la que se compone en el enlace.
    for (const valor of [
      "BeastWizard",
      "@BeastWizard",
      "youtube.com/@BeastWizard",
      "https://www.youtube.com/@BeastWizard",
      "https://youtube.com/@BeastWizard/live",
      "https://www.youtube.com/@BeastWizard/videos?sub_confirmation=1",
    ]) {
      expect(parseYoutubeChannel(valor), valor).toBe("beastwizard");
    }
  });

  it("el rango es el de YouTube, no el de Twitch: 30 frente a 25", () => {
    expect(parseYoutubeChannel("a".repeat(30))).toHaveLength(30);
    expect(parseYoutubeChannel("a".repeat(31))).toBeNull();
  });

  it("las URLs `/c/` y `/user/` no llevan el handle, así que no hay de dónde sacarlo", () => {
    // Aceptarlas guardando el trozo de la URL produciría un canal que no existe, y
    // probarlo ya es trabajo de una pasada por cada participante.
    expect(parseYoutubeChannel("https://www.youtube.com/c/BeastWizard")).toBeNull();
    expect(parseYoutubeChannel("https://www.youtube.com/user/BeastWizard")).toBeNull();
  });

  it("el motivo de las URLs antiguas se distingue del resto de inválidos", () => {
    // Es lo que permite que el formulario diga "usa el @nombre del canal" en vez de
    // un "esto no vale" que no explica nada.
    expect(isLegacyYoutubeUrl("https://www.youtube.com/c/BeastWizard")).toBe(true);
    expect(isLegacyYoutubeUrl("youtube.com/user/BeastWizard")).toBe(true);
    expect(isLegacyYoutubeUrl("https://www.youtube.com/@BeastWizard")).toBe(false);
    expect(isLegacyYoutubeUrl("@BeastWizard")).toBe(false);
  });

  it("un campo vacío da `null`, como en las otras dos plataformas", () => {
    expect(parseYoutubeChannel("")).toBeNull();
    expect(parseYoutubeChannel(null)).toBeNull();
  });
});

describe("parseKickChannel", () => {
  it("acepta el slug suelto y la URL, con o sin esquema y con mayúsculas", () => {
    for (const valor of [
      "beastwizard",
      "BeastWizard",
      "kick.com/beastwizard",
      "https://kick.com/beastwizard",
      "https://www.Kick.com/BeastWizard",
    ]) {
      expect(parseKickChannel(valor), valor).toBe("beastwizard");
    }
  });

  it("el rango es el de la URL del canal: 25 caracteres, y sin mayúsculas guardadas", () => {
    // El patrón es de minúsculas porque la URL las lleva así, así que validar una
    // cosa y guardar otra dejaría filas que el enlace no puede resolver.
    expect(parseKickChannel("a".repeat(25))).toHaveLength(25);
    expect(parseKickChannel("a".repeat(26))).toBeNull();
    expect(parseKickChannel("con-guion")).toBe("con-guion");
  });

  it("una URL que no es de Kick no es un canal", () => {
    // Kick no tuvo nombres de canal antes del slug, así que no hay una forma antigua
    // de la que rescatar nada.
    expect(parseKickChannel("https://twitch.tv/beastwizard")).toBeNull();
    expect(parseKickChannel("")).toBeNull();
  });
});

describe("parseEmail", () => {
  it("acepta una dirección corriente y la guarda en minúsculas", () => {
    // Ningún proveedor distingue mayúsculas en la parte local, y guardarlas en dos
    // formatos solo crea duplicados que después nadie sabe a cuál pertenecen.
    expect(parseEmail("BeastWizard@Example.COM")).toBe("beastwizard@example.com");
  });

  it("exige un dominio con TLD alfabética", () => {
    for (const valor of [
      "a@localhost",
      "a@b.1",
      "a@b.c",
      "a@.com",
      "a@example..com",
      "a@-example.com",
      "a@example-.com",
    ]) {
      expect(parseEmail(valor), valor).toBeNull();
    }
  });

  it("descarta las formas que no se van a escribir, en vez de adivinarlas", () => {
    for (const valor of [
      "sin arroba",
      "@example.com",
      "a@@example.com",
      "a b@example.com",
      "a.@example.com",
      ".a@example.com",
      "a..b@example.com",
      '"con comillas"@example.com',
    ]) {
      expect(parseEmail(valor), valor).toBeNull();
    }
  });

  it("acepta el `dot-atom` de RFC 5321 en la parte local", () => {
    expect(parseEmail("a!#$%&'*+/=?^_`{|}~-b@example.com")).not.toBeNull();
  });

  it("los espacios de alrededor se recortan antes de validar", () => {
    // Un `FormData` hecho a mano llega con lo que se escribió, espacios incluidos.
    expect(parseEmail("  a@example.com  ")).toBe("a@example.com");
  });

  it("el tope es 254 y las etiquetas y la parte local tienen los suyos", () => {
    expect(CONTACT_EMAIL_MAX_LENGTH).toBe(254);
    expect(parseEmail(`${"a".repeat(65)}@example.com`)).toBeNull();
    expect(parseEmail(`a@${"b".repeat(64)}.com`)).toBeNull();
  });

  it("un campo vacío da `null`, que es lo que el formulario opcional espera", () => {
    expect(parseEmail("")).toBeNull();
    expect(parseEmail(null)).toBeNull();
  });
});

describe("foldCountryName", () => {
  it("quita tildes, mayúsculas y espacios de los extremos", () => {
    expect(foldCountryName("  PUERTO RICO ")).toBe("puerto rico");
    expect(foldCountryName("República Dominicana")).toBe("republica dominicana");
  });

  it("la `ñ` se dobla como la `n` con tilde, y por eso `n` y `ñ` no se confunden", () => {
    // En Unicode la `ñ` es una `n` con tilde encima, así que "Espana" tiene que
    // resolver a "España" y no al revés.
    expect(foldCountryName("Espana")).toBe(foldCountryName("España"));
    expect(foldCountryName("Panama")).toBe(foldCountryName("Panamá"));
    expect(foldCountryName("Nicaragua")).toBe("nicaragua");
  });

  it("normaliza a NFC antes de doblar, para que el resultado no dependa de cómo se escribió", () => {
    // `ñ` (U+00F1) y una `n` con tilde encima son la misma letra escrita de dos
    // maneras, y sin el `NFC` previo solo la primera se descompone.
    const precompuesta = "ñ".normalize("NFC");
    const descompuesta = "ñ".normalize("NFD");

    expect(precompuesta).not.toBe(descompuesta);
    expect(foldCountryName(precompuesta)).toBe(foldCountryName(descompuesta));
  });
});

describe("canonicalDiscordUsername", () => {
  it("quita la arroba, quita el discriminador antiguo y baja a minúsculas", () => {
    // Es la forma en que se guarda y en que se compara con el roster del servidor:
    // si normalizara solo una parte, un nombre no coincidiría consigo mismo.
    expect(canonicalDiscordUsername("@pepito")).toBe("pepito");
    expect(canonicalDiscordUsername("PEPITO")).toBe("pepito");
    expect(canonicalDiscordUsername("@Pepito")).toBe("pepito");
    expect(canonicalDiscordUsername("  @pepito  ")).toBe("pepito");
  });

  it("el `#0000` se va con todo lo que haya detrás, no solo con los dígitos", () => {
    // El `#1234` era el nombre antiguo, único solo dentro de un servidor. Lo que va
    // detrás no es parte del nombre y acabaría en la base si no se recortara entero.
    expect(canonicalDiscordUsername("@pepito#1234")).toBe("pepito");
    expect(canonicalDiscordUsername("pepito#5678")).toBe("pepito");
    expect(canonicalDiscordUsername("@pepito#1234 (nombre real)")).toBe("pepito");
  });

  it("no juzga: normaliza y nada más", () => {
    // Es lo que la usan las dos mitades de lo que es el mismo campo: lo que ya
    // validó Discord (el `username` del OAuth y el de cada miembro del roster) y el
    // parser de lo que escribe una persona, que además exige la arroba y el rango.
    // Si esta rechazara algo, el paso del OAuth fallaría por una regla de formulario.
    expect(canonicalDiscordUsername("")).toBe("");
    expect(canonicalDiscordUsername("a")).toBe("a");
    expect(canonicalDiscordUsername("@con espacios")).toBe("con espacios");
  });
});

describe("parseDiscordUsername", () => {
  it("exige la arroba y devuelve el nombre pelado", () => {
    // La arroba es lo que distingue el nombre global del nombre de display que
    // alguien se haya puesto dentro del servidor, así que es obligatoria y no se
    // perdona. El valor que sale no la lleva: es la forma canónica de la columna.
    expect(parseDiscordUsername("@pepito")).toBe("pepito");
    expect(parseDiscordUsername("@PEPITO")).toBe("pepito");
    expect(parseDiscordUsername("  @Pepito  ")).toBe("pepito");
    expect(parseDiscordUsername("@pepito#1234")).toBe("pepito");
    expect(parseDiscordUsername("@pepito_oficial.2")).toBe("pepito_oficial.2");
  });

  it("sin arroba es un error, y es el caso que más importa", () => {
    // Aceptar "pepito" convertiría un nombre de display en una identidad de
    // Discord. Los dos casos que salen de teclear lo mismo sin querer se rechazan
    // igual: o no es el nombre global, o el nombre dentro del servidor.
    for (const valor of ["pepito", "Pepito", "pepito#1234", " pepito "]) {
      expect(parseDiscordUsername(valor), valor).toBeNull();
    }
  });

  it("vacío, solo arroba y `null` no son un usuario", () => {
    for (const valor of ["", "   ", "@", "@@", " @ ", null]) {
      expect(parseDiscordUsername(valor), String(valor)).toBeNull();
    }
  });

  it("el rango es de 2 a 32 caracteres, y los dos bordes se comprueban", () => {
    expect(parseDiscordUsername("@ab")).toBe("ab");
    expect(parseDiscordUsername("@a")).toBeNull();
    expect(parseDiscordUsername(`@${"a".repeat(DISCORD_USERNAME_MAX_LENGTH)}`)).toBe(
      "a".repeat(DISCORD_USERNAME_MAX_LENGTH),
    );
    expect(parseDiscordUsername(`@${"a".repeat(DISCORD_USERNAME_MAX_LENGTH + 1)}`)).toBeNull();
  });

  it("dentro del nombre no valen espacios ni caracteres de fuera del juego", () => {
    // El patrón se escribe sobre la forma canónica, así que una `@` o un `#` por
    // medio tampoco valen: `canonicalDiscordUsername()` solo quita el primero del
    // principio y el segundo a partir de ahí.
    const invalidos = ["@pepito 1", "@pep to", "@pepito@extra", "@pepito-2", "@pepé", "@pepito/2"];

    for (const valor of invalidos) {
      expect(parseDiscordUsername(valor), valor).toBeNull();
    }
  });

  it("el `maxLength` del campo tiene en cuenta la arroba que se escribe", () => {
    // El navegador limita lo que se escribe, no lo que se guarda: si el campo
    // estuviera limitado al nombre, el último carácter sería la arroba y el nombre
    // válido más largo no entraría nunca.
    expect(DISCORD_USERNAME_FIELD_MAX_LENGTH).toBe(DISCORD_USERNAME_MAX_LENGTH + 1);
  });
});

describe("parseCountry", () => {
  it("devuelve el rótulo canónico de la lista, no lo que se escribió", () => {
    // Es el único parser que devuelve otra cosa, y es deliberado: guardar "españa"
    // haría que el mismo país tuviera dos formas en la tabla y que agrupar por él
    // dejara de funcionar en cuanto alguien escribiera distinto.
    expect(parseCountry("españa", DEFAULT_COUNTRIES)).toBe("España");
    expect(parseCountry("  ESPANA ", DEFAULT_COUNTRIES)).toBe("España");
  });

  it("un valor fuera de la lista admitida no se admite", () => {
    expect(parseCountry("Atlántida", DEFAULT_COUNTRIES)).toBeNull();
  });

  it("vacío da `null` en vez de elegir el primer país de la lista", () => {
    // Quien llama distingue "no lo dice" de "no vale" mirando el valor crudo, así que
    // aquí no se puede devolver un país por defecto.
    for (const valor of ["", "   ", null]) {
      expect(parseCountry(valor, DEFAULT_COUNTRIES), String(valor)).toBeNull();
    }
  });

  it("con la lista vacía no se admite nada, y eso no lanza", () => {
    expect(parseCountry("España", [])).toBeNull();
  });
});
