import "server-only";

import { readRuntimeEnv } from "@/lib/runtime-env";
import { createTwitchStreamReader, type TwitchLeagueParticipant, type TwitchStreamsRead } from "./twitch-data";

export { fallbackLeagueTwitchStreams } from "./twitch-data";
export type { TwitchStreamCard, TwitchStreamsRead } from "./twitch-data";

const read = createTwitchStreamReader({
  now: Date.now,
  request: async (url, init) => {
    const response = await fetch(url, { ...init, cache: "no-store", redirect: "error" });
    if (!response.ok) {
      await response.body?.cancel();
      return { status: response.status, body: null };
    }
    const body = await response.text();
    if (body.length > 256_000) throw new Error("Respuesta de Twitch demasiado grande.");
    return { status: response.status, body: JSON.parse(body) as unknown };
  },
});

export function getLeagueTwitchStreams(rows: readonly TwitchLeagueParticipant[]): Promise<TwitchStreamsRead> {
  const clientId = readRuntimeEnv("TWITCH_CLIENT_ID")?.trim();
  const clientSecret = readRuntimeEnv("TWITCH_CLIENT_SECRET")?.trim();
  return read(rows, clientId && clientSecret ? { clientId, clientSecret } : null, AbortSignal.timeout(3000));
}
