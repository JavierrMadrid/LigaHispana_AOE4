/**
 * Escritor de ZIP mínimo: método *store* (sin compresión), sin dependencias y sin
 * APIs de Node, para que valga igual en el Worker que en Vitest.
 *
 * ## Por qué no una librería
 *
 * Lo único que hace falta es empaquetar tres ficheros de texto que ya están en
 * memoria. `fflate` o `jszip` traerían deflate, ZIP64, cifrado y una superficie de
 * API que aquí no se usa: la mitad del ZIP que se implementa —cabeceras, CRC32 y los
 * dos directorios— cabe en lo que ocupa el import de una de esas librerías, y así el
 * proyecto no suma una dependencia por un formato que no va a cambiar.
 *
 * ## Qué formato escribe
 *
 * El ZIP clásico (versión 2.0), sin *data descriptor* y sin ZIP64: los tamaños se
 * conocen antes de escribir porque las entradas ya son `Uint8Array` completos, así
 * que la cabecera local puede llevarlos. La marca de hora es la de `timestamp`, que
 * entra como parámetro para que un test pueda fijarla y comparar bytes.
 *
 * Los nombres van en UTF-8 con el flag 0x0800 puesto: si un día una entrada lleva un
 * acento, la herramienta que lo abra lo lee bien en vez de enseñar mojibake.
 */

/** Una entrada del archivo: su nombre y su contenido ya codificado. */
export type ZipEntry = {
  name: string;
  bytes: Uint8Array;
};

const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;

/** Versión 2.0, la que introduce el *store* con el flag de nombres UTF-8. */
const VERSION_NEEDED = 20;

/** El bit 11 dice que el nombre de la entrada está en UTF-8. */
const UTF8_NAME_FLAG = 0x0800;

/** 0 = *store*: el contenido va tal cual, sin deflate. */
const STORE_METHOD = 0;

/** 1980-01-01 00:00:00, el cero del formato de fecha DOS. */
const DOS_EPOCH_YEAR = 1980;

const MAX_UINT16 = 0xffff;
const MAX_UINT32 = 0xffffffff;

/**
 * Tabla del CRC32, calculada una vez.
 *
 * El polinomio es el reflejado de 0x04C11DB7 (0xEDB88320), que es el que pide el
 * formato ZIP. Se genera en el primer uso y no al importar el módulo para que el
 * arranque en frío del Worker no pague 256 iteraciones que quizá no necesite.
 */
let crcTable: Uint32Array | null = null;

function buildingCrcTable(): Uint32Array {
  const table = new Uint32Array(256);

  for (let index = 0; index < 256; index += 1) {
    let value = index;

    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }

    table[index] = value >>> 0;
  }

  return table;
}

