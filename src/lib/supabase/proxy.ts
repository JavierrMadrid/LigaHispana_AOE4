import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { getSupabaseEnv } from "./env";
import { createAuthFetch, readAuthUser } from "./session";

export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  const { url, key } = getSupabaseEnv();

  const supabase = createServerClient(url, key, {
    global: { fetch: createAuthFetch() },
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet, headers) {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }

        supabaseResponse = NextResponse.next({ request });

        for (const { name, value, options } of cookiesToSet) {
          supabaseResponse.cookies.set(name, value, options);
        }

        for (const [name, value] of Object.entries(headers)) {
          supabaseResponse.headers.set(name, value);
        }
      },
    },
  });

  // `null` significa tanto "no hay sesión" como "no se ha podido comprobar".
  // Para este archivo es lo mismo: quien decide qué hacer con esa ausencia es
  // `src/proxy.ts`, y en ambos casos su respuesta es proteger o redirigir.
  const user = await readAuthUser("proxy", supabase);

  return { supabaseResponse, user };
}
