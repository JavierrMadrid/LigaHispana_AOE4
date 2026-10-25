"use client";

import {
  useActionState,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useTransition,
  type FormEvent,
} from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { PLAYER_STATUS_LABELS } from "@/app/admin/participant-status";
import { PlayerCombobox, type ComboboxOption } from "@/components/player-combobox";
import {
  ADMIN_ACT_KINDS,
  ADMIN_ACT_KIND_LABELS,
  ADMIN_ACT_PRIVATE_INFO_MAX_LENGTH,
  ADMIN_ACT_PUBLIC_REASON_MAX_LENGTH,
  INITIAL_ADMIN_ACT_FORM_STATE,
  type AdminActFormState,
  type AdminActKind,
  type AdminActMatchCandidate,
  type AdminActPlayer,
  type AdminActTargetCandidate,
} from "@/lib/admin-acts";
import { createAdminActAction, loadAdminActMatches } from "../actions";
import { AdminActKindBadge } from "../act-badges";

type LoadStatus = "idle" | "loading" | "error" | "ready";

const KIND_HINTS: Record<AdminActKind, string> = {
  BAN: "Deja al participante fuera del torneo: desaparece de la clasificación, de la sincronización y de su ficha pública.",
  MATCH_ANNULMENT: "Anula victorias que hoy puntúan. La partida se conserva, pero deja de sumar.",
  REVERSAL: "Deshace actuaciones vigentes. Es final: una reversión no se puede revertir.",
};

const MATCH_DATE = new Intl.DateTimeFormat("es-ES", {
  dateStyle: "short",
  timeStyle: "short",
  timeZone: "Europe/Madrid",
});

const MADRID_DAY_KEY = new Intl.DateTimeFormat("en-CA", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  timeZone: "Europe/Madrid",
});

/** La fecha de una partida, en el reloj con el que se filtra: Madrid. */
function formatMatchDate(iso: string): string {
  return MATCH_DATE.format(new Date(iso));
}

/** El día de Madrid de un instante ISO, comparable con un `<input type="date">`. */
function madridDayKey(iso: string): string {
  return MADRID_DAY_KEY.format(new Date(iso));
}

function matchCiv(match: AdminActMatchCandidate): string {
  return match.civLabel ?? match.civ ?? "Sin civilización";
}

function partidas(count: number): string {
  return count === 1 ? "1 partida" : `${count} partidas`;
}

function actuaciones(count: number): string {
  return count === 1 ? "1 actuación" : `${count} actuaciones`;
}

function seleccionadas(count: number): string {
  return count === 1 ? "1 seleccionada" : `${count} seleccionadas`;
}

type ActFormProps = {
  canReverse: boolean;
  participants: ComboboxOption[];
  reversalPlayers: AdminActPlayer[];
  reversalDegraded: boolean;
  initialKind: AdminActKind;
  initialPlayerId: string;
  initialMatches: AdminActMatchCandidate[] | null;
  initialTargetActId: string | null;
};

/**
 * Envoltorio del asistente.
 *
 * Al crear una actuación y pulsar «Crear otra», se remonta el formulario con una
 * `key` nueva: así se limpian de golpe la selección, los filtros y el estado de
 * `useActionState`, sin una función de reseteo que tenga que acordarse de cada
 * campo. Después se refrescan los datos de servidor, porque la lista de
 * actuaciones revertibles y los estados de los jugadores han cambiado.
 */
export function ActForm(props: ActFormProps) {
  const router = useRouter();
  const [resetKey, setResetKey] = useState(0);
  const [blank, setBlank] = useState(false);

  return (
    <ActFormFields
      key={resetKey}
      canReverse={props.canReverse}
      participants={props.participants}
      reversalPlayers={props.reversalPlayers}
      reversalDegraded={props.reversalDegraded}
      initialKind={blank ? "BAN" : props.initialKind}
      initialPlayerId={blank ? "" : props.initialPlayerId}
      initialMatches={blank ? null : props.initialMatches}
      initialTargetActId={blank ? null : props.initialTargetActId}
      onCreated={() => {
        setBlank(true);
        setResetKey((key) => key + 1);
        router.refresh();
      }}
    />
  );
}

