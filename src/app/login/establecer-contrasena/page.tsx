import type { Metadata } from "next";
import { SetPasswordForm } from "./set-password-form";

export const metadata: Metadata = {
  // `absolute` evita que la plantilla del layout raíz ("%s · Liga Hispana AoE4")
  // se aplique dos veces.
  title: { absolute: "Establecer contraseña · Liga Hispana AoE4" },
};

/**
 * Página de alta de contraseña, la que sigue a `/auth/confirm` tras verificar
 * el enlace de invitación.
 *
 * No comprueba la sesión ni redirige: quien llega aquí viene con sesión recién
 * emitida por el enlace, así que expulsarlo a `/admin` sería justo lo contrario
 * de lo que pide. Si no hay sesión, la propia acción devuelve al login.
 */
export default function SetPasswordPage() {
  return (
    <main className="flex flex-1 items-center justify-center px-4 py-16">
      <SetPasswordForm />
    </main>
  );
}
