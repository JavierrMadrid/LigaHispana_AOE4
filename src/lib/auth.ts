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
