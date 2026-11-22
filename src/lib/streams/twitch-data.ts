import { normalizeTwitchChannel } from "@/lib/stream-channels";

export type TwitchLeagueParticipant = {
  profileId: number;
  name: string;
  twitchChannel: string | null;
  twitchIsLive: boolean;
};

export type TwitchStreamCard = {
  profileId: number;
  playerName: string;
  login: string;
  displayName: string;
  thumbnailUrl: string;
  channelUrl: string;
  viewerCount: number | null;
};

export type TwitchStreamsRead = {
  status: "ok" | "unavailable";
  streams: TwitchStreamCard[];
};

export type TwitchCredentials = { clientId: string; clientSecret: string };
type TwitchStream = Pick<TwitchStreamCard, "login" | "displayName" | "thumbnailUrl" | "viewerCount">;
type Candidate = TwitchLeagueParticipant & { login: string };
type HttpResult = { status: number; body: unknown };
type Request = (url: string, init: RequestInit) => Promise<HttpResult>;

const MAX_CARDS = 5;
const MAX_CHANNELS = 100;
const CACHE_MS = 60_000;
const VALIDATE_INTERVAL_MS = 55 * 60_000;
const TOKEN_URL = "https://id.twitch.tv/oauth2/token";
const VALIDATE_URL = "https://id.twitch.tv/oauth2/validate";
const STREAMS_URL = "https://api.twitch.tv/helix/streams";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function candidates(rows: readonly TwitchLeagueParticipant[]): Candidate[] {
  const channels = new Map<string, Candidate>();
  for (const row of rows) {
    const login = normalizeTwitchChannel(row.twitchChannel);
    if (!row.twitchIsLive || login === null || channels.has(login)) continue;
    channels.set(login, { ...row, login });
    if (channels.size === MAX_CHANNELS) break;
  }
  return [...channels.values()];
}

function thumbnail(login: string): string {
  return `https://static-cdn.jtvnw.net/previews-ttv/live_user_${login}-640x360.jpg`;
}

function apiThumbnail(value: unknown, login: string): string {
  if (typeof value !== "string") return thumbnail(login);
  try {
    const url = new URL(value.replaceAll("{width}", "640").replaceAll("{height}", "360"));
    if (url.protocol === "https:" && url.hostname === "static-cdn.jtvnw.net" &&
      !url.username && !url.password && !url.port && url.pathname.startsWith("/previews-ttv/")) {
      return url.toString();
    }
  } catch { /* Una miniatura inválida no debe ocultar un canal confirmado. */ }
  return thumbnail(login);
}

export function fallbackLeagueTwitchStreams(rows: readonly TwitchLeagueParticipant[]): TwitchStreamsRead {
  const streams = candidates(rows).slice(0, MAX_CARDS).map((row): TwitchStreamCard => ({
    profileId: row.profileId,
    playerName: row.name,
    login: row.login,
    displayName: row.login,
    thumbnailUrl: thumbnail(row.login),
    channelUrl: `https://www.twitch.tv/${row.login}`,
    viewerCount: null,
  }));
  return { status: streams.length ? "unavailable" : "ok", streams };
}

/** Un campo ausente no equivale a cero espectadores; un envelope roto tampoco es una lista vacía. */
export function parseTwitchStreams(payload: unknown): TwitchStream[] | null {
  if (!isRecord(payload) || !Array.isArray(payload.data) || payload.data.length > MAX_CHANNELS) return null;
  const streams = new Map<string, TwitchStream>();
  for (const entry of payload.data) {
    if (!isRecord(entry) || typeof entry.type !== "string") return null;
    if (entry.type !== "live") continue;
    if (typeof entry.user_login !== "string" || !/^[a-z0-9_]{3,25}$/i.test(entry.user_login)) return null;
    const login = entry.user_login.toLowerCase();
    if (streams.has(login)) continue;
    streams.set(login, {
      login,
      displayName: typeof entry.user_name === "string" && entry.user_name.trim()
        ? entry.user_name.trim().slice(0, 100) : login,
      thumbnailUrl: apiThumbnail(entry.thumbnail_url, login),
      viewerCount: typeof entry.viewer_count === "number" && Number.isSafeInteger(entry.viewer_count) && entry.viewer_count >= 0
        ? entry.viewer_count : null,
    });
  }
  return [...streams.values()];
}

function cards(streams: readonly TwitchStream[], roster: readonly Candidate[]): TwitchStreamCard[] {
  const byLogin = new Map(roster.map((row) => [row.login, row]));
  return streams.flatMap((stream): TwitchStreamCard[] => {
    const row = byLogin.get(stream.login);
    return row ? [{ ...stream, profileId: row.profileId, playerName: row.name,
      channelUrl: `https://www.twitch.tv/${stream.login}` }] : [];
  }).sort((left, right) => (right.viewerCount ?? -1) - (left.viewerCount ?? -1) || left.login.localeCompare(right.login))
    .slice(0, MAX_CARDS);
}

