import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { logout } from "@/app/login/actions";
import { getCurrentUser } from "@/lib/auth";

export const metadata: Metadata = {
  title: { absolute: "Sin acceso · Liga Hispana AoE4" },
};

/**
 * A dónde va quien tiene sesión pero no acceso al panel.
 *
 * Existe porque `/admin` ya no basta con estar autenticado: `requireAdmin()` exige
 * además una fila activa de `Admin` (o ser el superadministrador). Un usuario sin
 * acceso **no** puede ir a `/login` —el Proxy lo devolvería a `/admin` porque sigue
 * teniendo sesión— así que esta página es su destino, y por eso está fuera del
 * `matcher` del Proxy y no llama a `requireAdmin()`.
 *
 * Comparte el lenguaje del acceso —la misma tarjeta del login, con el emblema, el
 * mismo tamaño y los mismos controles— porque es la otra cara del mismo momento:
 * quien llega aquí acaba de intentar entrar. Explica la situación, enseña con qué
 * cuenta se ha entrado y ofrece las dos salidas que tienen sentido: cerrar sesión
 * para probar con otra cuenta, o volver a la web.
 */
export default async function SinAccesoPage() {
  const user = await getCurrentUser();

  return (
    <main className="flex flex-1 items-center justify-center px-4 py-16">
      <div className="w-full max-w-sm rounded-lg border border-line bg-surface p-6">
        <Image
          src="/imagenes/marca/emblema-256.png"
          alt="Emblema de la Liga Hispana de Age of Empires IV"
          width={56}
          height={56}
          className="mb-4 size-14"
        />

        <h1 className="mb-1 text-xl font-semibold text-foreground">Sin acceso al panel</h1>

        <div className="mb-6">
          <p className="text-sm text-muted">
            Has iniciado sesión, pero esta cuenta no tiene permiso para el panel de
            administración. Pide a la organización que te añada.
          </p>

          {user?.email ? (
            <p className="mt-2 text-sm text-muted">
              Has entrado como <span className="break-all text-foreground">{user.email}</span>.
            </p>
          ) : null}
        </div>

        <div className="flex flex-col gap-3 sm:flex-row">
          <form action={logout} className="sm:flex-1">
            <button
              type="submit"
              className="h-10 w-full rounded-md bg-accent px-4 text-sm font-medium text-accent-ink transition-colors hover:bg-accent-strong active:translate-y-px"
            >
              Cerrar sesión
            </button>
          </form>

          <Link
            href="/"
            className="inline-flex h-10 items-center justify-center rounded-md border border-line px-4 text-sm text-muted transition-colors hover:border-line-strong hover:text-foreground sm:flex-1"
          >
            Volver a la web
          </Link>
        </div>
      </div>
    </main>
  );
}
