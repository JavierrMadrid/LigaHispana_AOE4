import type { Metadata } from "next";
import Image from "next/image";
import { LoginForm } from "./login-form";

export const metadata: Metadata = {
  // `absolute` evita que la plantilla del layout raíz ("%s · Liga Hispana AoE4")
  // se aplique dos veces.
  title: { absolute: "Admin · Liga Hispana AoE4" },
};

export default function LoginPage() {
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
        <h1 className="mb-1 text-xl font-semibold text-foreground">Panel de administración</h1>
        <p className="mb-6 text-sm text-muted">
          Solo para la organización. Inicia sesión con tu cuenta de Supabase.
        </p>
        <LoginForm />
      </div>
    </main>
  );
}
