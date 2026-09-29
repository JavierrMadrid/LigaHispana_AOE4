/**
 * Configuración de Supabase.
 *
 * Estas tres se leen **a propósito** con `process.env` y sin pasar por
 * `readRuntimeEnv`: Next sustituye `process.env.NEXT_PUBLIC_*` por un literal al
 * compilar, y esa sustitución solo la hace con la forma estática
 * `process.env.NEXT_PUBLIC_ALGO`. Un acceso por nombre dinámico no se sustituye y
 * en el cliente valdría `undefined`
 * ([docs de Next](https://nextjs.org/docs/app/guides/environment-variables#bundling-environment-variables-for-the-browser)).
 * En Cloudflare hay que definirlas además en *Build variables and secrets*, que es
 * lo que hace que existan cuando `next build` compila
 * ([OpenNext](https://opennext.js.org/cloudflare/howtos/env-vars#workers-builds)).
 */
export function getSupabaseEnv() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key =
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

  if (!url || !key) {
    throw new Error(
      "Faltan NEXT_PUBLIC_SUPABASE_URL y NEXT_PUBLIC_SUPABASE_ANON_KEY (o NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY).",
    );
  }

  return { url, key };
}
