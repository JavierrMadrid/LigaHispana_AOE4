import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import sharp, { type OverlayOptions } from "sharp";

/**
 * Derivar los recursos de marca de la Liga Hispana a partir de los originales.
 *
 *   npm run brand:assets
 *
 * Los originales viven en `public/imagenes/logos/` y son la fuente de verdad:
 * `logo sin fondo.jfif` (monograma H dorado dentro de un anillo, icono de la
 * app) y `logo_avanzado.png` (ilustración, imagen para compartir). Este script
 * no los toca; solo escribe las copias donde las esperan las convenciones de
 * Next (`src/app/`) y la interfaz (`public/imagenes/marca/`).
 *
 * Hay que volver a ejecutarlo solo si cambian los originales o la composición
 * de la tarjeta para compartir.
 */

const ROOT = process.cwd();
const ORIGINALS = path.join(ROOT, "public", "imagenes", "logos");
const EMBLEM = path.join(ORIGINALS, "logo sin fondo.jfif");
const ART = path.join(ORIGINALS, "logo_avanzado.png");

const APP = path.join(ROOT, "src", "app");
const BRAND = path.join(ROOT, "public", "imagenes", "marca");

// Pizarra del tema (`--background`), para que la ilustración se funda con la
// página en la tarjeta de compartir.
const BACKGROUND = { r: 11, g: 13, b: 16 };

const GOLD = "#c9a45c";
const IVORY = "#e9e3d5";
const MUTED = "#98a0aa";

type Rgb = { r: number; g: number; b: number };

type RawInfo = { width: number; height: number; channels: number };

/** Saturación normalizada (0 a 1): separa el oro del fondo claro y neutro. */
function saturation(r: number, g: number, b: number): number {
  return (Math.max(r, g, b) - Math.min(r, g, b)) / 255;
}

/** El emblema es un JPEG sin canal alfa: el fondo claro viene pintado. */
async function readEmblem() {
  return sharp(EMBLEM)
    .toColourspace("srgb")
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
}

/** Fondo del original: media de las cuatro esquinas, donde no hay monograma. */
function sampleBackdrop(data: Buffer, info: RawInfo): Rgb {
  const patchX = Math.max(1, Math.round(info.width * 0.04));
  const patchY = Math.max(1, Math.round(info.height * 0.04));
  const corners: [number, number][] = [
    [0, 0],
    [info.width - patchX, 0],
    [0, info.height - patchY],
    [info.width - patchX, info.height - patchY],
  ];

  let r = 0;
  let g = 0;
  let b = 0;
  let count = 0;

  for (const [originX, originY] of corners) {
    for (let y = originY; y < originY + patchY; y += 1) {
      for (let x = originX; x < originX + patchX; x += 1) {
        const index = (y * info.width + x) * info.channels;
        r += data[index];
        g += data[index + 1];
        b += data[index + 2];
        count += 1;
      }
    }
  }

  return { r: r / count, g: g / count, b: b / count };
}

/**
 * Recorta el emblema y deja el fondo transparente.
 *
 * El original tiene el anillo y el monograma en oro sobre un fondo claro y
 * neutro, así que la opacidad se deduce de la saturación: el oro la tiene alta
 * y el fondo (y su sombra difusa) casi nula. La separación se hace a resolución
 * nativa y el resultado premultiplicado se reduce por media de área, de modo
 * que el borde tome el color del propio oro y no arrastre un halo claro sobre
 * el pizarra oscuro de la web.
 */
