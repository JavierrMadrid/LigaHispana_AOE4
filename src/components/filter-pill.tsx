import type { ReactNode } from "react";
import { KickIcon } from "@/components/kick-icon";
import { TwitchIcon } from "@/components/twitch-icon";
import { YoutubeIcon } from "@/components/youtube-icon";

/**
 * La píldora de filtro de la casa: control de estado con `aria-pressed`.
 *
 * Vive aquí y no en cada barra porque las dos barras del sitio que filtran
 * (clasificación y partidas en juego) montan el mismo control: alto de 40, radio
 * completo, filete de 1px y un relleno que solo cambia con el estado. Qué color
 * tiene puesta lo decide quien la usa con `activeClass` —cada eje tiene el suyo—
 * y `mark` es la marca opcional a la izquierda del texto, que hereda el color de
 * la píldora.
 */
export function FilterPill({
  active,
  onClick,
  activeClass,
  mark,
  children,
}: {
  active: boolean;
  onClick: () => void;
  /** Filete, relleno y tinta de la píldora cuando está puesta. */
  activeClass: string;
  /** Marca a la izquierda del texto; sin ella, el texto va solo. */
  mark?: ReactNode;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`inline-flex h-10 items-center gap-2 rounded-full border px-3 text-xs font-semibold active:translate-y-px transition-colors ${
        active
          ? activeClass
          : "border-line bg-surface text-muted hover:bg-surface-raised hover:text-foreground"
      }`}
    >
      {mark === undefined ? null : (
        <span aria-hidden="true" className="flex h-3.5 shrink-0 items-center justify-center">
          {mark}
        </span>
      )}
      {children}
    </button>
  );
}

/**
 * El filtro "En directo", con los tres glifos de plataforma como marca.
 *
 * La marca son los **tres** iconos y no solo el de Twitch: un directo puede estar
 * en cualquiera de las tres plataformas, y un icono único diría que solo se busca
 * en esa. Es el mismo botón en la clasificación y en las partidas en juego, así
 * que vive aquí una sola vez: entre pantallas cambia qué filtra, no el control.
 */
export function LiveFilterPill({
  active,
  onToggle,
}: {
  active: boolean;
  onToggle: (value: boolean) => void;
}) {
  return (
    <FilterPill
      active={active}
      onClick={() => onToggle(!active)}
      activeClass="border-live/50 bg-live/10 text-live-soft"
      mark={
        <span className="flex items-center gap-0.5">
          <TwitchIcon className={`size-3 ${active ? "text-twitch" : "text-muted/60"}`} />
          <YoutubeIcon className={`size-3 ${active ? "text-youtube" : "text-muted/60"}`} />
          <KickIcon className={`size-3 ${active ? "text-kick" : "text-muted/60"}`} />
        </span>
      }
    >
      En directo
    </FilterPill>
  );
}
