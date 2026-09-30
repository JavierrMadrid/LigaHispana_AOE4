import { redirect } from "next/navigation";

/**
 * `/admin/jugadores` ya no existe: sus funciones viven en `/admin`, que es la
 * pestaña de Participantes. Se deja una redirección para no romper enlaces
 * antiguos ni marcadores, en lugar de devolver un 404.
 */
export default function PlayersRedirect(): never {
  redirect("/admin");
}
