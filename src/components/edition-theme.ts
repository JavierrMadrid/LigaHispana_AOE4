import type { CSSProperties } from "react";

/**
 * El color de acento de la edición, traducido a los tokens de acento del sitio.
 *
 * La organización configura un solo color (`branding.accentColor`, `#rrggbb`) y
 * de ahí salen los tokens que la cara pública usa para el acento:
 *
 * | Token | De dónde sale |
 * |---|---|
 * | `--accent` | el color tal cual, en minúsculas |
 * | `--accent-strong` | el mismo aclarado, que es el `:hover` de los controles |
 * | `--accent-ink` | el texto que va **encima** del acento, elegido por contraste |
 * | `--thread` | el hilo del chrome, el acento al 30 % |
 *
 * `--thread` entra aquí aunque su valor se declare a partir de `--accent` en
 * `globals.css`: las variables CSS se sustituyen **donde se declaran**, así que
 * la copia de `:root` no sigue a un acento sobrescrito en un descendiente y hay
 * que recalcularla. `accent-color` y `caret-color` (los controles nativos y el
 * cursor de texto, que `globals.css` fija en `html`) se aplican por lo mismo.
 *
 * El resto de la paleta no se mueve: la edición cambia el oro, no el tema.
 *
 * ## Por qué `--accent-ink` se elige y no se fija
 *
 * El acento se pinta de fondo (`bg-accent`) con texto encima (`text-accent-ink`)
 * en botones, en la selección y en el `::selection` del navegador. Con un color
 * que pone la organización, la tinta oscura de la casa (`#1a1408`) no siempre
 * vale: sobre un acento oscuro no se leería. Aquí se calcula la luminancia
 * relativa (WCAG) y se elige, de las dos tintas del sitio, la que da más
 * contraste. En los tonos claros —que es lo que pide un acento sobre este fondo
 * oscuro— gana la oscura y el resultado coincide con el token de siempre.
 *
 * Se devuelve `undefined` sin color o con un valor que no es `#rrggbb`: quien
 * pinta no aplica estilo ninguno y los tokens actuales se quedan como están.
 */

/** Forma exacta de un color: `#rrggbb`, en cualquier caja. */
const HEX_COLOR = /^#[0-9a-f]{6}$/i;

/** Las dos tintas del sitio, las que ya usan `--accent-ink` y `--foreground`. */
const DARK_INK = "#1a1408";
const LIGHT_INK = "#e9e3d5";

/** Cuánto se aclara el acento para el estado de `:hover`. */
const STRONG_LIGHTEN = 0.2;

/** Los tres canales de un `#rrggbb`, como números 0-255. */
function channels(hex: string): [number, number, number] {
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
}

/** Un canal de color de sRGB (0-255) a la escala lineal de la luminancia. */
function linearize(channel: number): number {
  const value = channel / 255;

  return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

/** Luminancia relativa (WCAG 2.x) de un `#rrggbb`, entre 0 y 1. */
function relativeLuminance(hex: string): number {
  const [r, g, b] = channels(hex).map(linearize);

  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Razón de contraste WCAG entre dos luminancias relativas. */
function contrastRatio(a: number, b: number): number {
  const [light, dark] = a >= b ? [a, b] : [b, a];

  return (light + 0.05) / (dark + 0.05);
}

/** El color aclarado hacia el blanco, para el `:hover`. */
function lighten(hex: string, amount: number): string {
  const [r, g, b] = channels(hex).map((channel) => Math.round(channel + (255 - channel) * amount));
  const two = (value: number): string => value.toString(16).padStart(2, "0");

  return `#${two(r)}${two(g)}${two(b)}`;
}

export function accentTheme(accentColor: string | null): CSSProperties | undefined {
  if (accentColor === null || !HEX_COLOR.test(accentColor)) {
    return undefined;
  }

  const accent = accentColor.toLowerCase();
  const luminance = relativeLuminance(accent);
  const ink =
    contrastRatio(luminance, relativeLuminance(DARK_INK)) >=
    contrastRatio(luminance, relativeLuminance(LIGHT_INK))
      ? DARK_INK
      : LIGHT_INK;
  const strong = lighten(accent, STRONG_LIGHTEN);

  return {
    "--accent": accent,
    "--accent-strong": strong,
    "--accent-ink": ink,
    "--thread": `color-mix(in oklab, ${accent} 30%, transparent)`,
    accentColor: accent,
    caretColor: strong,
  } as CSSProperties;
}
