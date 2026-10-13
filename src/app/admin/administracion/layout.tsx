import { AdministrationTabs } from "@/app/admin/administracion/administration-tabs";
import { requireSuperadmin } from "@/lib/auth";

/**
 * Sección de administración: la puerta y el marco de sus subpestañas.
 *
 * `requireSuperadmin()` cierra la sección entera de una vez —un admin regular que
 * llegue aquí vuelve a `/admin`, y sin sesión se va a `/login`—, así que ninguna
 * subpágina repite la comprobación. La cabecera larga vive también aquí, una sola
 * vez: cada subpágina solo añade su titular y una frase.
 */
export default async function AdministrationLayout({
  children,
}: LayoutProps<"/admin/administracion">) {
  await requireSuperadmin();

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Administración</h1>
          <p className="mt-1 max-w-[70ch] text-sm text-muted">
            Los ajustes que solo puede tocar la cuenta de superadministración: quién
            entra al panel, la configuración de la edición, las reglas de puntuación,
            quién puede inscribirse, el banner de donaciones y las pruebas del canal
            de avisos. Cada cambio queda anotado en el historial de acciones.
          </p>
        </div>

        <AdministrationTabs />
      </div>

      {children}
    </div>
  );
}