type Token = { value: string; expiresAt: number; validateAfter: number };
type CacheEntry = { expiresAt: number; streams: TwitchStream[] | null };
type Scope = { token: Token | null; results: Map<string, CacheEntry> };

function expiresIn(payload: unknown): number | null {
  return isRecord(payload) && typeof payload.expires_in === "number" &&
    Number.isSafeInteger(payload.expires_in) && payload.expires_in > 30 ? payload.expires_in : null;
}

/** Dependencias explícitas para probar caducidad y errores sin red, entorno ni relojes reales. */
export function createTwitchStreamReader({ request, now }: { request: Request; now: () => number }) {
  // Solo valores resueltos: compartir promesas de fetch entre invocaciones rompe el aislamiento de workerd.
  const scopes = new Map<string, Scope>();

  async function validate(token: Token, credentials: TwitchCredentials, signal?: AbortSignal): Promise<Token | null> {
    const response = await request(VALIDATE_URL, { headers: { Authorization: `OAuth ${token.value}` }, signal });
    if (response.status === 401) return null;
    const seconds = expiresIn(response.body);
    if (response.status !== 200 || !isRecord(response.body) || response.body.client_id !== credentials.clientId || seconds === null) {
      throw new Error("Validación de Twitch no disponible.");
    }
    return { value: token.value, expiresAt: now() + (seconds - 30) * 1000,
      validateAfter: now() + VALIDATE_INTERVAL_MS };
  }

  async function tokenFor(scope: Scope, credentials: TwitchCredentials, signal?: AbortSignal): Promise<string> {
    if (scope.token && scope.token.expiresAt > now()) {
      if (scope.token.validateAfter > now()) return scope.token.value;
      scope.token = await validate(scope.token, credentials, signal);
      if (scope.token) return scope.token.value;
    }
    scope.token = null;
    const response = await request(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: credentials.clientId, client_secret: credentials.clientSecret, grant_type: "client_credentials" }).toString(),
      signal,
    });
    const seconds = expiresIn(response.body);
    if (response.status !== 200 || !isRecord(response.body) || seconds === null ||
      typeof response.body.access_token !== "string" || !/^[\w-]{1,2048}$/.test(response.body.access_token) ||
      response.body.token_type !== "bearer") throw new Error("Autorización de Twitch no disponible.");
    scope.token = await validate({ value: response.body.access_token,
      expiresAt: now() + (seconds - 30) * 1000, validateAfter: 0 }, credentials, signal);
    if (!scope.token) throw new Error("Autorización de Twitch no disponible.");
    return scope.token.value;
  }

  return async function read(
    rows: readonly TwitchLeagueParticipant[], credentials: TwitchCredentials | null, signal?: AbortSignal,
  ): Promise<TwitchStreamsRead> {
    const roster = candidates(rows);
    if (!roster.length || credentials === null) return fallbackLeagueTwitchStreams(rows);
    const credentialKey = JSON.stringify([credentials.clientId, credentials.clientSecret]);
    let scope = scopes.get(credentialKey);
    if (!scope) {
      if (scopes.size >= 2) scopes.delete(scopes.keys().next().value!);
      scope = { token: null, results: new Map() };
      scopes.set(credentialKey, scope);
    }
    const key = roster.map((row) => row.login).sort().join(",");
    const cached = scope.results.get(key);
    if (cached && cached.expiresAt > now()) {
      return cached.streams === null ? fallbackLeagueTwitchStreams(rows) : { status: "ok", streams: cards(cached.streams, roster) };
    }

    let streams: TwitchStream[] | null = null;
    try {
      const url = new URL(STREAMS_URL);
      url.searchParams.set("type", "live");
      url.searchParams.set("first", "100");
      for (const login of roster.map((row) => row.login).sort()) url.searchParams.append("user_login", login);
      const fetchStreams = async () => request(url.toString(), {
        headers: { Authorization: `Bearer ${await tokenFor(scope, credentials, signal)}`, "Client-Id": credentials.clientId }, signal,
      });
      let response = await fetchStreams();
      if (response.status === 401) {
        scope.token = null;
        response = await fetchStreams();
      }
      if (response.status === 200) streams = parseTwitchStreams(response.body);
    } catch { /* Un fallo remoto conserva la señal conocida de la liga, nunca inventa espectadores. */ }

    if (scope.results.size >= 20) scope.results.delete(scope.results.keys().next().value!);
    scope.results.set(key, { expiresAt: now() + CACHE_MS, streams });
    return streams === null ? fallbackLeagueTwitchStreams(rows) : { status: "ok", streams: cards(streams, roster) };
  };
}
