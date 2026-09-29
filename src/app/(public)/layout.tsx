import Image from "next/image";
import Link from "next/link";
import { ParticipateCta } from "@/components/participate-cta";
import { SiteFooter } from "@/components/site-footer";
import { SiteNav } from "@/components/site-nav";

export default function PublicLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-full flex-col">
      <a
        href="#contenido"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-30 focus:bg-accent focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:text-accent-ink"
      >
        Saltar al contenido
      </a>

      <header className="thread-bottom relative sticky top-0 z-20 border-b border-line bg-background/95 backdrop-blur">
        {/* La cabecera es más ancha que `main` (`max-w-6xl`) a propósito: así el
            emblema y el CTA sobresalen de la columna donde empieza y acaba el
            contenido, mientras la navegación sigue centrada respecto a la página.
            La rejilla de tres columnas (`1fr auto 1fr`) es la que sostiene ese
            centrado: las dos laterales reparten el mismo ancho, así que el ancho
            de la marca no desplaza la nav. Esa fila necesita el ancho completo
            del contenedor (1248 px), de ahí que se active en `xl` y no en `lg`:
            por debajo, marca y CTA comparten la primera fila y la navegación baja
            a la segunda, a ancho completo, sin que el wordmark se recorte. */}
        <div className="mx-auto grid w-full max-w-[78rem] grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 px-4 py-3 sm:gap-x-4 sm:px-6 xl:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] xl:gap-x-6 xl:gap-y-0">
          <Link
            href="/"
            className="col-start-1 row-start-1 inline-flex min-w-0 items-center gap-2 transition-colors hover:text-accent sm:gap-3"
          >
            {/* El emblema es decorativo: el nombre accesible del enlace lo da el
                wordmark, que ya está a la vista y es texto real. El wordmark va
                en un solo color heredado para que sea una unidad clicable, sin
                que una parte parezca una etiqueta aparte. `width`/`height` van
                al tamaño pintado: de ahí salen los candidatos 1x y 2x del
                `srcset`, y así el doble tampoco se amplía. */}
            <Image
              src="/imagenes/marca/emblema-256.png"
              alt=""
              width={48}
              height={48}
              priority
              className="size-10 shrink-0 sm:size-12"
            />
            {/* Con tres bloques en la misma fila, en un móvil muy estrecho los
                laterales se reparten el ancho que sobra: el wordmark cede con
                puntos suspensivos antes que empujar la navegación fuera de su
                columna. */}
            <span className="min-w-0 truncate font-display text-sm font-semibold sm:text-base">
              Liga Hispana AoE IV
            </span>
          </Link>

          <div className="col-start-2 row-start-1 flex justify-self-end xl:col-start-3 xl:self-stretch">
            <ParticipateCta />
          </div>

          {/* `min-w-0`: sin él, el ancho mínimo de la lista de navegación (con
              enlaces que no se parten) empujaría la rejilla y abriría scroll de
              página en lugar de desplazarse solo la barra. */}
          <div className="col-span-2 row-start-2 min-w-0 w-full xl:col-span-1 xl:col-start-2 xl:row-start-1 xl:w-auto">
            <SiteNav />
          </div>
        </div>
      </header>

      <main
        id="contenido"
        className="mx-auto w-full max-w-6xl flex-1 px-4 py-10 sm:px-6 sm:py-14"
      >
        {children}
      </main>

      <SiteFooter />
    </div>
  );
}