/** CRC32 de un contenido, sin signo. Lo comprueba el propio ZIP y la herramienta que lo abre. */
export function crc32(bytes: Uint8Array): number {
  crcTable ??= buildingCrcTable();
  const table = crcTable;

  let crc = 0xffffffff;

  for (const byte of bytes) {
    crc = (table[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  }

  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * La hora y la fecha en el formato de DOS (dos `uint16`), a partir de `timestamp`.
 *
 * Se leen en **UTC** y no en la hora local: el navegador, el Worker y el servidor de
 * desarrollo están en husos distintos, y una hora que depende de quién llama hace que
 * los mismos datos den bytes distintos. Que la marca sea UTC no se nota al descomprimir
 * (es solo el `mtime` de la entrada) y a cambio la salida es reproducible.
 *
 * El año se recorta a 1980 porque el formato no representa nada anterior, y a 2107
 * porque se queda sin bits.
 */
function dosTimestamp(timestamp: Date): { time: number; date: number } {
  const year = Math.min(Math.max(timestamp.getUTCFullYear(), DOS_EPOCH_YEAR), 2107);

  const time =
    (timestamp.getUTCHours() << 11) |
    (timestamp.getUTCMinutes() << 5) |
    (Math.floor(timestamp.getUTCSeconds() / 2) & 0x1f);

  const date =
    ((year - DOS_EPOCH_YEAR) << 9) | ((timestamp.getUTCMonth() + 1) << 5) | timestamp.getUTCDate();

  return { time, date };
}

/** Escribe `value` como `uint16` little-endian en `target[offset]`. */
function writeUint16(target: Uint8Array, offset: number, value: number): void {
  target[offset] = value & 0xff;
  target[offset + 1] = (value >>> 8) & 0xff;
}

/** Escribe `value` como `uint32` little-endian en `target[offset]`. */
function writeUint32(target: Uint8Array, offset: number, value: number): void {
  target[offset] = value & 0xff;
  target[offset + 1] = (value >>> 8) & 0xff;
  target[offset + 2] = (value >>> 16) & 0xff;
  target[offset + 3] = (value >>> 24) & 0xff;
}

/**
 * Construye el ZIP con las entradas dadas, en el orden en que llegan.
 *
 * Las tres partes del formato se escriben de una vez y en orden: las cabeceras locales
 * con su contenido, el directorio central —que repite los datos de cada entrada y
 * añade su desplazamiento— y el EOCD, que dice cuántas entradas hay y dónde empieza el
 * directorio. Sin *data descriptor*: el CRC y los tamaños ya se conocen, así que van en
 * la cabecera local y el lector no tiene que buscar una firma después del contenido.
 *
 * Los límites del formato se comprueban y no se recortan en silencio: un número de
 * entradas o un tamaño que no cabe en 32 bits daría un archivo que ninguna herramienta
 * abriría, y es mejor que eso falle aquí, donde el mensaje dice por qué.
 */
// El tipo lleva `ArrayBuffer` explícito para que quien lo devuelva a `Response` pueda
// pasarlo como `BodyInit`: un `Uint8Array` sobre memoria compartida no vale ahí.
export function buildZip(entries: readonly ZipEntry[], timestamp: Date): Uint8Array<ArrayBuffer> {
  if (entries.length > MAX_UINT16) {
    throw new RangeError(`Un ZIP sin ZIP64 no puede llevar más de ${MAX_UINT16} entradas`);
  }

  const encoder = new TextEncoder();
  const { time, date } = dosTimestamp(timestamp);

  const prepared = entries.map((entry) => {
    const name = encoder.encode(entry.name);

    if (name.length > MAX_UINT16 || entry.bytes.length > MAX_UINT32) {
      throw new RangeError(`La entrada "${entry.name}" no cabe en un ZIP sin ZIP64`);
    }

    return {
      name,
      bytes: entry.bytes,
      crc: crc32(entry.bytes),
    };
  });

  const localSize = prepared.reduce(
    (total, entry) => total + 30 + entry.name.length + entry.bytes.length,
    0,
  );
  const centralSize = prepared.reduce((total, entry) => total + 46 + entry.name.length, 0);

  const output = new Uint8Array(localSize + centralSize + 22);
  let offset = 0;

  // Los desplazamientos del directorio central se apuntan mientras se escriben las
  // cabeceras locales: al directorio hay que repetírselos.
  const offsets: number[] = [];

  for (const entry of prepared) {
    offsets.push(offset);

    writeUint32(output, offset, LOCAL_HEADER_SIGNATURE);
    writeUint16(output, offset + 4, VERSION_NEEDED);
    writeUint16(output, offset + 6, UTF8_NAME_FLAG);
    writeUint16(output, offset + 8, STORE_METHOD);
    writeUint16(output, offset + 10, time);
    writeUint16(output, offset + 12, date);
    writeUint32(output, offset + 14, entry.crc);
    writeUint32(output, offset + 18, entry.bytes.length);
    writeUint32(output, offset + 22, entry.bytes.length);
    writeUint16(output, offset + 26, entry.name.length);
    writeUint16(output, offset + 28, 0);

    output.set(entry.name, offset + 30);
    output.set(entry.bytes, offset + 30 + entry.name.length);

    offset += 30 + entry.name.length + entry.bytes.length;
  }

  const centralStart = offset;

  for (const [index, entry] of prepared.entries()) {
    writeUint32(output, offset, CENTRAL_HEADER_SIGNATURE);
    writeUint16(output, offset + 4, VERSION_NEEDED);
    writeUint16(output, offset + 6, VERSION_NEEDED);
    writeUint16(output, offset + 8, UTF8_NAME_FLAG);
    writeUint16(output, offset + 10, STORE_METHOD);
    writeUint16(output, offset + 12, time);
    writeUint16(output, offset + 14, date);
    writeUint32(output, offset + 16, entry.crc);
    writeUint32(output, offset + 20, entry.bytes.length);
    writeUint32(output, offset + 24, entry.bytes.length);
    writeUint16(output, offset + 28, entry.name.length);
    // Extra, comentario, número de disco, atributos internos y externos: todo a cero,
    // porque este ZIP no usa ninguna de esas extensiones.
    writeUint16(output, offset + 30, 0);
    writeUint16(output, offset + 32, 0);
    writeUint16(output, offset + 34, 0);
    writeUint16(output, offset + 36, 0);
    writeUint32(output, offset + 38, 0);
    writeUint32(output, offset + 42, offsets[index] as number);

    output.set(entry.name, offset + 46);

    offset += 46 + entry.name.length;
  }

  writeUint32(output, offset, END_OF_CENTRAL_DIRECTORY_SIGNATURE);
  writeUint16(output, offset + 4, 0);
  writeUint16(output, offset + 6, 0);
  writeUint16(output, offset + 8, prepared.length);
  writeUint16(output, offset + 10, prepared.length);
  writeUint32(output, offset + 12, centralSize);
  writeUint32(output, offset + 16, centralStart);
  writeUint16(output, offset + 20, 0);

  return output;
}
