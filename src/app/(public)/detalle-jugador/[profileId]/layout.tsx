import { Suspense, type ReactNode } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { EmptyState } from "@/components/empty-state";
import { PageHead } from "@/components/page-head";
import { ParticipantHeader, type ParticipantFigures } from "@/components/participant-header";
import { ParticipantTabs } from "@/components/participant-tabs";
import { readParticipant } from "./data";

// El avance de un jugador sale de la misma foto que la clasificación, que el
// worker recalcula cada pocos minutos. Sin esto el detalle se generaría en el
// `next build` y se quedaría congelado en la foto del despliegue.
export const dynamic = "force-dynamic";

/**
 * Marco del detalle de un participante: la identidad, sus cifras y las pestañas.
 *
 * Es lo que no cambia al pasar de una pestaña a otra —quién es y cómo va, más la
 * navegación entre las dos vistas—, y vive aquí para que las pestañas no lo
 * repitan. Cada pestaña trae lo suyo: sus metadatos, su `h1` y su contenido.
 *
 * El "no existe" y el "no se ha podido leer" se resuelven aquí, porque son de la
 * ficha entera y no de una vista: un `profileId` que no identifica a ningún
 * participante aprobado da 404 en las dos pestañas, y una base que no responde se
 * cuenta una vez, sin pintar pestañas de un jugador del que no se sabe nada.
 *
 * La lectura va dentro de un `Suspense` propio a propósito: el `loading.tsx` de un
 * segmento no cubre al layout de ese mismo segmento, así que sin él la navegación
 * se quedaría esperando a la base sin pintar nada. Así el marco tiene su esqueleto
 * —el contenido de cada pestaña tiene el suyo, en el `loading.tsx` de su nivel—.
 */
export default async function ParticipantDetailLayout({
  children,
  params,
}: LayoutProps<"/detalle-jugador/[profileId]">) {
  const { profileId } = await params;

  return (
    <Suspense fallback={<ParticipantFrameSkeleton />}>
      <ParticipantFrame profileId={profileId}>{children}</ParticipantFrame>
    </Suspense>
  );
}

/**
 * La ficha montada: migas, cabecera, pestañas y el contenido de la pestaña activa.
 *
 * Va aparte del layout porque es la parte que espera a la base. En el caso
 * degradado no se pintan `children`: no hay ficha de la que tirar, así que las
 * pestañas sobrarían. Cuando el jugador no existe, el 404 sustituye el árbol
 * entero.
 *
 * Las migas son dos niveles —la clasificación y el jugador— y no tres: el detalle
 * de un participante cuelga de la tabla, y una miga intermedia solo podría ser él
 * mismo (el `profileId` de esta ruta) o el nombre de la ruta. El catálogo de
 * objetivos y el historial no son padres de esta ficha, están en la navegación del
 * sitio; lo que aquí se elige es la vista, y eso lo dice la barra de pestañas.
 */
async function ParticipantFrame({
  profileId,
  children,
}: {
  profileId: string;
  children: ReactNode;
}) {
  const read = await readParticipant(profileId);

  // Entero positivo o nada: un `profileId` no numérico no identifica a nadie.
  if (read === null) {
    notFound();
  }

  // La base puede no responder (`degraded`), que no es lo mismo que "este
  // jugador no existe" (`ok` con `data: null`, que va a `notFound`). Decir que
  // alguien no existe cuando lo que pasa es que Postgres no contesta sería
  // mentir sobre la persona.
  if (read.status === "degraded") {
    return (
      <div className="flex flex-col gap-8">
        <PageHead title="Detalle del participante" />
        <EmptyState
          title="No se han podido cargar los datos del participante"
          body="La base de datos no ha respondido, así que no se sabe cómo va este participante en los objetivos ni qué puntos ha sumado. No es lo mismo que no existir ni que no haber ganado nada. Vuelve a cargar la página en unos minutos."
          action={
            <nav className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
              <Link
                href="/"
                className="text-accent underline underline-offset-4 hover:text-accent-strong"
              >
                Volver a la clasificación
              </Link>
              <Link
                href="/objetivos"
                className="text-muted transition-colors hover:text-accent"
              >
                Ver todos los objetivos
              </Link>
            </nav>
          }
        />
      </div>
    );
  }

  if (read.data === null) {
    notFound();
  }

  const { player, options } = read.data;

  // Las cifras de la cabecera son del catálogo entero —los carruseles de familia
  // también son objetivos, y sus puntos cuentan—, la misma cuenta que hacía la
  // ficha cuando la cabecera vivía en la pestaña de objetivos.
  const achieved = options.filter((option) => option.achieved);
  const figures: ParticipantFigures = {
    owned: achieved.length,
    total: options.length,
    points: achieved.reduce((total, option) => total + option.points, 0),
    contending: options.filter(
      (option) => !option.achieved && option.position !== null,
    ).length,
  };

  return (
    <div className="flex flex-col gap-8">
      <nav aria-label="Migas de pan" className="min-w-0 text-sm">
        <ol className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <li className="flex min-w-0 items-center gap-x-2">
            <Link href="/" className="text-muted transition-colors hover:text-accent">
              Clasificación
            </Link>
            <span aria-hidden="true" className="text-muted/50">
              /
            </span>
          </li>
          <li className="min-w-0">
            <span aria-current="page" title={player.name} className="block truncate">
              {player.name}
            </span>
          </li>
        </ol>
      </nav>

      <ParticipantHeader player={player} figures={figures} />

      <div className="flex flex-col gap-6">
        <ParticipantTabs profileId={player.profileId} />
        {children}
      </div>
    </div>
  );
}

/**
 * Esqueleto del marco mientras llega la ficha.
 *
 * Reserva la forma del contenido que va a ocuparla —migas, cabecera y carril de
 * pestañas, con las mismas cajas de `surface`/`line`— para que el marco no salte
 * al llegar los datos. Es decorativo y no se anuncia: en el mismo hueco de espera
 * el contenido de la pestaña deja su propio `role="status"`, y dos avisos de carga
 * en la misma pantalla son ruido.
 */
function ParticipantFrameSkeleton() {
  return (
    <div
      aria-hidden="true"
      className="flex animate-pulse flex-col gap-8 motion-reduce:animate-none"
    >
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        <span className="h-4 w-32 rounded bg-surface-raised" />
        <span className="h-4 w-28 rounded bg-surface-raised" />
      </div>

      <div className="thread-top relative overflow-hidden rounded-lg border border-line bg-surface px-5 py-5">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-4">
          <span className="size-16 shrink-0 rounded-md border border-line bg-surface-raised" />
          <div className="flex flex-col gap-2">
            <span className="h-6 w-44 rounded bg-surface-raised" />
            <span className="h-3 w-32 rounded bg-surface-raised" />
          </div>
          <div className="ml-auto flex gap-8">
            <FrameFigure />
            <FrameFigure />
            <FrameFigure />
          </div>
        </div>
      </div>

      <div className="flex w-max items-center gap-1 rounded-full border border-line bg-surface p-1">
        <span className="h-8 w-24 rounded-full bg-surface-raised" />
        <span className="h-8 w-36 rounded-full bg-surface-raised" />
      </div>
    </div>
  );
}

/** Una de las tres cifras de la cabecera, en su caja de espera. */
function FrameFigure() {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="h-5 w-12 rounded bg-surface-raised" />
      <span className="h-3 w-20 rounded bg-surface-raised" />
    </div>
  );
}
