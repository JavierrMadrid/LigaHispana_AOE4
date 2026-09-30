import Image from "next/image";
import Link from "next/link";
import { AdminTabs } from "@/app/admin/admin-tabs";
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
          <Link
            href="/admin"
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
              Liga Hispana · Admin
            </span>
          </Link>
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

        {/* Las cuatro pestañas van en su propia fila: con los nombres completos no
            caben junto a la marca y el cierre de sesión. En móvil se desplazan en
            horizontal en lugar de partirse. */}
        <div className="mx-auto w-full max-w-5xl px-4">
          <AdminTabs />
        </div>
      </header>

      {/* El relleno inferior deja libre la esquina que ocupa `BackToTop`. */}
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 pt-8 pb-20">{children}</main>
    </div>
  );
}