async function cutoutEmblem(size: number): Promise<Buffer> {
  const { data, info } = await readEmblem();
  const { width, height, channels } = info;

  const backdrop = sampleBackdrop(data, info);
  const threshold = Math.min(
    0.2,
    Math.max(0.12, saturation(backdrop.r, backdrop.g, backdrop.b) + 0.09),
  );

  const colour = Buffer.alloc(width * height * 3);
  const alpha = Buffer.alloc(width * height);

  for (let index = 0, pixel = 0; index < data.length; index += channels, pixel += 1) {
    const r = data[index];
    const g = data[index + 1];
    const b = data[index + 2];
    const opaque = saturation(r, g, b) > threshold;

    alpha[pixel] = opaque ? 255 : 0;
    // Premultiplicado: el fondo no aporta su color al reescalar.
    colour[pixel * 3] = opaque ? r : 0;
    colour[pixel * 3 + 1] = opaque ? g : 0;
    colour[pixel * 3 + 2] = opaque ? b : 0;
  }

  const output = Buffer.alloc(size * size * 4);

  // Reducción por media de área sobre el par premultiplicado (color y opacidad):
  // el borde promedia oro con fondo transparente, así que conserva el color del
  // oro y se une al fondo sin dejar un filo claro.
  for (let row = 0; row < size; row += 1) {
    const firstY = Math.floor((row * height) / size);
    const lastY = Math.max(firstY + 1, Math.floor(((row + 1) * height) / size));

    for (let column = 0; column < size; column += 1) {
      const firstX = Math.floor((column * width) / size);
      const lastX = Math.max(firstX + 1, Math.floor(((column + 1) * width) / size));

      let coverage = 0;
      let r = 0;
      let g = 0;
      let b = 0;
      let count = 0;

      for (let y = firstY; y < lastY; y += 1) {
        for (let x = firstX; x < lastX; x += 1) {
          const pixel = y * width + x;
          coverage += alpha[pixel];
          r += colour[pixel * 3];
          g += colour[pixel * 3 + 1];
          b += colour[pixel * 3 + 2];
          count += 1;
        }
      }

      coverage = Math.round(coverage / count);
      const target = (row * size + column) * 4;

      // Por debajo del ruido del JPEG el píxel es resto de fondo.
      if (coverage < 12) {
        continue;
      }

      // Des-premultiplicar devuelve el oro puro al píxel del borde.
      const restore = 255 / coverage;
      output[target] = Math.min(255, Math.round((r / count) * restore));
      output[target + 1] = Math.min(255, Math.round((g / count) * restore));
      output[target + 2] = Math.min(255, Math.round((b / count) * restore));
      output[target + 3] = coverage;
    }
  }

  return sharp(output, { raw: { width: size, height: size, channels: 4 } }).png().toBuffer();
}

/**
 * El emblema cuadrado sobre el fondo claro del original. iOS no admite
 * transparencia y aplica su propia máscara al icono de la app; en el resto de
 * salidas se entrega el recorte transparente.
 */
async function platedEmblem(size: number): Promise<Buffer> {
  return sharp(EMBLEM).resize(size, size, { fit: "cover" }).removeAlpha().png().toBuffer();
}

/**
 * Ensambla un .ico con varias entradas PNG (formato admitido desde Windows
 * Vista). Sharp no escribe .ico, así que se construye la cabecera a mano.
 */
function buildIco(entries: { size: number; png: Buffer }[]): Buffer {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);

  let offset = 6 + entries.length * 16;
  const directory: Buffer[] = [];

  for (const entry of entries) {
    const directoryEntry = Buffer.alloc(16);
    const dimension = entry.size >= 256 ? 0 : entry.size;
    directoryEntry.writeUInt8(dimension, 0);
    directoryEntry.writeUInt8(dimension, 1);
    directoryEntry.writeUInt8(0, 2);
    directoryEntry.writeUInt8(0, 3);
    directoryEntry.writeUInt16LE(1, 4);
    directoryEntry.writeUInt16LE(32, 6);
    directoryEntry.writeUInt32LE(entry.png.length, 8);
    directoryEntry.writeUInt32LE(offset, 12);
    offset += entry.png.length;
    directory.push(directoryEntry);
  }

  return Buffer.concat([header, ...directory, ...entries.map((entry) => entry.png)]);
}

/** Funde los bordes de la ilustración con el fondo para que no se vea el cuadrado. */
async function fadeEdges(source: string | Buffer, width: number, height: number): Promise<Buffer> {
  const mask = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
      <defs>
        <radialGradient id="fade" cx="50%" cy="50%" r="62%">
          <stop offset="60%" stop-color="#ffffff" stop-opacity="1"/>
          <stop offset="100%" stop-color="#ffffff" stop-opacity="0"/>
        </radialGradient>
      </defs>
      <rect width="${width}" height="${height}" fill="url(#fade)"/>
    </svg>`,
  );

  return sharp(source)
    .ensureAlpha()
    .resize(width, height)
    .composite([{ input: mask, blend: "dest-in" }])
    .png()
    .toBuffer();
}

async function buildIcons(): Promise<void> {
  const entries = await Promise.all(
    [16, 32, 48].map(async (size) => ({ size, png: await cutoutEmblem(size) })),
  );

  await writeFile(path.join(APP, "favicon.ico"), buildIco(entries));
  await writeFile(path.join(APP, "icon.png"), await cutoutEmblem(192));
  // iOS aplica su propia máscara y no admite transparencia: el emblema va
  // cuadrado y opaco, sobre el fondo claro del original.
  await writeFile(path.join(APP, "apple-icon.png"), await platedEmblem(180));
}

async function buildShareImage(): Promise<void> {
  const width = 1200;
  const height = 630;

  const canvas = sharp({
    create: { width, height, channels: 3, background: BACKGROUND },
  });

  const art = await fadeEdges(ART, 560, 560);

  // La tarjeta se rasteriza aquí, así que la fuente queda incrustada en el
  // archivo: si Cinzel no está instalada se usa Georgia y el resultado sigue
  // siendo correcto. No se descarga ninguna fuente en la generación.
  const label = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
      <text x="648" y="252" font-family="Cinzel, Georgia, 'Times New Roman', serif"
        font-size="58" font-weight="600" fill="${GOLD}" letter-spacing="1">LIGA HISPANA</text>
      <text x="648" y="322" font-family="Cinzel, Georgia, 'Times New Roman', serif"
        font-size="34" font-weight="500" fill="${IVORY}">de Age of Empires IV</text>
      <rect x="648" y="358" width="84" height="2" fill="${GOLD}"/>
      <text x="648" y="416" font-family="Georgia, 'Times New Roman', serif"
        font-size="25" fill="${MUTED}">Clasificación y partidas en directo</text>
    </svg>`,
  );

  await canvas
    .composite([
      { input: art, left: 44, top: 35 },
      { input: label, left: 0, top: 0 },
    ])
    .jpeg({ quality: 84, mozjpeg: true, progressive: true })
    .toFile(path.join(APP, "opengraph-image.jpg"));

  await writeFile(
    path.join(APP, "opengraph-image.alt.txt"),
    "Tarjeta de la Liga Hispana de Age of Empires IV con la ilustración del torneo y el nombre de la competición.",
  );
}

