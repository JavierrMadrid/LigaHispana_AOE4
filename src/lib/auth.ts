import "server-only";

import { cache } from "react";
import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { readAuthUser } from "@/lib/supabase/session";

/**
 * `null` cuando no hay sesión y también cuando no se ha podido comprobar. Es lo
 * que mantiene cerrado `/admin`: `requireAdmin()` redirige a `/login` ante un
 * `null`, así que un fallo de Supabase Auth saca al admin de `/admin` en vez de
 * dejarlo entrar.
 */
async function readCurrentUser() {
  const supabase = await createSupabaseServerClient();

  return readAuthUser("auth", supabase);
}

/**
 * Igual que `getCurrentUser` pero sin el memoizado de React: los Route Handlers
 * no corren dentro de un render, así que `cache()` no aporta nada ahí.
 */
export const readAuthenticatedUser = readCurrentUser;

export const getCurrentUser = cache(readCurrentUser);

export async function requireAdmin() {
  const user = await getCurrentUser();

  if (!user) {
    redirect("/login");
  }

  return user;
}

/**
 * Saca de la pantalla de login a quien ya tiene sesión, mandándolo a `/admin`.
 *
 * El motivo: un admin autenticado puede llegar al login por un enlace antiguo o
 * por el "atrás" del navegador, y plantedle delante un formulario que ya no le
 * sirve no aporta nada — el login es solo la puerta de `/admin` (todo usuario
 * autenticado es admin y los registros públicos de Supabase están desactivados,
 * ver `README.md`).
 *
 * Reutiliza el `getCurrentUser()` memoizado, el mismo que `requireAdmin()`, y
 * solo actúa sobre un usuario confirmado. Un `null` puede querer decir también
 * que la comprobación falló, y no se fuerza: como mucho se muestra el
 * formulario, y si la sesión estaba viva de verdad, al enviarlo `login` entra
 * directamente y al llegar a `/admin` decide `requireAdmin()`.
 */
export async function redirectIfAuthenticated(): Promise<void> {
  const user = await getCurrentUser();

  if (user) {
    redirect("/admin");
  }
}
