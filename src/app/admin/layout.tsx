import Link from "next/link";
import { requireAdmin } from "@/lib/auth";
import { logout } from "@/app/login/actions";

export default async function AdminLayout({
  children,
}: LayoutProps<"/admin">) {
  const user = await requireAdmin();

  return (
    <div className="flex min-h-full flex-col">
      <header className="border-b border-neutral-800 bg-neutral-950">
        <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center gap-4 px-4 py-3">
          <span className="font-semibold">Liga Hispana · Admin</span>
          <nav className="flex items-center gap-4 text-sm">
            <Link href="/admin" className="text-neutral-300 hover:text-neutral-100">
              Resumen
            </Link>
            <Link
              href="/admin/jugadores"
              className="text-neutral-300 hover:text-neutral-100"
            >
              Jugadores
            </Link>
          </nav>
          <div className="ml-auto flex items-center gap-3 text-sm text-neutral-400">
            <span>{user.email}</span>
            <form action={logout}>
              <button
                type="submit"
                className="rounded-md border border-neutral-700 px-3 py-1 hover:border-neutral-500 hover:text-neutral-100"
              >
                Salir
              </button>
            </form>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8">{children}</main>
    </div>
  );
}
