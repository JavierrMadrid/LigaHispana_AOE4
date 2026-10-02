import { countryFlagUrl } from "@/lib/flag";

type CountryFlagProps = {
  /** Rótulo canónico del país (`StandingRow.country`); `null` = no se pinta nada. */
  country: string | null;
};

/**
 * Bandera del país de un jugador, junto a su avatar.
 *
 * Es decorativa junto al nombre, pero el país **no** se lee en ningún otro texto
 * de la fila: la bandera es la única señal visual. Por eso el `alt` lleva el
 * nombre del país y no `""`: `alt=""` dejaría la información encerrada en la
 * imagen y quien use un lector de pantalla no recibiría el dato.
 *
 * Con `country` a `null` no se pinta nada en absoluto: ni un cuadro vacío ni una
 * bandera por defecto. "No lo sabemos" se ve como un hueco que no existe, no como
 * un país inventado.
 *
 * La imagen se sirve con `<img>` plano, igual que `PlayerAvatar`, y no con
 * `next/image`, que exigiría declarar el host remoto (`flagcdn.com`) en
 * `next.config.ts` para una bandera de 40 px.
 */
export function CountryFlag({ country }: CountryFlagProps) {
  if (country === null) {
    return null;
  }

  const src = countryFlagUrl(country);

  if (src === null) {
    return null;
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element -- la bandera viene del CDN de flagcdn.com; next/image exigiría declarar el host remoto en `next.config.ts`.
    <img
      src={src}
      alt={country}
      width={20}
      height={15}
      loading="lazy"
      decoding="async"
      className="h-3.5 w-5 shrink-0 rounded-xs border border-line object-cover"
    />
  );
}