function ActFormFields({
  canReverse,
  participants,
  reversalPlayers,
  reversalDegraded,
  initialKind,
  initialPlayerId,
  initialMatches,
  initialTargetActId,
  onCreated,
}: ActFormProps & { onCreated: () => void }) {
  const [state, formAction, pending] = useActionState(
    runAction,
    INITIAL_ADMIN_ACT_FORM_STATE,
  );

  /**
   * Si el servidor rechaza la actuación, se vuelve al formulario para que el
   * error quede junto al campo que lo provocó. El éxito no cierra nada: cambia a
   * la pantalla de resultado, que deja leer el mensaje antes de seguir.
   */
  async function runAction(
    previous: AdminActFormState,
    formData: FormData,
  ): Promise<AdminActFormState> {
    const result = await createAdminActAction(previous, formData);

    if (result.status === "error") {
      setConfirming(false);
    }

    return result;
  }

  const approvedOptions = participants;
  const reversalOptions = useMemo(
    () => reversalPlayers.map((player) => ({ id: player.id, name: player.name })),
    [reversalPlayers],
  );

  const usableInitialKind =
    !canReverse && initialKind === "REVERSAL" ? "BAN" : initialKind;

  const initialPlayerUsable = (
    usableInitialKind === "REVERSAL" ? reversalPlayers : participants
  ).some((player) => player.id === initialPlayerId);

  const initialReversalPlayer =
    reversalPlayers.find((player) => player.id === initialPlayerId) ?? null;
  const initialTargetSelection =
    usableInitialKind === "REVERSAL" &&
    initialPlayerUsable &&
    initialTargetActId !== null &&
    initialReversalPlayer !== null &&
    initialReversalPlayer.activeActs.some((act) => act.id === initialTargetActId)
      ? [initialTargetActId]
      : [];

  const [selectedKind, setSelectedKind] =
    useState<AdminActKind>(usableInitialKind);
  const [playerId, setPlayerId] = useState(initialPlayerUsable ? initialPlayerId : "");
  const [selectedMatchIds, setSelectedMatchIds] = useState<string[]>([]);
  const [selectedTargetIds, setSelectedTargetIds] =
    useState<string[]>(initialTargetSelection);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [civ, setCiv] = useState("");
  const [mode, setMode] = useState("");
  const [publicReason, setPublicReason] = useState("");
  const [privateInfo, setPrivateInfo] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [clientError, setClientError] = useState<string | null>(null);

  const initialMatchData =
    usableInitialKind === "MATCH_ANNULMENT" ? initialMatches : null;
  const [matches, setMatches] = useState<AdminActMatchCandidate[] | null>(
    initialMatchData,
  );
  const [matchesStatus, setMatchesStatus] = useState<LoadStatus>(
    initialMatchData !== null ? "ready" : "idle",
  );
  const [matchesError, setMatchesError] = useState<string | null>(null);
  const [pendingMatches, startMatchesTransition] = useTransition();
  const matchRequest = useRef(0);

  const confirmRef = useRef<HTMLDivElement>(null);
  const successRef = useRef<HTMLDivElement>(null);

  const fieldId = useId();
  const playerErrorId = `${fieldId}-player-error`;
  const publicHintId = `${fieldId}-public-hint`;
  const publicCountId = `${fieldId}-public-count`;
  const publicErrorId = `${fieldId}-public-error`;
  const privateHintId = `${fieldId}-private-hint`;
  const privateCountId = `${fieldId}-private-count`;
  const privateErrorId = `${fieldId}-private-error`;
  const confirmTitleId = `${fieldId}-confirm`;

  const selectedPlayer =
    participants.find((player) => player.id === playerId) ??
    reversalPlayers.find((player) => player.id === playerId) ??
    null;
  const selectedReversalPlayer =
    reversalPlayers.find((player) => player.id === playerId) ?? null;
  const targetCandidates: AdminActTargetCandidate[] =
    selectedKind === "REVERSAL" ? (selectedReversalPlayer?.activeActs ?? []) : [];

  const availableKinds = canReverse
    ? ADMIN_ACT_KINDS
    : ADMIN_ACT_KINDS.filter((kind) => kind !== "REVERSAL");

  const filteredMatches = useMemo(() => {
    if (matches === null) {
      return [];
    }

    return matches.filter((match) => {
      const day = madridDayKey(match.startedAt);

      if (from !== "" && day < from) {
        return false;
      }

      if (to !== "" && day > to) {
        return false;
      }

      if (civ !== "" && matchCiv(match) !== civ) {
        return false;
      }

      if (mode !== "" && match.modeLabel !== mode) {
        return false;
      }

      return true;
    });
  }, [matches, from, to, civ, mode]);

  const civOptions = useMemo(() => {
    const values = new Set((matches ?? []).map(matchCiv));

    return [...values].sort((a, b) => a.localeCompare(b, "es"));
  }, [matches]);

  const modeOptions = useMemo(() => {
    const values = new Set(
      (matches ?? []).map((match) => match.modeLabel).filter((label) => label !== ""),
    );

    return [...values].sort((a, b) => a.localeCompare(b, "es"));
  }, [matches]);

  const visibleIdSet = useMemo(
    () => new Set(filteredMatches.map((match) => match.id)),
    [filteredMatches],
  );
  const selectedOutsideFilter = selectedMatchIds.filter(
    (id) => !visibleIdSet.has(id),
  ).length;
  const allVisibleSelected =
    filteredMatches.length > 0 &&
    filteredMatches.every((match) => selectedMatchIds.includes(match.id));
  const hasMatchFilters = from !== "" || to !== "" || civ !== "" || mode !== "";

  useEffect(() => {
    if (confirming) {
      confirmRef.current?.focus();
    }
  }, [confirming]);

  useEffect(() => {
    if (state.status === "success") {
      successRef.current?.focus();
    }
  }, [state.status]);

  useEffect(
    () => () => {
      matchRequest.current += 1;
    },
    [],
  );

  function loadMatches(id: string) {
    const request = matchRequest.current + 1;
    matchRequest.current = request;

    setMatches(null);
    setMatchesStatus("loading");
    setMatchesError(null);

    startMatchesTransition(async () => {
      const result = await loadAdminActMatches(id);

      if (matchRequest.current !== request) {
        return;
      }

      if (result.status === "ok") {
        setMatches(result.data);
        setMatchesStatus("ready");
      } else {
        setMatchesError(result.message);
        setMatchesStatus("error");
      }
    });
  }

  function selectPlayer(id: string) {
    matchRequest.current += 1;
    setConfirming(false);
    setClientError(null);
    setPlayerId(id);
    setSelectedMatchIds([]);
    setSelectedTargetIds([]);
    setMatches(null);
    setMatchesStatus("idle");
    setMatchesError(null);

    if (selectedKind === "MATCH_ANNULMENT" && id !== "") {
      loadMatches(id);
    }
  }

  function changeKind(next: AdminActKind) {
    if (next === selectedKind) {
      return;
    }

    matchRequest.current += 1;
    setConfirming(false);
    setClientError(null);
    setSelectedKind(next);
    setSelectedMatchIds([]);
    setSelectedTargetIds([]);
    setMatches(null);
    setMatchesStatus("idle");
    setMatchesError(null);

    const options = next === "REVERSAL" ? reversalOptions : approvedOptions;

    if (!options.some((option) => option.id === playerId)) {
      setPlayerId("");
    } else if (next === "MATCH_ANNULMENT" && playerId !== "") {
      loadMatches(playerId);
    }
  }

  function toggleMatch(id: string) {
    setConfirming(false);
    setClientError(null);
    setSelectedMatchIds((current) =>
      current.includes(id)
        ? current.filter((currentId) => currentId !== id)
        : [...current, id],
    );
  }

  function selectVisibleMatches() {
    setConfirming(false);
    setClientError(null);
    setSelectedMatchIds((current) => [
      ...new Set([...current, ...filteredMatches.map((match) => match.id)]),
    ]);
  }

  function clearMatchSelection() {
    setConfirming(false);
    setClientError(null);
    setSelectedMatchIds([]);
  }

  function toggleTarget(id: string) {
    setConfirming(false);
    setClientError(null);
    setSelectedTargetIds((current) =>
      current.includes(id)
        ? current.filter((currentId) => currentId !== id)
        : [...current, id],
    );
  }

  function clearMatchFilters() {
    setFrom("");
    setTo("");
    setCiv("");
    setMode("");
  }

  function review() {
    if (playerId === "") {
      setClientError("Selecciona al participante de la actuación.");
      return;
    }

    if (selectedKind === "MATCH_ANNULMENT" && selectedMatchIds.length === 0) {
      setClientError("Selecciona al menos una partida ganada para anular.");
      return;
    }

    if (selectedKind === "REVERSAL" && selectedTargetIds.length === 0) {
      setClientError("Selecciona al menos una actuación vigente para revertir.");
      return;
    }

    if (publicReason.trim() === "") {
      setClientError("La razón pública es obligatoria: es la que se anuncia.");
      return;
    }

    setClientError(null);
    setConfirming(true);
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    if (pending) {
      event.preventDefault();
      return;
    }

    if (!confirming) {
      event.preventDefault();
      review();
    }
  }

  const showServerErrors = !confirming;
  const hasFieldError = Object.keys(state.errors).some((key) => key !== "form");
  const formError = showServerErrors
    ? (state.errors.form ??
      (state.status === "error" && state.message !== null && !hasFieldError
        ? state.message
        : null))
    : null;

  const publicErrorVisible =
    showServerErrors && state.errors.publicReason !== undefined;
  const privateErrorVisible =
    showServerErrors && state.errors.privateInfo !== undefined;

  const publicDescribedBy = [
    publicHintId,
    publicCountId,
    publicErrorVisible ? publicErrorId : null,
  ]
    .filter((value): value is string => value !== null)
    .join(" ");
  const privateDescribedBy = [
    privateHintId,
    privateCountId,
    privateErrorVisible ? privateErrorId : null,
  ]
    .filter((value): value is string => value !== null)
    .join(" ");

  if (state.status === "success") {
    return (
      <section
        ref={successRef}
        tabIndex={-1}
        role="status"
        className="rounded-lg border border-win/40 bg-win/5 p-5 outline-none sm:p-6"
      >
        <h2 className="font-display text-lg font-semibold text-win">
          Actuación registrada
        </h2>
        <p className="mt-2 max-w-[70ch] text-sm leading-relaxed text-foreground">
          {state.message ?? "La actuación se ha guardado y se ha anunciado."}
        </p>

        <div className="mt-5 flex flex-wrap gap-2">
          {state.actId !== null ? (
            <Link
              href={`/admin/actuaciones/${state.actId}`}
              className="inline-flex h-10 items-center rounded-md bg-accent px-4 text-sm font-semibold text-accent-ink transition-colors hover:bg-accent-strong"
            >
              Ver la actuación
            </Link>
          ) : null}
          <button
            type="button"
            onClick={onCreated}
            className="inline-flex h-10 items-center rounded-md border border-line px-3 text-sm text-foreground transition-colors hover:border-line-strong"
          >
            Crear otra actuación
          </button>
          <Link
            href="/admin/actuaciones"
            className="inline-flex h-10 items-center rounded-md border border-line px-3 text-sm text-muted transition-colors hover:border-line-strong hover:text-foreground"
          >
            Volver al expediente
          </Link>
        </div>
      </section>
    );
  }

  return (
    <form
      action={formAction}
      onSubmit={handleSubmit}
      aria-busy={pending}
      className="flex flex-col gap-5"
    >
      <fieldset disabled={pending} className="flex min-w-0 flex-col gap-5">
        <section className="rounded-lg border border-line bg-surface p-4 sm:p-5">
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor={`${fieldId}-player`}
              className="text-sm font-medium text-foreground"
            >
              Participante
            </label>
            <PlayerCombobox
              inputId={`${fieldId}-player`}
              options={selectedKind === "REVERSAL" ? reversalOptions : approvedOptions}
              value={playerId}
              onChange={selectPlayer}
              allLabel="Selecciona un participante"
              required
              invalid={showServerErrors && state.errors.playerId !== undefined}
              describedBy={[
                `${fieldId}-player-hint`,
                showServerErrors && state.errors.playerId !== undefined
                  ? playerErrorId
                  : null,
              ]
                .filter((value): value is string => value !== null)
                .join(" ")}
            />
            <p id={`${fieldId}-player-hint`} className="text-xs leading-relaxed text-muted">
              {selectedKind === "REVERSAL"
                ? "Solo aparecen los jugadores con actuaciones vigentes que se pueden revertir, incluidos los expulsados."
                : "Solo se ofrecen participantes aprobados: es el estado del que parte una expulsión o una anulación."}
            </p>
            {selectedKind === "REVERSAL" && selectedReversalPlayer !== null ? (
              <p className="text-xs text-muted">
                <span className="text-foreground">
                  {PLAYER_STATUS_LABELS[selectedReversalPlayer.status]}
                </span>
                {" · "}
                {actuaciones(selectedReversalPlayer.activeActs.length)} vigente
                {selectedReversalPlayer.activeActs.length === 1 ? "" : "s"}
              </p>
            ) : null}
            {showServerErrors && state.errors.playerId !== undefined ? (
              <p id={playerErrorId} role="alert" className="text-sm text-loss">
                {state.errors.playerId}
              </p>
            ) : null}
          </div>
        </section>

        <fieldset className="rounded-lg border border-line bg-surface p-4 sm:p-5">
          <legend className="px-1 text-sm font-medium text-foreground">Acción</legend>
          <p className="text-xs leading-relaxed text-muted">
            Una actuación tiene una sola acción. Si necesitas expulsar y anular,
            son dos actuaciones distintas.
          </p>

          <div
            className={`mt-3 grid gap-2 ${
              availableKinds.length === 3 ? "sm:grid-cols-3" : "sm:grid-cols-2"
            }`}
          >
            {availableKinds.map((kind) => {
              const checked = selectedKind === kind;

              return (
                <label
                  key={kind}
                  className={`flex cursor-pointer items-start gap-3 rounded-md border px-3 py-3 transition-colors ${
                    checked
                      ? "border-accent/60 bg-accent/5"
                      : "border-line hover:border-line-strong"
                  }`}
                >
                  <input
                    type="radio"
                    name="kind"
                    value={kind}
                    checked={checked}
                    onChange={() => changeKind(kind)}
                    className="mt-0.5 size-4 shrink-0"
                  />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-foreground">
                      {ADMIN_ACT_KIND_LABELS[kind]}
                    </span>
                    <span className="mt-0.5 block text-xs leading-relaxed text-muted">
                      {KIND_HINTS[kind]}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>

          {showServerErrors && state.errors.kind !== undefined ? (
            <p role="alert" className="mt-2 text-sm text-loss">
              {state.errors.kind}
            </p>
          ) : null}
        </fieldset>

        {selectedKind === "MATCH_ANNULMENT" ? (
          <section className="rounded-lg border border-line bg-surface p-4 sm:p-5">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-sm font-medium text-foreground">
                Partidas a anular
              </h2>
              {matchesStatus === "ready" && matches !== null && matches.length > 0 ? (
                <p className="text-xs text-muted">
                  {partidas(matches.length)} anulable
                  {matches.length === 1 ? "" : "s"} hoy
                </p>
              ) : null}
            </div>
            <p className="mt-1 text-xs leading-relaxed text-muted">
              Solo se ofrecen victorias que hoy puntúan con el ruleset y la ventana
              activos. Las fechas se leen en hora de Madrid.
            </p>

            {playerId === "" ? (
              <p className="mt-3 rounded-md border border-line bg-background px-3 py-3 text-sm text-muted">
                Elige un participante para ver sus victorias anulables.
              </p>
            ) : matchesStatus === "loading" || pendingMatches ? (
              <p
                role="status"
                aria-live="polite"
                className="mt-3 rounded-md border border-line bg-background px-3 py-3 text-sm text-muted"
              >
                Cargando las victorias anulables…
              </p>
            ) : matchesStatus === "error" ? (
              <div className="mt-3 flex flex-col gap-2 rounded-md border border-loss/40 bg-loss/5 px-3 py-3">
                <p role="alert" className="text-sm leading-relaxed text-loss">
                  {matchesError ?? "No se han podido leer las partidas del jugador."}
                </p>
                <button
                  type="button"
                  onClick={() => loadMatches(playerId)}
                  className="inline-flex h-9 w-fit items-center rounded-md border border-loss/40 px-3 text-xs text-loss transition-colors hover:bg-loss/10"
                >
                  Reintentar
                </button>
              </div>
            ) : matchesStatus === "ready" && matches !== null && matches.length === 0 ? (
              <div className="mt-3 rounded-md border border-line bg-background px-3 py-3">
                <p className="text-sm font-medium text-foreground">
                  No tiene victorias anulables con las reglas actuales.
                </p>
                <p className="mt-1 text-xs leading-relaxed text-muted">
                  No hay victorias suyas dentro de la ventana que hoy sumen, así
                  que no hay nada que anular.
                </p>
              </div>
            ) : matchesStatus === "ready" && matches !== null ? (
              <div className="mt-3 flex flex-col gap-3">
                <div className="flex flex-col gap-3 rounded-md border border-line bg-background p-3 sm:flex-row sm:flex-wrap sm:items-end">
                  <div className="flex flex-col gap-1 text-sm">
                    <label htmlFor={`${fieldId}-from`} className="text-muted">
                      Desde
                    </label>
                    <input
                      id={`${fieldId}-from`}
                      type="date"
                      value={from}
                      onChange={(event) => setFrom(event.target.value)}
                      className="h-10 rounded-md border border-line bg-surface px-3 text-foreground"
                    />
                  </div>

                  <div className="flex flex-col gap-1 text-sm">
                    <label htmlFor={`${fieldId}-to`} className="text-muted">
                      Hasta
                    </label>
                    <input
                      id={`${fieldId}-to`}
                      type="date"
                      value={to}
                      onChange={(event) => setTo(event.target.value)}
                      className="h-10 rounded-md border border-line bg-surface px-3 text-foreground"
                    />
                  </div>

                  <div className="flex flex-col gap-1 text-sm sm:w-[190px]">
                    <label htmlFor={`${fieldId}-civ`} className="text-muted">
                      Civilización
                    </label>
                    <select
                      id={`${fieldId}-civ`}
                      value={civ}
                      onChange={(event) => setCiv(event.target.value)}
                      className="h-10 rounded-md border border-line bg-surface px-3 text-foreground"
                    >
                      <option value="">Todas</option>
                      {civOptions.map((option) => (
                        <option key={option} value={option}>
                          {option}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="flex flex-col gap-1 text-sm sm:w-[160px]">
                    <label htmlFor={`${fieldId}-mode`} className="text-muted">
                      Modo
                    </label>
                    <select
                      id={`${fieldId}-mode`}
                      value={mode}
                      onChange={(event) => setMode(event.target.value)}
                      className="h-10 rounded-md border border-line bg-surface px-3 text-foreground"
                    >
                      <option value="">Todos</option>
                      {modeOptions.map((option) => (
                        <option key={option} value={option}>
                          {option}
                        </option>
                      ))}
                    </select>
                  </div>

                  {hasMatchFilters ? (
                    <button
                      type="button"
                      onClick={clearMatchFilters}
                      className="inline-flex h-10 items-center rounded-md border border-line px-3 text-sm text-muted transition-colors hover:border-line-strong hover:text-foreground"
                    >
                      Limpiar filtros
                    </button>
                  ) : null}
                </div>

                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={selectVisibleMatches}
                      disabled={filteredMatches.length === 0 || allVisibleSelected}
                      className="inline-flex h-9 items-center rounded-md border border-line px-3 text-xs text-foreground transition-colors hover:border-line-strong disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      Seleccionar todas las visibles
                    </button>
                    <button
                      type="button"
                      onClick={clearMatchSelection}
                      disabled={selectedMatchIds.length === 0}
                      className="inline-flex h-9 items-center rounded-md border border-line px-3 text-xs text-muted transition-colors hover:border-line-strong hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      Quitar selección
                    </button>
                  </div>

                  <p aria-live="polite" className="text-xs text-muted">
                    {seleccionadas(selectedMatchIds.length)}
                    {selectedOutsideFilter > 0
                      ? ` · ${selectedOutsideFilter} fuera del filtro`
                      : ""}
                  </p>
                </div>

                {filteredMatches.length === 0 ? (
                  <div className="rounded-md border border-line bg-background px-3 py-4 text-center">
                    <p className="text-sm font-medium text-foreground">
                      Ninguna partida coincide con los filtros
                    </p>
                    <p className="mt-1 text-xs text-muted">
                      La selección de fuera del filtro se conserva.
                    </p>
                    <button
                      type="button"
                      onClick={clearMatchFilters}
                      className="mt-3 inline-flex h-9 items-center rounded-md border border-line px-3 text-xs text-foreground transition-colors hover:border-line-strong"
                    >
                      Limpiar filtros
                    </button>
                  </div>
                ) : (
                  <div className="overflow-x-auto overscroll-x-contain rounded-md border border-line bg-background">
                    <table className="w-full text-left text-sm">
                      <caption className="sr-only">
                        Victorias anulables: casilla de selección, fecha, rival,
                        civilización, modo, mapa y puntos. La selección se conserva
                        al cambiar los filtros.
                      </caption>
                      <thead className="bg-surface text-muted">
                        <tr>
                          <th scope="col" className="w-12 px-3 py-2 font-medium">
                            <span className="sr-only">Seleccionar</span>
                          </th>
                          <th scope="col" className="whitespace-nowrap px-3 py-2 font-medium">
                            Fecha
                          </th>
                          <th scope="col" className="px-3 py-2 font-medium">
                            Rival
                          </th>
                          <th scope="col" className="px-3 py-2 font-medium">
                            Civilización
                          </th>
                          <th scope="col" className="px-3 py-2 font-medium">
                            Modo
                          </th>
                          <th scope="col" className="px-3 py-2 font-medium">
                            Mapa
                          </th>
                          <th scope="col" className="px-3 py-2 text-right font-medium">
                            Puntos
                          </th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-line">
                        {filteredMatches.map((match) => {
                          const checked = selectedMatchIds.includes(match.id);

                          return (
                            <tr
                              key={match.id}
                              className={checked ? "bg-accent/[0.06]" : undefined}
                            >
                              <td className="px-3 py-2 align-top">
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  onChange={() => toggleMatch(match.id)}
                                  aria-label={`Seleccionar la partida contra ${
                                    match.opponentName ?? "rival desconocido"
                                  } del ${formatMatchDate(match.startedAt)}`}
                                  className="mt-0.5 size-4"
                                />
                              </td>
                              <td className="whitespace-nowrap px-3 py-2 align-top text-muted">
                                <time
                                  dateTime={match.startedAt}
                                  title={formatMatchDate(match.startedAt)}
                                  className="tabular-nums"
                                >
                                  {formatMatchDate(match.startedAt)}
                                </time>
                              </td>
                              <td className="px-3 py-2 align-top text-foreground">
                                {match.opponentName ?? "—"}
                              </td>
                              <td className="px-3 py-2 align-top">
                                {matchCiv(match)}
                              </td>
                              <td className="px-3 py-2 align-top">
                                {match.modeLabel === "" ? "—" : match.modeLabel}
                              </td>
                              <td className="px-3 py-2 align-top">
                                {match.map ?? "—"}
                              </td>
                              <td className="px-3 py-2 text-right align-top font-medium tabular-nums text-accent">
                                +{match.points}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            ) : (
              <div className="mt-3 rounded-md border border-line bg-background px-3 py-3">
                <p className="text-sm text-muted">
                  {playerId === ""
                    ? "Elige un participante para cargar sus victorias anulables."
                    : "No se han cargado las victorias anulables de este participante."}
                </p>
                {playerId !== "" ? (
                  <button
                    type="button"
                    onClick={() => loadMatches(playerId)}
                    className="mt-2 inline-flex h-9 items-center rounded-md border border-line px-3 text-xs text-foreground transition-colors hover:border-line-strong"
                  >
                    Cargar victorias
                  </button>
                ) : null}
              </div>
            )}

            {showServerErrors && state.errors.matchIds !== undefined ? (
              <p role="alert" className="mt-2 text-sm text-loss">
                {state.errors.matchIds}
              </p>
            ) : null}
          </section>
        ) : null}

        {selectedKind === "REVERSAL" ? (
          <fieldset className="rounded-lg border border-line bg-surface p-4 sm:p-5">
            <legend className="px-1 text-sm font-medium text-foreground">
              Actuaciones a revertir
            </legend>

            <div className="mt-2 rounded-md border border-accent/50 bg-accent/[0.07] px-3 py-2">
              <p className="text-sm font-medium text-foreground">
                Una reversión es final: no se puede revertir.
              </p>
              <p className="mt-1 text-xs leading-relaxed text-muted">
                Si necesitas volver a aplicar la sanción, tendrás que crear otra
                actuación.
              </p>
            </div>

            {reversalDegraded ? (
              <div className="mt-3 rounded-md border border-loss/40 bg-loss/5 px-3 py-3">
                <p role="alert" className="text-sm leading-relaxed text-loss">
                  No se han podido leer las actuaciones revertibles. La lista no se
                  muestra vacía a propósito: sin ella no se puede elegir qué
                  revertir.
                </p>
              </div>
            ) : playerId === "" ? (
              <p className="mt-3 rounded-md border border-line bg-background px-3 py-3 text-sm text-muted">
                Elige un participante para ver sus actuaciones vigentes.
              </p>
            ) : targetCandidates.length === 0 ? (
              <div className="mt-3 rounded-md border border-line bg-background px-3 py-3">
                <p className="text-sm font-medium text-foreground">
                  No tiene actuaciones vigentes que revertir.
                </p>
                <p className="mt-1 text-xs leading-relaxed text-muted">
                  Las reversiones ya son finales y no aparecen; si una actuación
                  fue revertida, tampoco se puede volver a revertir.
                </p>
              </div>
            ) : (
              <>
                <ul className="mt-3 flex flex-col gap-2">
                  {targetCandidates.map((target) => {
                    const checked = selectedTargetIds.includes(target.id);

                    return (
                      <li key={target.id}>
                        <label
                          className={`flex cursor-pointer items-start gap-3 rounded-md border px-3 py-2 transition-colors ${
                            checked
                              ? "border-accent/60 bg-accent/5"
                              : "border-line hover:border-line-strong"
                          }`}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleTarget(target.id)}
                            className="mt-0.5 size-4 shrink-0"
                          />
                          <span className="min-w-0 flex-1">
                            <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                              <AdminActKindBadge kind={target.kind} />
                              <time
                                dateTime={target.createdAt}
                                className="text-xs text-muted tabular-nums"
                              >
                                {formatMatchDate(target.createdAt)}
                              </time>
                            </span>
                            <span className="mt-1 block text-sm font-medium text-foreground">
                              {target.summary}
                            </span>
                            <span className="mt-0.5 line-clamp-2 block text-xs leading-relaxed text-muted">
                              {target.publicReason}
                            </span>
                          </span>
                        </label>
                      </li>
                    );
                  })}
                </ul>

                <p aria-live="polite" className="mt-2 text-xs text-muted">
                  {seleccionadas(selectedTargetIds.length)}
                </p>
              </>
            )}

            {showServerErrors && state.errors.targetActIds !== undefined ? (
              <p role="alert" className="mt-2 text-sm text-loss">
                {state.errors.targetActIds}
              </p>
            ) : null}
          </fieldset>
        ) : null}

        <section className="rounded-lg border border-line bg-surface p-4 sm:p-5">
          <h2 className="text-sm font-medium text-foreground">
            Razón pública y notas internas
          </h2>

          <div className="mt-3 flex flex-col gap-1.5">
            <label htmlFor={`${fieldId}-public`} className="text-sm text-muted">
              Razón pública
            </label>
            <textarea
              id={`${fieldId}-public`}
              name="publicReason"
              rows={5}
              maxLength={ADMIN_ACT_PUBLIC_REASON_MAX_LENGTH}
              required
              value={publicReason}
              onChange={(event) => {
                setConfirming(false);
                setClientError(null);
                setPublicReason(event.target.value);
              }}
              placeholder="Explica el motivo de la actuación. Es el texto que se publica."
              aria-describedby={publicDescribedBy}
              aria-invalid={publicErrorVisible || undefined}
              className={`min-h-28 rounded-md border bg-background px-3 py-2 text-sm leading-relaxed text-foreground placeholder:text-muted ${
                publicErrorVisible ? "border-loss" : "border-line"
              }`}
            />
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
              <p id={publicHintId} className="leading-relaxed">
                Se publicará en #avisos y se enviará por privado al participante.
              </p>
              <p id={publicCountId} aria-live="polite" className="tabular-nums">
                {publicReason.length} / {ADMIN_ACT_PUBLIC_REASON_MAX_LENGTH}
              </p>
            </div>
            {publicErrorVisible ? (
              <p id={publicErrorId} role="alert" className="text-sm text-loss">
                {state.errors.publicReason}
              </p>
            ) : null}
          </div>

          <div className="mt-5 flex flex-col gap-1.5">
            <label htmlFor={`${fieldId}-private`} className="text-sm text-muted">
              Información privada (opcional)
            </label>
            <textarea
              id={`${fieldId}-private`}
              name="privateInfo"
              rows={4}
              maxLength={ADMIN_ACT_PRIVATE_INFO_MAX_LENGTH}
              value={privateInfo}
              onChange={(event) => {
                setConfirming(false);
                setClientError(null);
                setPrivateInfo(event.target.value);
              }}
              placeholder="Notas para la organización: contexto, pruebas, seguimiento."
              aria-describedby={privateDescribedBy}
              aria-invalid={privateErrorVisible || undefined}
              className={`min-h-24 rounded-md border bg-background px-3 py-2 text-sm leading-relaxed text-foreground placeholder:text-muted ${
                privateErrorVisible ? "border-loss" : "border-line"
              }`}
            />
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
              <p id={privateHintId} className="leading-relaxed">
                Solo visible para la organización. Nunca se publica ni se envía a
                Discord.
              </p>
              <p id={privateCountId} aria-live="polite" className="tabular-nums">
                {privateInfo.length} / {ADMIN_ACT_PRIVATE_INFO_MAX_LENGTH}
              </p>
            </div>
            {privateErrorVisible ? (
              <p id={privateErrorId} role="alert" className="text-sm text-loss">
                {state.errors.privateInfo}
              </p>
            ) : null}
          </div>
        </section>
      </fieldset>

      <input type="hidden" name="playerId" value={playerId} />
      {selectedMatchIds.map((id) => (
        <input key={id} type="hidden" name="matchIds" value={id} />
      ))}
      {selectedTargetIds.map((id) => (
        <input key={id} type="hidden" name="targetActIds" value={id} />
      ))}

      {formError !== null ? (
        <p
          role="alert"
          className="rounded-md border border-loss/40 bg-loss/5 px-3 py-2 text-sm leading-relaxed text-loss"
        >
          {formError}
        </p>
      ) : null}

      {clientError !== null ? (
        <p
          role="alert"
          className="rounded-md border border-loss/40 bg-loss/5 px-3 py-2 text-sm leading-relaxed text-loss"
        >
          {clientError}
        </p>
      ) : null}

      {confirming ? (
        <div
          ref={confirmRef}
          tabIndex={-1}
          role="region"
          aria-labelledby={confirmTitleId}
          aria-live="polite"
          className="rounded-lg border border-accent/50 bg-accent/[0.07] p-4 outline-none sm:p-5"
        >
          <h2 id={confirmTitleId} className="text-lg font-semibold text-foreground">
            Revisa la actuación
          </h2>
          <p className="mt-1 text-sm text-muted">
            Todavía no se ha guardado nada. Comprueba el resumen y confirma.
          </p>

          <dl className="mt-4 grid gap-3 sm:grid-cols-2">
            <div>
              <dt className="text-xs text-muted">Participante</dt>
              <dd className="mt-0.5 text-sm font-medium text-foreground">
                {selectedPlayer?.name ?? "Sin participante"}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted">Acción</dt>
              <dd className="mt-0.5 text-sm font-medium text-foreground">
                {ADMIN_ACT_KIND_LABELS[selectedKind]}
              </dd>
            </div>
            {selectedKind === "MATCH_ANNULMENT" ? (
              <div>
                <dt className="text-xs text-muted">Partidas</dt>
                <dd className="mt-0.5 text-sm font-medium text-foreground">
                  {partidas(selectedMatchIds.length)}
                </dd>
              </div>
            ) : null}
            {selectedKind === "REVERSAL" ? (
              <div>
                <dt className="text-xs text-muted">Actuaciones</dt>
                <dd className="mt-0.5 text-sm font-medium text-foreground">
                  {actuaciones(selectedTargetIds.length)}
                </dd>
              </div>
            ) : null}
          </dl>

          <div className="mt-4">
            <p className="text-xs text-muted">Razón pública</p>
            <p className="mt-1 max-h-48 overflow-y-auto whitespace-pre-line rounded-md border border-line bg-surface px-3 py-2 text-sm leading-relaxed text-foreground">
              {publicReason.trim()}
            </p>
          </div>

          {selectedKind === "BAN" ? (
            <p className="mt-3 text-sm leading-relaxed text-muted">
              El participante quedará expulsado del torneo y desaparecerá de la
              clasificación, de la sincronización y de su ficha pública.
            </p>
          ) : null}

          {selectedKind === "MATCH_ANNULMENT" ? (
            <p className="mt-3 text-sm leading-relaxed text-muted">
              Las partidas seleccionadas dejarán de sumar en la clasificación.
            </p>
          ) : null}

          {selectedKind === "REVERSAL" ? (
            <div className="mt-4 rounded-md border border-accent/50 bg-surface px-3 py-2">
              <p className="text-sm font-medium text-foreground">
                Una reversión es final: no se puede revertir.
              </p>
              <p className="mt-1 text-xs leading-relaxed text-muted">
                Si necesitas volver a aplicar la sanción, tendrás que crear otra
                actuación.
              </p>
            </div>
          ) : null}

          <div className="mt-5 flex flex-wrap justify-end gap-2">
            <button
              type="button"
              onClick={() => setConfirming(false)}
              disabled={pending}
              className="inline-flex h-10 items-center rounded-md border border-line px-3 text-sm text-foreground transition-colors hover:border-line-strong disabled:cursor-not-allowed disabled:opacity-60"
            >
              Volver a editar
            </button>
            <button
              type="submit"
              disabled={pending}
              className="inline-flex h-10 items-center rounded-md bg-accent px-4 text-sm font-semibold text-accent-ink transition-colors hover:bg-accent-strong disabled:cursor-not-allowed disabled:opacity-60"
            >
              {pending ? "Guardando…" : "Confirmar y guardar"}
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-muted">
            La actuación se aplica al confirmar. No se puede deshacer: una
            reversión posterior es una actuación nueva.
          </p>
          <button
            type="button"
            onClick={review}
            disabled={pending || pendingMatches}
            className="inline-flex h-10 items-center rounded-md bg-accent px-4 text-sm font-semibold text-accent-ink transition-colors hover:bg-accent-strong disabled:cursor-not-allowed disabled:opacity-60"
          >
            Revisar actuación
          </button>
        </div>
      )}
    </form>
  );
}
