import "server-only";

import type { User } from "@supabase/supabase-js";
import { cache } from "react";
import { redirect } from "next/navigation";
import {
  isSuperadminEmail,
  normalizeAdminEmail,
  resolveAdminAccess,
  type AdminAccess,
} from "@/lib/admin-access";
import { findAdminForAccess, readSuperadminEmail } from "@/lib/admin-users";
import { logDatabaseFailure } from "@/lib/db-errors";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { readAuthUser } from "@/lib/supabase/session";

/**
 * La puerta del panel: sesión **y** acceso.
 *
 * Dos comprobaciones, en este orden, porque son dos cosas distintas. La sesión dice
 * *quién* es (Supabase Auth); el acceso dice *si puede entrar* (el correo del
 * superadministrador en `SUPERADMIN_EMAIL`, o una fila **activa** de `Admin`). Tener
 * sesión ya no basta: es exactamente el cambio que permite dar de baja a alguien sin
 * borrarle la cuenta.
 *
 * ## `null` en la sesión es cerrar, no abrir
 *
 * `getCurrentUser()` devuelve `null` cuando no hay sesión y también cuando no se ha
 * podido comprobar (ver `src/lib/supabase/session.ts`). En los dos casos
 * `requireAdmin()` redirige a `/login`, así que un fallo de Supabase Auth saca al
 * admin en vez de dejarlo pasar.
 *
 * ## Un fallo al leer el acceso también cierra
 *
 * La fila de `Admin` se lee contra Postgres. Si esa lectura falla, el acceso se
 * resuelve como `"none"` y la persona acaba en `/sin-acceso`: se falla **cerrando**,
 * como con la sesión. La excepción es el superadministrador, que se reconoce por el
 * entorno antes de tocar la base y por eso no depende de que Postgres responda.
 */

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
 *
 * **Es solo "quién es", no "si puede entrar".** Un endpoint que compruebe permisos
 * tiene que usar `readAdminAccess()`: tener sesión ya no equivale a ser admin.
 */
export const readAuthenticatedUser = readCurrentUser;

export const getCurrentUser = cache(readCurrentUser);

/**
 * El acceso de un usuario ya resuelto, o `"none"` si no hay sesión.
 *
 * La comparten la lectura memoizada (`getAdminAccess`) y la de los Route Handlers
 * (`readAdminAccess`), para que las dos decidan igual.
 *
 * El superadministrador se resuelve **antes** de consultar la base y por eso no
 * genera ninguna lectura. El correo entra tal cual lo devuelve la sesión y se
 * normaliza dentro: la sesión no garantiza la caja, y el superadministrador y las
 * filas se comparan siempre en minúsculas.
 */
async function resolveAccessFor(user: User | null): Promise<AdminAccess> {
  if (!user) {
    return "none";
  }

  const email = normalizeAdminEmail(user.email ?? "");
  const superadminEmail = readSuperadminEmail();

  if (isSuperadminEmail(email, superadminEmail)) {
    return "superadmin";
  }

  if (email === "") {
    return "none";
  }

  let row: { email: string; active: boolean } | null;

  try {
    row = await findAdminForAccess(email);
  } catch (error) {
    // Se falla cerrando: un corte de la base no puede conceder acceso. El motivo se
    // queda en el log, y quien lo sufre, en `/sin-acceso`.
    logDatabaseFailure("auth/acceso", error);

    return "none";
  }

  return resolveAdminAccess({ email, superadminEmail, admins: row === null ? [] : [row] });
}

/**
 * Igual que `getAdminAccess` pero sin el memoizado de React: los Route Handlers no
 * corren dentro de un render, así que `cache()` no aporta nada ahí. Es la lectura
 * que deben usar los endpoints que comprueban permisos.
 */
export async function readAdminAccess(): Promise<AdminAccess> {
  return resolveAccessFor(await readCurrentUser());
}

/**
 * El acceso del usuario de la sesión, memoizado por petición.
 *
 * Memoizarlo importa porque `requireAdmin()` se llama en cada página y en cada
 * Server Action del panel: sin el `cache()`, la lectura de `Admin` que hay aquí se
 * repetiría en la misma petición.
 */
export const getAdminAccess = cache(async (): Promise<AdminAccess> =>
  resolveAccessFor(await getCurrentUser()),
);

/**
 * Exige sesión **y** acceso al panel, y devuelve el usuario.
 *
 * Un usuario autenticado sin acceso **no** va a `/login`: el Proxy lo devolvería a
 * `/admin` —sigue teniendo sesión— y se entraría en un bucle. Va a `/sin-acceso`,
 * que explica lo que pasa y ofrece cerrar sesión; esa ruta está fuera del `matcher`
 * del Proxy y no llama a `requireAdmin()`, así que el bucle no puede cerrarse.
 */
export async function requireAdmin(): Promise<User> {
  const user = await getCurrentUser();

  if (!user) {
    redirect("/login");
  }

  const access = await getAdminAccess();

  if (access === "none") {
    redirect("/sin-acceso");
  }

  return user;
}

/**
 * Exige que quien llama sea **el** superadministrador.
 *
 * Un admin normal que llegue aquí no ve `/sin-acceso` (tiene acceso): se le devuelve
 * a `/admin`, que es su sitio. Sin sesión, a `/login` como en `requireAdmin()`.
 */
export async function requireSuperadmin(): Promise<User> {
  const user = await getCurrentUser();

  if (!user) {
    redirect("/login");
  }

  const access = await getAdminAccess();

  if (access === "none") {
    redirect("/sin-acceso");
  }

  if (access === "admin") {
    redirect("/admin");
  }

  return user;
}

/**
 * Saca de la pantalla de login a quien ya tiene sesión, mandándolo a `/admin`.
 *
 * El motivo: quien ya está dentro puede llegar al login por un enlace antiguo o por
 * el "atrás" del navegador, y plantarle delante un formulario que ya no le sirve no
 * aporta nada. Un admin sin acceso —o con el acceso recién retirado— que llegue así
 * acaba en `/sin-acceso` en cuanto `/admin` llama a `requireAdmin()`: no hay bucle
 * porque `/sin-acceso` está fuera del `matcher` del Proxy.
 *
 * Reutiliza el `getCurrentUser()` memoizado, el mismo que `requireAdmin()`, y solo
 * actúa sobre un usuario confirmado. Un `null` puede querer decir también que la
 * comprobación falló, y no se fuerza: como mucho se muestra el formulario, y si la
 * sesión estaba viva de verdad, al enviarlo `login` entra directamente y al llegar a
 * `/admin` decide `requireAdmin()`.
 */
export async function redirectIfAuthenticated(): Promise<void> {
  const user = await getCurrentUser();

  if (user) {
    redirect("/admin");
  }
}
