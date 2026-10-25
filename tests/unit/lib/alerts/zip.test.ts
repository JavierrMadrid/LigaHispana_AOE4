import { describe, expect, it } from "vitest";

import { buildZip, crc32, type ZipEntry } from "@/lib/alerts/zip";

/**
 * El escritor de ZIP del informe.
 *
 * Un ZIP es un formato con firmas, desplazamientos y un CRC por entrada: si una de esas
 * piezas queda mal, el archivo no abre o abre con el contenido corrupto, y ninguna
 * herramienta dice cuál era el byte. Por eso lo que se prueba aquí no es "devuelve
 * bytes" sino la estructura entera, leída de vuelta con un lector mínimo escrito en el
 * propio test: cabeceras locales, directorio central, EOCD y CRC de cada entrada.
 */

const FECHA = new Date("2026-10-20T21:05:42.000Z");

const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const EOCD = 0x06054b50;

function u16(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function u32(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] |
      (bytes[offset + 1] << 8) |
      (bytes[offset + 2] << 16) |
      (bytes[offset + 3] << 24)) >>>
    0
  );
}

/** Una entrada leída del archivo, con las dos cabeceras ya comprobadas entre sí. */
type ReadEntry = {
  name: string;
  bytes: Uint8Array;
  crc: number;
  localOffset: number;
  /** Fin del contenido de la entrada: donde empieza la siguiente cabecera. */
  end: number;
  flags: number;
  method: number;
  version: number;
};

/** Lee un ZIP *store* y falla con un mensaje concreto si la estructura no cuadra. */
function readZip(zip: Uint8Array): { entries: ReadEntry[]; centralStart: number } {
  const eocd = zip.length - 22;

  expect(u32(zip, eocd), "firma del EOCD").toBe(EOCD);
  expect(u16(zip, eocd + 4), "número de disco").toBe(0);
  expect(u16(zip, eocd + 6), "disco del directorio central").toBe(0);

  const total = u16(zip, eocd + 10);
  const centralSize = u32(zip, eocd + 12);
  const centralStart = u32(zip, eocd + 16);

  expect(u16(zip, eocd + 8), "entradas en el disco").toBe(total);
  expect(centralStart + centralSize).toBe(eocd);
  expect(u32(zip, centralStart), "firma del directorio central").toBe(CENTRAL);

  const decoder = new TextDecoder();
  const entries: ReadEntry[] = [];
  let offset = centralStart;

  for (let index = 0; index < total; index += 1) {
    expect(u32(zip, offset), "firma de la cabecera central").toBe(CENTRAL);

    const flags = u16(zip, offset + 8);
    const method = u16(zip, offset + 10);
    const crc = u32(zip, offset + 16);
    const compressed = u32(zip, offset + 20);
    const uncompressed = u32(zip, offset + 24);
    const nameLength = u16(zip, offset + 28);
    const localOffset = u32(zip, offset + 42);
    const name = decoder.decode(zip.slice(offset + 46, offset + 46 + nameLength));

    expect(u32(zip, localOffset), `firma local de ${name}`).toBe(LOCAL);
    expect(u16(zip, localOffset + 4), `versión de ${name}`).toBe(20);
    expect(u16(zip, localOffset + 6), `flags locales de ${name}`).toBe(flags);
    expect(u16(zip, localOffset + 8), `método local de ${name}`).toBe(method);
    expect(u32(zip, localOffset + 14), `crc local de ${name}`).toBe(crc);
    expect(u32(zip, localOffset + 18), `comprimido local de ${name}`).toBe(compressed);
    expect(u32(zip, localOffset + 22), `tamaño local de ${name}`).toBe(uncompressed);

    const localNameLength = u16(zip, localOffset + 26);
    expect(localNameLength).toBe(nameLength);
    expect(decoder.decode(zip.slice(localOffset + 30, localOffset + 30 + nameLength))).toBe(name);

    const contentStart = localOffset + 30 + nameLength;

    entries.push({
      name,
      crc,
      flags,
      method,
      version: u16(zip, localOffset + 4),
      localOffset,
      end: contentStart + uncompressed,
      bytes: zip.slice(contentStart, contentStart + uncompressed),
    });

    offset += 46 + nameLength;
  }

  return { entries, centralStart };
}

function entriesOf(...contents: [name: string, text: string][]): ZipEntry[] {
  const encoder = new TextEncoder();

  return contents.map(([name, text]) => ({ name, bytes: encoder.encode(text) }));
}

describe("crc32", () => {
  it("da el valor conocido del vector de referencia", () => {
    // Vector estándar del CRC-32/ZIP: si el polinomio o el reflejado estuvieran mal,
    // este número sería otro y el archivo abriría con el contenido "corrupto".
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });

  it("el CRC de un contenido vacío es cero", () => {
    expect(crc32(new Uint8Array(0))).toBe(0);
  });
});

describe("buildZip", () => {
  it("escribe cabeceras locales, directorio central y EOCD", () => {
    const zip = buildZip(entriesOf(["uno.csv", "hola"], ["dos.csv", "adios"]), FECHA);
    const { entries, centralStart } = readZip(zip);

    expect(entries.map((entry) => entry.name)).toEqual(["uno.csv", "dos.csv"]);
    expect(new TextDecoder().decode(entries[0].bytes)).toBe("hola");
    expect(new TextDecoder().decode(entries[1].bytes)).toBe("adios");

    // Sin *data descriptor*: el contenido de una entrada acaba justo donde empieza la
    // siguiente cabecera local, y la última termina en el directorio central.
    expect(entries[0].end).toBe(entries[1].localOffset);
    expect(entries[1].end).toBe(centralStart);
  });

  it("usa método store y el flag de nombres UTF-8 en las dos cabeceras", () => {
    const { entries } = readZip(buildZip(entriesOf(["acentuado-ñ.csv", "x"]), FECHA));

    for (const entry of entries) {
      expect(entry.version).toBe(20);
      expect(entry.method).toBe(0);
      expect(entry.flags & 0x0800).toBe(0x0800);
      expect(entry.name).toBe("acentuado-ñ.csv");
    }
  });

  it("el CRC de cada entrada es el de sus bytes", () => {
    const zip = buildZip(entriesOf(["a.csv", "contenido con acentos: ñ"], ["b.csv", ""]), FECHA);
    const { entries } = readZip(zip);

    for (const entry of entries) {
      expect(entry.crc).toBe(crc32(entry.bytes));
    }
  });

  it("es determinista con la misma fecha y cambia con otra", () => {
    const esIgual = (a: Uint8Array, b: Uint8Array) =>
      a.length === b.length && a.every((byte, index) => byte === b[index]);

    const uno = buildZip(entriesOf(["a.csv", "hola"]), FECHA);
    const dos = buildZip(entriesOf(["a.csv", "hola"]), FECHA);
    const otraFecha = buildZip(entriesOf(["a.csv", "hola"]), new Date("2026-10-21T21:05:42.000Z"));

    expect(esIgual(uno, dos)).toBe(true);
    expect(esIgual(uno, otraFecha)).toBe(false);
  });

  it("un archivo sin entradas es solo el EOCD", () => {
    const zip = buildZip([], FECHA);

    expect(zip.length).toBe(22);
    expect(u32(zip, 0)).toBe(EOCD);
    expect(u16(zip, 10)).toBe(0);
  });
});