/**
 * Dos escalones para la interfaz: la cabecera y el login (48-56 px) usan el
 * grande, y el emblema del pie (44 px) se queda en el pequeño.
 */
async function buildUiVariants(): Promise<void> {
  await writeFile(path.join(BRAND, "emblema-128.png"), await cutoutEmblem(128));
  await writeFile(path.join(BRAND, "emblema-256.png"), await cutoutEmblem(256));
}

/** Diagnóstico: cómo se lee el emblema a tamaño de pestaña y de cabecera. */
async function writeFaviconPreview(directory: string): Promise<void> {
  const sizes = [16, 24, 32, 48];
  const scale = 3;
  const gap = 12;
  const tiles: OverlayOptions[] = [];
  const rows = [cutoutEmblem, platedEmblem];

  let top = gap;

  for (const row of rows) {
    let left = gap;

    for (const size of sizes) {
      const enlarged = await sharp(await row(size))
        .flatten({ background: BACKGROUND })
        .resize(size * scale, size * scale, { kernel: "nearest" })
        .png()
        .toBuffer();

      tiles.push({ input: enlarged, left, top });
      left += size * scale + gap;
    }

    top += sizes[sizes.length - 1] * scale + gap;
  }

  const width = gap + sizes.reduce((total, size) => total + size * scale + gap, 0);

  await sharp({ create: { width, height: top, channels: 4, background: BACKGROUND } })
    .composite(tiles)
    .png()
    .toFile(path.join(directory, "favicon-preview.png"));

  // Segunda tira a tamaño real, para revisar el recorte sin ampliación.
  const strip = 256;
  const stripHeight = gap * 2 + strip;

  await sharp({
    create: {
      width: gap * 4 + 128 + strip + 180,
      height: stripHeight,
      channels: 4,
      background: BACKGROUND,
    },
  })
    .composite([
      { input: await cutoutEmblem(128), left: gap, top: gap + Math.round((strip - 128) / 2) },
      { input: await cutoutEmblem(strip), left: gap * 2 + 128, top: gap },
      {
        input: await platedEmblem(180),
        left: gap * 3 + 128 + strip,
        top: gap + Math.round((strip - 180) / 2),
      },
    ])
    .png()
    .toFile(path.join(directory, "emblem-preview.png"));
}

async function main(): Promise<void> {
  await mkdir(BRAND, { recursive: true });
  await buildIcons();
  await buildShareImage();
  await buildUiVariants();

  const previewDirectory = process.env.BRAND_PREVIEW_DIR;
  if (previewDirectory) {
    await mkdir(previewDirectory, { recursive: true });
    await writeFaviconPreview(previewDirectory);
    console.log(`Vista previa del icono: ${path.join(previewDirectory, "favicon-preview.png")}`);
    console.log(`Vista previa del emblema: ${path.join(previewDirectory, "emblem-preview.png")}`);
  }

  console.log("Recursos de marca generados:");
  console.log("  src/app/favicon.ico (16, 32, 48)");
  console.log("  src/app/icon.png (192x192)");
  console.log("  src/app/apple-icon.png (180x180)");
  console.log("  src/app/opengraph-image.jpg (1200x630)");
  console.log("  public/imagenes/marca/emblema-128.png (128x128)");
  console.log("  public/imagenes/marca/emblema-256.png (256x256)");
}

void main();
