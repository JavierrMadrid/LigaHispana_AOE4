import Image from "next/image";
import Link from "next/link";
import { AdminAccess } from "@/components/admin-access";
import { DonationBanner } from "@/components/donation-banner";
import { accentTheme } from "@/components/edition-theme";
import { ParticipateCta } from "@/components/participate-cta";
import { SiteFooter } from "@/components/site-footer";
import { SiteNav, SiteTabBar } from "@/components/site-nav";
import { SponsorBanner } from "@/components/sponsor-banner";
import { getEditionConfig, getMatcherinoDonations } from "@/lib/public";

export default async function PublicLayout({
  children,
  modal,
}: {
  children: React.ReactNode;
  modal: React.ReactNode;
}) {
  // Dos lecturas ligeras de `Setting`, las dos envueltas en `cache()` por si otra
  // pieza de la misma petición las necesita. Con la base caída llega `"degraded"`:
  // el banner de donaciones no se pinta, porque un aviso de base caída en todas las
  // páginas públicas sería ruido y "no hay campaña publicada" deja la misma página;
  // y la marca de la edición no se aplica, así que el sitio se queda con su nombre,
  // su emblema y su oro en vez de inventarse los de la edición.
  const [donationsRead, editionRead] = await Promise.all([
    getMatcherinoDonations(),
    getEditionConfig(),
  ]);

  const edition = editionRead.status === "ok" ? editionRead.data : null;
  const editionName = edition?.name ?? null;
  const editionEmblem = edition?.branding.emblemUrl ?? null;
  // El color de la edición se aplica como variables CSS en el subárbol público
  // (cabecera, contenido, pie y ventana modal, que cuelga de aquí). El panel de
  // administración vive fuera de este layout y no se retinta.
  const accentStyle = accentTheme(edition?.branding.accentColor ?? null);

  return (
    // El relleno inferior deja libre la franja que ocupa `SiteTabBar` en móvil:
    // la barra es fija y, sin él, taparía el último tramo del pie. Desde `sm` la
    // barra no existe y el relleno sobra.
    <div
      style={accentStyle}
      className="flex min-h-full flex-col pb-[calc(3.5rem+env(safe-area-inset-bottom))] sm:pb-0"
    >
      <a
        href="#contenido"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-30 focus:bg-accent focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:text-accent-ink"
      >
        Saltar al contenido
      </a>

      {/* El banner va antes de la cabecera y **fuera de su `sticky`**, en el flujo
          normal: así la cabecera (`sticky top-0 z-20`) se pega al borde superior al
          desplazar y el banner, que ya ha subido, no queda debajo ni la tapa. Debajo
          de la cabecera se leería a medias durante el desplazamiento. Solo se pinta
          cuando la lectura fue `"ok"`; el propio componente devuelve `null` si la
          campaña está apagada. */}
      {donationsRead.status === "ok" ? (
        <DonationBanner donations={donationsRead.data} />
      ) : null}

      <header className="thread-bottom relative sticky top-0 z-20 border-b border-line bg-background/95 backdrop-blur">
        {/* La cabecera es más ancha que `main` (`max-w-[80rem]`) a propósito: así el
            emblema y las acciones sobresalen de la columna donde empieza y acaba
            el contenido.
            La fila única (marca, navegación centrada y acciones, las tres al mismo
            alto) se enciende en `2xl` (1536 px) y no antes, porque es donde se
            cruzan las dos cuentas que la gobiernan. La del ancho: con los cinco
            títulos completos la nav pide de 702 a 719 px —el destino activo va en
            negrita y ensancha su etiqueta—, la marca 234 (48 del emblema, 12 del
            hueco y 174 del wordmark) y la celda de acciones 291 (243 de controles
            más los 48 px que le reserva al estandarte). Las dos columnas laterales
            se reparten lo que queda por igual —es lo que mantiene la nav en el
            centro de la página—: (1328 − 707 − 24) / 2 = 298 px para cada una, donde
            707 es lo que ocupa la celda de la nav (la lista más ancha, 719, menos
            los 12 px que le come el `-mx-1.5` de `SiteNav`), así que esa columna es
            la estrecha de las tres. La marca entra en ella con 64 px de sobra y la
            celda de acciones con 7 —poco, pero es margen—, y ninguna de las dos
            depende del destino activo, que solo mueve el ancho de la lista. Esa
            cuenta valdría desde algo antes de 1536; la que manda es la segunda: para
            ganar ese ancho la reserva del estandarte se encoge aquí de 96 a 48 px, y con 48 el paño —que cuelga a
            `right = 25% − 20rem`— deja 20 px de aire a los controles en 1536, que es
            el mínimo que se acepta, y más a partir de ahí: 28 a 1568, 36 a 1600 y
            116 a 1920, porque la ventana crece más deprisa que el contenedor, que ya
            está en su máximo. Por debajo, la nav no comparte fila: marca y acciones
            ocupan la primera, con la reserva ancha de siempre, y la navegación baja
            a la segunda, a ancho completo y centrada en ella —el centrado lo detalla
            `SiteNav`—. En móvil (`< sm`) esa segunda fila desaparece: los cinco
            destinos bajan a `SiteTabBar`, la barra fija del pie, y la cabecera se
            queda en una sola fila compacta.
            En la celda de la derecha viven las dos acciones de la barra —la
            inscripción y el acceso de la organización—. Son cromo: cada una tiene
            su alto propio, su radio de control y ningún protagónico, para no
            competir con el contenido. La jerarquía la declara el color y no la
            forma: el oro se queda para la inscripción y el acceso se pinta con un
            filete neutro (el porqué, en su componente). El contenedor las centra
            con `items-center` y las separa con el `gap-2` de entre controles; en
            `2xl` la celda se estira para que el centrado sea el de la fila, y desde
            `md` le reserva el ancho al estandarte del patrocinador, que cuelga por
            fuera para no tapar ningún control (los números, en su componente).
            De la cabecera cuelga, además, el estandarte del patrocinador: entra
            desde el borde superior de la ventana (por eso se le ve cortado arriba),
            remata por debajo de la barra y va anclado y fuera de la rejilla, así
            que no ocupa columna ni mueve la navegación. */}
        <div className="mx-auto grid w-full max-w-[86rem] grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 px-4 py-2 sm:gap-x-4 sm:px-6 sm:py-3 2xl:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] 2xl:gap-x-3 2xl:gap-y-0">
          <Link
            href="/"
            className="col-start-1 row-start-1 inline-flex min-w-0 items-center gap-2 transition-colors hover:text-accent sm:gap-3"
          >
            {/* El emblema es decorativo: el nombre accesible del enlace lo da el
                wordmark, que ya está a la vista y es texto real. El wordmark va
                en un solo color heredado para que sea una unidad clicable, sin
                que una parte parezca una etiqueta aparte. `width`/`height` van
                al tamaño pintado: de ahí salen los candidatos 1x y 2x del
                `srcset`, y así el doble tampoco se amplía.
                Con emblema de la edición se pinta ese; si no, el de la casa. Va
                `unoptimized` porque la URL la escribe la organización y puede ser
                externa: optimizarla exigiría declarar su host en
                `images.remotePatterns` (`next.config.ts`), y el emblema es un
                fichero pequeño que no gana nada con el optimizador. */}
            {editionEmblem !== null ? (
              <Image
                src={editionEmblem}
                alt=""
                width={48}
                height={48}
                priority
                unoptimized
                className="size-10 shrink-0 sm:size-12"
              />
            ) : (
              <Image
                src="/imagenes/marca/emblema-256.png"
                alt=""
                width={48}
                height={48}
                priority
                className="size-10 shrink-0 sm:size-12"
              />
            )}
            {/* Con varios bloques en la misma fila, los laterales se reparten el
                ancho que sobra y el wordmark es el que cede: se recorta con puntos
                suspensivos antes que empujar la navegación fuera de su columna. Es
                lo que pasa en un móvil muy estrecho y, en la fila única de `2xl`,
                con los nombres de edición más largos que el de la casa (que pide
                174 px y tiene columna de 298). */}
            <span className="min-w-0 truncate font-display text-sm font-semibold sm:text-base">
              {editionName ?? "Liga Hispana AoE IV"}
            </span>
          </Link>

          <div className="col-start-2 row-start-1 flex items-center gap-2 justify-self-end md:pr-24 2xl:col-start-3 2xl:self-stretch 2xl:pr-12">
            <ParticipateCta />
            <AdminAccess />
          </div>

          {/* `min-w-0`: sin él, el ancho mínimo de la lista de navegación (con
              enlaces que no se parten) empujaría la rejilla y abriría scroll de
              página en lugar de desplazarse solo la barra.
              Por debajo de `sm` no se pinta: los cinco destinos no caben sin
              desplazamiento horizontal y ahí navega `SiteTabBar`. La fila queda
              vacía y la rejilla se cierra en una sola altura.
              De `2xl` en adelante la fila es la única de la cabecera: la celda pasa
              a la columna central (`w-auto`, que es la anchura de la lista) y marca
              y acciones se reparten los dos laterales. */}
          <div className="col-span-2 row-start-2 hidden min-w-0 w-full sm:block 2xl:col-span-1 2xl:col-start-2 2xl:row-start-1 2xl:w-auto">
            <SiteNav />
          </div>
        </div>

        {/* La pieza que cuelga de la cabecera, después de la rejilla y fuera de
            ella: no ocupa columna ni desplaza nada. Se esconde en móvil, donde no
            hay sitio para ella. */}
        <SponsorBanner />
      </header>

      {/* El aire de arriba es más corto que el de abajo a propósito: el primer
          bloque público (la banda de la portada) tiene que quedar pegado a la
          cabecera, y el pie ya respira con su propio relleno. */}
      <main
        id="contenido"
        className="mx-auto w-full max-w-[80rem] flex-1 px-4 pb-10 pt-6 sm:px-6 sm:pb-14 sm:pt-8"
      >
        {children}
      </main>

      <SiteFooter name={editionName} emblemUrl={editionEmblem} />

      {/* La navegación de móvil vive fuera de la cabecera: es una capa fija al
          pie de la ventana, así que no entra en el flujo ni desplaza el
          contenido. Solo se pinta por debajo de `sm`, donde la nav de la
          cabecera no cabe. */}
      <SiteTabBar />

      {/* El slot `@modal` aloja la ventana de acceso interceptada. Va después
          del contenido porque es una capa, pero el `<dialog>` con `showModal()`
          se pinta en el top layer y queda por encima igual. Cerrado no ocupa
          nada: un `<dialog>` sin abrir es `display: none`. */}
      {modal}
    </div>
  );
}