import { AdministrationTabs } from "@/app/admin/administracion/administration-tabs";
import { AdminPageHeader } from "@/components/admin/page-header";
import { requireSuperadmin } from "@/lib/auth";

/**
 * Sección de administración: la puerta y el marco de sus subpestañas.
 *
 * `requireSuperadmin()` cierra la sección entera de una vez —un admin regular que
 * llegue aquí vuelve a `/admin`, y sin sesión se va a `/login`—, así que ninguna
 * subpágina repite la comprobación. La cabecera y la navegación viven también aquí,
 * una sola vez: cada subpágina solo añade su titular y una frase.
 *
 * A partir de `lg` la navegación es una columna fija y el contenido ocupa el
 * resto. En móvil se pliega en un desplegable: a 320 px las ocho opciones no caben
 * en una fila y empujarían el formulario fuera de la primera pantalla.
 */
export default async function AdministrationLayout({
  children,
}: LayoutProps<"/admin/administracion">) {
  await requireSuperadmin();

  return (
    <div className="flex flex-col gap-8">
      <AdminPageHeader
        level={1}
        title="Administración"
        description="Los ajustes del torneo que solo puede tocar el superadministrador."
      />

      <div className="flex flex-col gap-6 lg:grid lg:grid-cols-[13rem_minmax(0,1fr)] lg:items-start lg:gap-10">
        <AdministrationTabs />
        <div className="min-w-0">{children}</div>
      </div>
    </div>
  );
}
