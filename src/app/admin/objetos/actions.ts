"use server";

import { revalidatePath } from "next/cache";

import type { ObjectActionState } from "@/app/admin/objetos/state";
import { requireAdmin } from "@/lib/auth";
import { logDatabaseFailure } from "@/lib/db-errors";
import { fulfillObject, throwObject, type ThrowObjectResult } from "@/lib/object-awards";
import {
  announceObjectFulfillment,
  announceObjectThrow,
  formatReturnProbability,
} from "@/lib/object-announcements";
import { recomputeScores } from "@/lib/scoring";

/**
 * Server Actions de los objetos utilizables (issue 134): lanzar el objeto y dar la
 * desventaja por cumplida.
 *
 * Viven bajo `src/app/admin/**` por el mismo motivo que las de actuaciones: el
 * `matcher` del Proxy cubre `/admin/:path*` y una Server Action fuera de esa ruta se
 * saltaría la comprobación optimista de la cookie. La comprobación real es la de cada
 * acción, con `requireAdmin()`.
 *
 * La lógica de qué se puede lanzar, qué partida cumple la desventaja y qué escribe
 * cada operación vive en `src/lib/object-awards.ts`; aquí solo se valida la entrada,
 * se llama al servicio y se decide qué contar. Después del cambio se llama a
 * `recomputeScores()` **fuera** de cualquier transacción: el objeto ya está guardado y
 * un fallo del recálculo no lo deshace, solo deja la clasificación para la siguiente
 * pasada.
 *
 * El estado de los formularios y sus valores iniciales viven en `./state.ts`: un
 * fichero `"use server"` solo puede exportar funciones asíncronas.
 */

/**
 * Campo de texto de un formulario, ya recortado.
 *
 * `FormData.get` puede devolver un `File`; sin el filtro, `String(file)` produciría
 * `"[object File]"` y ese texto acabaría en una consulta.
 */
function readField(formData: FormData, name: string): string {
  const value = formData.get(name);

  return typeof value === "string" ? value.trim() : "";
}

function errorState(message: string): ObjectActionState {
  return { ok: false, message };
}

function successState(message: string): ObjectActionState {
  return { ok: true, message };
}

/**
 * Recalcula la clasificación sin tumbar la acción si falla.
 *
 * El cambio ya está escrito: deshacerlo porque el recálculo no salió dejaría al panel
 * diciendo que no se guardó lo que sí está. El mensaje de éxito es lo que le dice a
 * quien lo pulsó que la tabla que ve todavía es la anterior.
 */
async function recomputeAfterObjectChange(): Promise<boolean> {
  try {
    await recomputeScores();

    return true;
  } catch (error) {
    logDatabaseFailure("admin/objetos/recompute", error);

    return false;
  }
}

/** La coletilla del recálculo, para el mensaje de éxito. */
function recomputeNote(recomputed: boolean): string {
  return recomputed
    ? " La clasificación se ha recalculado."
    : " El cambio está guardado, pero el recálculo de la clasificación ha fallado: se pondrá al día en la próxima pasada del sincronizador.";
}

/**
 * Revalida el panel de objetos y la clasificación pública.
 *
 * La desventaja mueve puntos (una partida excluida deja de contar y el cumplimiento la
 * devuelve), así que la portada y el resto del grupo público tienen que dejar de
 * servir la copia anterior.
 */
function revalidateObjectViews(): void {
  revalidatePath("/admin/objetos");
  revalidatePath("/");
  revalidatePath("/(public)", "layout");
}

/**
 * Lanza un objeto a otro jugador.
 *
 * Lee `awardId` y `toId` y delega en `throwObject()`, que valida el premio, el
 * objetivo y las reglas de un lanzamiento por portador y día. Sus errores son `Error`
 * con el texto en español ya redactado, así que se devuelven tal cual. El estado de
 * éxito dice si se ha devuelto o si ha sido aceptado y la probabilidad que se aplicó.
 */
export async function throwObjectAction(
  _prevState: ObjectActionState,
  formData: FormData,
): Promise<ObjectActionState> {
  await requireAdmin();

  const awardId = readField(formData, "awardId");
  const toId = readField(formData, "toId");

  if (awardId === "" || toId === "") {
    return errorState("Selecciona el objeto y el jugador de destino.");
  }

  let result: ThrowObjectResult;

  try {
    result = await throwObject({ awardId, toId });
  } catch (error) {
    return errorState(error instanceof Error ? error.message : String(error));
  }

  const probability = formatReturnProbability(result.probability);
  const outcome = result.returned
    ? `El lanzamiento se ha devuelto: el objeto sigue en manos de quien lo lanzó (probabilidad aplicada: ${probability}).`
    : `El lanzamiento ha sido aceptado: el objeto pasa a manos del jugador de destino (probabilidad aplicada: ${probability}).`;

  const recomputed = await recomputeAfterObjectChange();

  await announceObjectThrow({
    awardId,
    returned: result.returned,
    probability: result.probability,
  });

  revalidateObjectViews();

  return successState(`${outcome}${recomputeNote(recomputed)}`);
}

/**
 * Da la desventaja por cumplida sobre una partida concreta.
 *
 * Lee `awardId` y `matchId` y delega en `fulfillObject()`. La partida tiene que ser del
 * portador y haber empezado después de que recibiera el objeto; el servicio es quien
 * lo comprueba y devuelve el motivo en español. Al cerrar la ventana, esa partida y las
 * posteriores vuelven a puntuar, y por eso se recalcula igual que en el lanzamiento.
 */
export async function fulfillObjectAction(
  _prevState: ObjectActionState,
  formData: FormData,
): Promise<ObjectActionState> {
  await requireAdmin();

  const awardId = readField(formData, "awardId");
  const matchId = readField(formData, "matchId");

  if (awardId === "" || matchId === "") {
    return errorState("Selecciona la partida con la que se cumple la desventaja.");
  }

  try {
    await fulfillObject({ awardId, matchId });
  } catch (error) {
    return errorState(error instanceof Error ? error.message : String(error));
  }

  const recomputed = await recomputeAfterObjectChange();

  await announceObjectFulfillment({ awardId });

  revalidateObjectViews();

  return successState(
    `La desventaja se ha dado por cumplida: la partida vuelve a puntuar y la siguiente también.${recomputeNote(recomputed)}`,
  );
}
