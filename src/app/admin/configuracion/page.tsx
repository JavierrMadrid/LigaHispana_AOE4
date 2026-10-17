import { redirect } from "next/navigation";

/**
 * `/admin/configuracion` ya no existe: sus dos ajustes son ahora las subpestañas
 * Inscripciones y Donaciones de Administración. Se deja una redirección para no
 * romper enlaces antiguos ni marcadores, en lugar de devolver un 404.
 */
export default function ConfigurationRedirect(): never {
  redirect("/admin/administracion/inscripciones");
}
