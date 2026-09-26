"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";
import { PlayerStatus } from "@/generated/prisma/enums";

export type PlayerFormState = {
  error: string | null;
};

function parseProfileId(value: FormDataEntryValue | null) {
  const raw = String(value ?? "").trim();

  if (!/^\d+$/.test(raw)) {
    return null;
  }

  const profileId = Number(raw);

  return profileId > 0 ? profileId : null;
}

function parseName(value: FormDataEntryValue | null) {
  const name = String(value ?? "").trim();

  return name.length > 0 && name.length <= 64 ? name : null;
}

function parseTwitchChannel(value: FormDataEntryValue | null) {
  const channel = String(value ?? "").trim().replace(/^@/, "");

  if (!channel) {
    return null;
  }

  return /^[a-zA-Z0-9_]{3,25}$/.test(channel) ? channel.toLowerCase() : null;
}

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

  const existing = await db.player.findUnique({ where: { profileId } });

  if (existing) {
    return { error: `El perfil ${profileId} ya está registrado (${existing.name}).` };
  }

  await db.player.create({
    data: { profileId, name, twitchChannel, status: status as PlayerStatus },
  });

  revalidatePath("/admin");
  revalidatePath("/admin/jugadores");

  return { error: null };
}

async function setPlayerStatus(playerId: string, status: PlayerStatus) {
  await requireAdmin();

  await db.player.update({ where: { id: playerId }, data: { status } });

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

  await db.player.delete({ where: { id: playerId } });

  revalidatePath("/admin");
  revalidatePath("/admin/jugadores");
}
