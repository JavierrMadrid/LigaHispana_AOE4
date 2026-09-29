import { NextResponse, type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/proxy";

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Solo se llega aquí en las rutas del `matcher`, así que la comprobación se
  // hace una vez y decide entre las dos redirecciones.
  const isAdminRoute = pathname === "/admin" || pathname.startsWith("/admin/");

  const { supabaseResponse, user } = await updateSession(request);

  if (isAdminRoute && !user) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    return NextResponse.redirect(url);
  }

  if (pathname === "/login" && user) {
    const url = request.nextUrl.clone();
    url.pathname = "/admin";
    url.search = "";
    return NextResponse.redirect(url);
  }

  return supabaseResponse;
}

/**
 * El Proxy solo se ocupa de la sesión en `/admin*` y `/login`, que son las únicas
 * rutas que deciden con ella, así que el `matcher` se limita a esas.
 *
 * Antes cubría todas las páginas y `updateSession` hacía un viaje a
 * `*.supabase.co` en cada una, incluidas las públicas (`/`, `/reglas`,
 * `/participar`, `/partidas`, `/objetivos`), que no piden identidad. Ese viaje no
 * es solo coste: es la llamada de red que se quedaba colgada y provocaba el error
 * 1101.
 *
 * Lo que se pierde es refrescar el token cuando un admin navega por páginas
 * públicas. No rompe nada: el refresco sigue ocurriendo en la primera petición que
 * necesita la sesión (`/admin*` y `/login`), que es donde importa, y
 * `getUser()` refresca por su cuenta cuando el token está cerca de caducar
 * (`__loadSession` → `_callRefreshToken`). Como solo `/admin*` y `/login` leen
 * la sesión, ninguna otra ruta lo necesita.
 *
 * Ojo a lo que dice la [documentación del Proxy]
 * (https://nextjs.org/docs/app/api-reference/file-conventions/proxy): excluir una
 * ruta del `matcher` excluye también sus Server Functions. Aquí solo se excluyen
 * rutas públicas, y las Server Actions de admin viven bajo `/admin/jugadores`,
 * dentro del `matcher`; además cada una vuelve a llamar a `requireAdmin()`, que
 * es la comprobación real.
 *
 * [documentación del Proxy]: https://nextjs.org/docs/app/api-reference/file-conventions/proxy
 */
export const config = {
  matcher: ["/admin/:path*", "/login"],
};
