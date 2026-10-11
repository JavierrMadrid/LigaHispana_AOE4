import Image from "next/image";
import Link from "next/link";
import type { Metadata } from "next";
import { SiteFooter } from "@/components/site-footer";

export const metadata: Metadata = {
  title: { absolute: "Página no encontrada · Liga Hispana AoE4" },
};

/**
 * Se declara en la raíz y no dentro de `(public)` porque Next la usa precisamente
 * para las URLs que no coinciden con ninguna ruta, y en ese caso solo hay una
 * layout disponible. Por eso esta pantalla lleva su propio chrome —cabecera
 * compacta y pie— en vez de depender de la navegación del grupo público.
 */
export default function NotFound() {
  return (
    <div className="flex min-h-full flex-col">
      <header className="thread-bottom relative border-b border-line bg-surface">
        <div className="mx-auto flex w-full max-w-[80rem] items-center gap-4 px-4 py-3 sm:px-6">
          <Link
            href="/"
            className="inline-flex min-w-0 items-center gap-2.5 transition-colors hover:text-accent"
          >
            {/* El emblema es decorativo: el nombre accesible del enlace lo da el
                wordmark, que ya está a la vista. */}
            <Image
              src="/imagenes/marca/emblema-256.png"
              alt=""
              width={40}
              height={40}
              className="size-8 shrink-0"
            />
            <span className="truncate font-display text-base font-semibold">
              Liga Hispana AoE IV
            </span>
          </Link>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-[80rem] flex-1 flex-col justify-center px-4 py-24 sm:px-6">
        <p className="font-display text-5xl font-semibold tabular-nums text-muted/30">404</p>

        <h1 className="mt-4 font-display text-2xl font-semibold text-foreground sm:text-3xl">
          Esta página no existe
        </h1>

        <p className="mt-3 max-w-[58ch] leading-relaxed text-muted">
          Puede que el enlace esté mal escrito o que la página haya cambiado de sitio.
          Desde la portada puedes volver a la clasificación.
        </p>

        <div className="mt-8 flex flex-wrap gap-x-8 gap-y-3 text-sm">
          <Link
            href="/"
            className="text-accent underline underline-offset-4 hover:text-accent-strong"
          >
            Ir a la clasificación
          </Link>
          <Link href="/partidas" className="text-muted transition-colors hover:text-accent">
            Partidas en juego
          </Link>
          <Link href="/reglas" className="text-muted transition-colors hover:text-accent">
            Reglas
          </Link>
        </div>
      </main>

      <SiteFooter />
    </div>
  );
}
