/**
 * Cierra la ventana al navegar a cualquier otra página pública (`/partidas`,
 * `/reglas`, ...). El `default` solo cubre la recarga, no la navegación de
 * cliente, así que hace falta una ruta catch-all que devuelva `null`.
 */
export default function ModalCatchAllClose() {
  return null;
}
