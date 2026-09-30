import type { Metadata } from "next";
import { redirectIfAuthenticated } from "@/lib/auth";
import { LoginPanel } from "./login-panel";

export const metadata: Metadata = {
  // `absolute` evita que la plantilla del layout raíz ("%s · Liga Hispana AoE4")
  // se aplique dos veces.
  title: { absolute: "Admin · Liga Hispana AoE4" },
};

/**
 * Página propia de `/login`: es lo que se ve al entrar por URL directa o al
 * recargar. La variante de ventana vive en el slot interceptado de `(public)`.
 *
 * Es asíncrona para comprobar la sesión antes de pintar el formulario; leer las
 * cookies es lo que la vuelve dinámica (`ƒ` en el build en lugar de `○`).
 *
 * El flujo de invitación redirige aquí con `?error=enlace` cuando el enlace del
 * correo caducó o ya se usó; en ese caso se lo contamos al usuario en la propia
 * tarjeta. Cualquier otro valor de `error` se ignora a propósito.
 */
export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  await redirectIfAuthenticated();

  const { error } = await searchParams;
  const message =
    error === "enlace"
      ? "El enlace de invitación no es válido o ha caducado. Pide uno nuevo a la organización."
      : undefined;

  return (
    <main className="flex flex-1 items-center justify-center px-4 py-16">
      <LoginPanel message={message} />
    </main>
  );
}
