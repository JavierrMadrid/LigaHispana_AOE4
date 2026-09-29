import Link from "next/link";
import { requireAdmin } from "@/lib/auth";
import { logout } from "@/app/login/actions";

export default async function AdminLayout({
  children,
}: LayoutProps<"/admin">) {
  const user = await requireAdmin();

  return (
    <div className="flex min-h-full flex-col">
      <header className="thread-bottom relative border-b border-line bg-surface">
        <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center gap-4 px-4 py-3">
          <span className="font-display text-base font-semibold text-foreground">
            Liga Hispana · Admin
          </span>
          <nav className="flex items-center gap-4 text-sm">
            <Link
              href="/admin"
              className="-my-2 py-2 text-muted transition-colors hover:text-foreground"
            >
              Resumen
            </Link>
            <Link
              href="/admin/jugadores"
              className="-my-2 py-2 text-muted transition-colors hover:text-foreground"
            >
              Jugadores
            </Link>
          </nav>
          {/* El correo puede ser largo y no tiene por qué partirse: en móvil se
              recorta y se lee entero en el `title`, en vez de empujar la barra. */}
          <div className="ml-auto flex min-w-0 items-center gap-3 text-sm text-muted">
            <span className="max-w-[10rem] truncate sm:max-w-none" title={user.email}>
              {user.email}
            </span>
            <form action={logout}>
              <button
                type="submit"
                className="h-10 rounded-md border border-line px-3 transition-colors hover:border-line-strong hover:text-foreground"
              >
                Salir
              </button>
            </form>
          </div>
        </div>
      </header>

      {/* El relleno inferior deja libre la esquina que ocupa `BackToTop`. */}
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 pt-8 pb-20">{children}</main>
    </div>
  );
}
