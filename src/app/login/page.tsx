import type { Metadata } from "next";
import { LoginForm } from "./login-form";

export const metadata: Metadata = {
  title: "Acceso admin — Liga Hispana AoE4",
};

export default function LoginPage() {
  return (
    <main className="flex flex-1 items-center justify-center px-4 py-16">
      <div className="w-full max-w-sm rounded-lg border border-neutral-800 bg-neutral-950 p-6">
        <h1 className="mb-1 text-xl font-semibold">Panel de administración</h1>
        <p className="mb-6 text-sm text-neutral-400">
          Solo para la organización. Inicia sesión con tu cuenta de Supabase.
        </p>
        <LoginForm />
      </div>
    </main>
  );
}
