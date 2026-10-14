import Image from "next/image";
import { SPONSOR_NAME, SponsorLogo } from "@/components/sponsor";

type SiteFooterProps = {
  /**
   * Nombre de la edición activa (`EditionConfig.name`), o `null` si la
   * configuración no se ha podido leer: en ese caso el pie se queda con el nombre
   * de la casa en vez de inventarse uno.
   */
  name: string | null;
  /** Emblema de la edición (`branding.emblemUrl`), o `null` para el de la casa. */
  emblemUrl: string | null;
};

export function SiteFooter({ name, emblemUrl }: SiteFooterProps) {
  return (
    <footer className="thread-top relative border-t border-line bg-surface/40">
      <div className="mx-auto flex w-full max-w-[80rem] flex-col gap-10 px-4 py-10 sm:px-6 md:flex-row md:items-start md:justify-between">
        <div className="max-w-sm">
          <div className="flex items-center gap-3">
            {/* Decorativo: el nombre completo va justo al lado como texto. El
                emblema del pie se queda un escalón por debajo del de la
                cabecera; la caja intrínseca coincide con el tamaño pintado
                para que el candidato 2x del `srcset` no se amplíe.
                Con emblema de la edición se pinta ese, `unoptimized` porque la
                URL puede ser externa y no está declarada en
                `images.remotePatterns` (el porqué, en la cabecera pública). */}
            {emblemUrl !== null ? (
              <Image
                src={emblemUrl}
                alt=""
                width={44}
                height={44}
                unoptimized
                className="size-11 shrink-0"
              />
            ) : (
              <Image
                src="/imagenes/marca/emblema-128.png"
                alt=""
                width={44}
                height={44}
                className="size-11 shrink-0"
              />
            )}
            <p className="font-display text-lg font-semibold text-foreground">
              {name ?? "Liga Hispana de Age of Empires IV"}
            </p>
          </div>
          <p className="mt-2 text-sm leading-relaxed text-muted">
            Competición no oficial organizada por y para la comunidad hispanohablante de Age of Empires IV.
            Consulta las reglas del torneo en la sección de reglas.
          </p>
        </div>

        {/* Agradecimiento al patrocinador, donde antes colgaba el índice de
            enlaces del pie. Se queda a la derecha para conservar el reparto del
            pie en dos bloques desde `md` —la liga a la izquierda, quien la
            sostiene a la derecha— y se lee como una insignia: el escudo preside
            y el nombre lo firma debajo. Sin filete ni relleno: un agradecimiento
            se lee, no se pulsa.
            El `-mb-6` del escudo cancela el margen transparente que el PNG trae
            de fábrica por abajo, para que el nombre quede pegado a la insignia y
            no flote a media distancia. */}
        <div className="flex flex-col items-center gap-1 md:shrink-0">
          <p className="text-xs font-medium uppercase tracking-wide text-muted">
            Patrocinadores:
          </p>
          <SponsorLogo size={128} className="-mb-6" />
          <p className="font-display text-base font-semibold text-foreground">
            {SPONSOR_NAME}
          </p>
        </div>
      </div>

      {/* El relleno inferior deja libre la esquina que ocupa `BackToTop`. */}
      <div className="mx-auto w-full max-w-[80rem] px-4 pb-20 sm:px-6">
        <p className="border-t border-line pt-6 text-xs leading-relaxed text-muted">
          Perfiles y resultados de partidas obtenidos de AoE4World. La
          clasificación se recalcula cada pocos minutos a medida que la API publica
          los resultados.
        </p>
      </div>
    </footer>
  );
}