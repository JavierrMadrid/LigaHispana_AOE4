import Link from "next/link";
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

      <header className="sticky top-0 z-20 border-b border-line bg-background/95 backdrop-blur">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-x-8 gap-y-1 px-4 py-3 sm:flex-nowrap sm:px-6">
          <Link
            href="/"
            className="font-display text-base font-semibold text-foreground transition-colors hover:text-accent"
          >
            Liga Hispana <span className="text-accent">AoE IV</span>
          </Link>
          <div className="order-last w-full sm:order-none sm:ml-auto sm:w-auto">
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