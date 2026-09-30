/**
 * Cierra la ventana cuando se vuelve a la portada por navegación de cliente.
 *
 * Sin una ruta que haga juego, el slot conservaría la última subpágina activa
 * (la ventana abierta) aunque la URL ya no le corresponda. Devolver `null` es
 * lo que la cierra.
 */
export default function ModalRootClose() {
  return null;
}
