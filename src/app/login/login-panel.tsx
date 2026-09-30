import Image from "next/image";
import { LoginForm } from "./login-form";

/**
 * Tarjeta de acceso, compartida por la página `/login` y la ventana que la
 * intercepta.
 *
 * Es el mismo contenido en las dos variantes —emblema, título, subtítulo y
 * formulario— para que la ruta propia y el modal no puedan divergir. Es un
 * Server Component: no tiene estado ni eventos. El formulario, que sí los
 * necesita, se aísla en `LoginForm`.
 *
 * `message` es opcional: solo la página propia lo usa para explicar por qué se
 * ha llegado hasta aquí (por ejemplo, un enlace de invitación caducado). En el
 * modal no viene y la tarjeta se ve igual que siempre.
 */
export function LoginPanel({ message }: { message?: string }) {
  return (
    <div className="w-full max-w-sm rounded-lg border border-line bg-surface p-6">
      <Image
        src="/imagenes/marca/emblema-256.png"
        alt="Emblema de la Liga Hispana de Age of Empires IV"
        width={56}
        height={56}
        className="mb-4 size-14"
      />
      <h1 className="mb-1 text-xl font-semibold text-foreground">Panel de administración</h1>
      <div className="mb-6">
        <p className="text-sm text-muted">
          Solo para la organización. Inicia sesión con tu cuenta de Supabase.
        </p>
        {message ? <p className="mt-2 text-sm text-red-400">{message}</p> : null}
      </div>
      <LoginForm />
    </div>
  );
}
