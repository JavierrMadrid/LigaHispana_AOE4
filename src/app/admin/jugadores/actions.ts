"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { logDatabaseFailure } from "@/lib/db-errors";
import { PlayerStatus } from "@/generated/prisma/enums";
import {
  parseName,
  parseProfileId,
  parseTwitchChannel,
} from "@/lib/player-input";

export type PlayerFormState = {
  error: string | null;
};

/**
 * Fallo de base de datos al guardar. No dice si la base está caída, saturada o
 * con las credenciales malas: eso se queda en el log del servidor, con el prefijo
 * `[db]`. Al formulario solo le vuelve que no se ha podido guardar.
 */
const SAVE_FAILED_MESSAGE = "No se ha podido guardar. Inténtalo de nuevo en unos minutos.";

export async function createPlayer(
  _prevState: PlayerFormState,
  formData: FormData,
): Promise<PlayerFormState> {
  await requireAdmin();

  const profileId = parseProfileId(formData.get("profileId"));
  const name = parseName(formData.get("name"));
  const twitchChannel = parseTwitchChannel(formData.get("twitchChannel"));
  const statusRaw = String(formData.get("status") ?? "APPROVED");
  const status =
    statusRaw === "PENDING" || statusRaw === "REJECTED"
      ? statusRaw
      : "APPROVED";

  if (!profileId) {
    return { error: "El profile ID de AoE4World debe ser un número." };
  }

  if (!name) {
    return { error: "El nombre es obligatorio (máx. 64 caracteres)." };
  }

  // El `try` cubre **solo** la base de datos. Un fallo de validación tiene que
  // seguir siendo un error de aplicación, y por eso el bloque va aquí y no
  // alrededor de la acción entera.
  try {
    const existing = await db.player.findUnique({ where: { profileId } });

    if (existing) {
      return { error: `El perfil ${profileId} ya está registrado (${existing.name}).` };
    }

    await db.player.create({
      data: { profileId, name, twitchChannel, status: status as PlayerStatus },
    });
  } catch (error) {
    logDatabaseFailure("admin/createPlayer", error);

    return { error: SAVE_FAILED_MESSAGE };
  }

  revalidatePath("/admin");
  revalidatePath("/admin/jugadores");

  return { error: null };
}

async function setPlayerStatus(playerId: string, status: PlayerStatus) {
  await requireAdmin();

  try {
    await db.player.update({ where: { id: playerId }, data: { status } });
  } catch (error) {
    // Estos tres botones (`approvePlayer`, `rejectPlayer`, `deletePlayer`) son
    // formularios sin estado de error: no hay superficie en la que informar a
    // quien los pulsa, así que el fallo se registra y la acción termina sin
    // cambiar nada. Exponerlo es trabajo de la interfaz, no de aquí.
    logDatabaseFailure(`admin/${status}`, error);

    return;
  }

  revalidatePath("/admin");
  revalidatePath("/admin/jugadores");
}

export async function approvePlayer(formData: FormData) {
  await setPlayerStatus(String(formData.get("playerId")), "APPROVED");
}

export async function rejectPlayer(formData: FormData) {
  await setPlayerStatus(String(formData.get("playerId")), "REJECTED");
}

export async function deletePlayer(formData: FormData) {
  await requireAdmin();

  const playerId = String(formData.get("playerId") ?? "");

  if (!playerId) {
    return;
  }

  try {
    await db.player.delete({ where: { id: playerId } });
  } catch (error) {
    logDatabaseFailure("admin/deletePlayer", error);

    return;
  }

  revalidatePath("/admin");
  revalidatePath("/admin/jugadores");
}
