import "server-only";

import { cache } from "react";
import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";

async function readCurrentUser() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error) {
    return null;
  }

  return user;
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
