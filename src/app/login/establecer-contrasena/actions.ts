"use server";

import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/** Mínimo razonable para una cuenta de la organización. */
const MIN_PASSWORD_LENGTH = 8;

export type SetPasswordState = {
  error: string | null;
};

/**
 * Fija la contraseña del usuario de la sesión y lo deja dentro.
 *
 * La sesión la ha dejado `/auth/confirm` al verificar el enlace de invitación (o
 * de recuperación): sin ella no hay a quién cambiarle la contraseña, así que un
 * intento sin sesión vuelve al login en lugar de devolver un error —aquí no hay
 * formulario que volver a enseñar.
 *
 * Campos del formulario: `password` y `confirm`.
 */
export async function setPassword(
  _prevState: SetPasswordState,
  formData: FormData,
): Promise<SetPasswordState> {
  const user = await getCurrentUser();

  if (!user) {
    redirect("/login");
  }

  const password = String(formData.get("password") ?? "");
  const confirm = String(formData.get("confirm") ?? "");

  if (password.length === 0 || confirm.length === 0) {
    return { error: "Introduce la contraseña y su repetición." };
  }

  if (password.length < MIN_PASSWORD_LENGTH) {
    return { error: `La contraseña necesita al menos ${MIN_PASSWORD_LENGTH} caracteres.` };
  }

  if (password !== confirm) {
    return { error: "Las contraseñas no coinciden." };
  }

  const supabase = await createSupabaseServerClient();

  const { error } = await supabase.auth.updateUser({ password });

  if (error) {
    return { error: "No se ha podido guardar la contraseña. Inténtalo de nuevo." };
  }

  redirect("/admin");
}