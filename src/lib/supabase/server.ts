import "server-only";

import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { getSupabaseEnv } from "./env";
import { createAuthFetch } from "./session";

export async function createSupabaseServerClient() {
  const cookieStore = await cookies();
  const { url, key } = getSupabaseEnv();

  return createServerClient(url, key, {
    // Mismo tope por petición que en el proxy: `getUser(jwt?)` no acepta una
    // `AbortSignal`, así que el corte va por el `fetch` del cliente. Sin esto la
    // llamada solo la acota el plazo de `readAuthUser`, que devuelve `null` pero
    // deja la petición de red viva hasta que el runtime la cierra.
    global: { fetch: createAuthFetch() },
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Se llama desde un Server Component: el proxy ya refresca la sesión.
        }
      },
    },
  });
}
