/**
 * Contenido del slot `@modal` cuando ninguna ventana está activa: nada.
 *
 * Hace falta porque un slot con rutas hijas exige un `default`, que es lo que
 * Next pinta cuando recarga la página y no puede recuperar el estado activo del
 * slot.
 */
export default function ModalDefault() {
  return null;
}
