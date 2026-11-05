/**
 * Estado compartido de los formularios de objetos del panel.
 *
 * Vive aparte de [`actions.ts`](./actions.ts) por una razón de Next: un fichero con
 * `"use server"` **solo puede exportar funciones asíncronas**, y una constante
 * exportada desde allí revienta al registrar las acciones (`A "use server" file can
 * only export async functions`). El tipo y los valores iniciales tienen que poder
 * importarlos también los componentes de cliente que pinten el formulario.
 */

/** Lo que devuelven las dos acciones; `ok` distingue el aviso del error. */
export type ObjectActionState = {
  ok: boolean;
  message: string;
};

/**
 * Estado inicial de los dos formularios.
 *
 * Empieza en `ok` con el mensaje vacío: no hay ningún error que enseñar todavía. La
 * página pinta el mensaje solo cuando no está vacío.
 */
export const INITIAL_THROW_OBJECT_STATE: ObjectActionState = { ok: true, message: "" };

export const INITIAL_FULFILL_OBJECT_STATE: ObjectActionState = { ok: true, message: "" };
