import { buildAlertsReport } from "@/lib/alerts";
import { requireAdmin } from "@/lib/auth";

/**
 * Informe descargable de las alertas de comportamiento: `GET /admin/alertas/reporte`.
 *
 * Es el botón de la pestaña de alertas apuntando a esta ruta, y devuelve un CSV para
 * Excel con las alertas disparadas y las rachas que siguen abiertas. Lo genera
 * `buildAlertsReport()` (`src/lib/alerts/report.ts`), que **antes de escribir nada hace
 * una comprobación completa** del motor: un informe que describiera el estado de la
 * última pasada del sincronizador podría dejar fuera avisos de partidas que entraron
 * después, sin que nada en el fichero loindicara.
 *
 * ## Por qué `requireAdmin()` y no un secreto
 *
 * Es una descarga que pide una persona con sesión de admin desde el panel, no un
 * endpoint de integración: el mismo criterio que las Server Actions de admin. El Proxy ya
 * hace la comprobación optimista de la cookie, y esto es la real. Sin sesión,
 * `requireAdmin()` redirige a `/login` (307) y el navegador no descarga nada.
 *
 * No hace falta marcar la ruta como dinámica: `requireAdmin()` lee cookies, que ya es
 * una API de/request-time, así que Next no puede prerenderizarla.
 *
 * ## Por qué 503 y no un CSV a medias
 *
 * Un informe que sale a medias no es un informe degradado, es un informe falso: si la
 * lectura de la tabla falla a mitad, el fichero descargado daría la impresión de que esas
 * alertas son todas las que hay. Se registra el motivo y se dice que no se ha podido
 * generar.
 */
export async function GET(): Promise<Response> {
  // Fuera del `try`: `requireAdmin()` redirige lanzando, y tragarse ese error
  // convertiría un "no tienes sesión" en un "no se ha podido generar el informe".
  await requireAdmin();

  try {
    const report = await buildAlertsReport();

    return new Response(report.csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${report.filename}"`,
        // Un informe es el estado de un momento concreto: guardarlo en una caché (de
        // Cloudflare o del navegador) haría que dos descargas seguidas dieran ficheros
        // distintos sin que nadie lo pidiera.
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    console.error(
      "[alertas] No se ha podido generar el informe:",
      error instanceof Error ? error.message : String(error),
    );

    return new Response(
      "No se ha podido generar el informe de alertas. Vuelve a intentarlo en unos minutos.",
      {
        status: 503,
        headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
      },
    );
  }
}
