import type { Metadata } from "next";
import Link from "next/link";
import { EmptyState } from "@/components/empty-state";
import { getAdminParticipants } from "@/lib/admin";
import {
  readAdminActKind,
  type AdminActKind,
  type AdminActMatchCandidate,
  type AdminActPlayer,
} from "@/lib/admin-acts";
import {
  getAdminActMatchCandidates,
  getAdminActPlayers,
} from "@/lib/admin-acts-read";
import { getAdminAccess, requireAdmin } from "@/lib/auth";
import { ActForm } from "./act-form";

export const metadata: Metadata = {
  title: { absolute: "Nueva actuación · Admin" },
};

/** Un valor de `searchParams` reducido a texto. */
function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Alta de una actuación administrativa.
 *
 * La página resuelve los permisos y las lecturas que el formulario necesita; el
 * formulario es cliente porque la selección de partidas y de actuaciones vive en
 * estado de React y sobrevive a los filtros. La reversión solo se ofrece al
 * superadministrador: si la URL pide una y quien entra no lo es, el formulario
 * arranca en expulsión.
 *
 * Los datos de la reversión se cargan aparte de los participantes aprobados: la
 * lista de reversión incluye a los expulsados y a quien tenga actuaciones
 * vigentes, que es justo el estado del que se sale revirtiendo. Si esa lectura
 * degrada, el formulario sigue sirviendo para expulsar o anular y la sección de
 * reversión explica que no se ha podido leer.
 */
export default async function NewAdminActPage({
  searchParams,
}: PageProps<"/admin/actuaciones/nueva">) {
  await requireAdmin();

  const canReverse = (await getAdminAccess()) === "superadmin";
  const params = await searchParams;

  const [participantsRead, actPlayersRead] = await Promise.all([
    getAdminParticipants(),
    canReverse
      ? getAdminActPlayers()
      : Promise.resolve({ status: "ok" as const, data: [] as AdminActPlayer[] }),
  ]);

  const cabecera = (
    <header className="flex flex-col gap-3">
      <Link
        href="/admin/actuaciones"
        className="text-sm text-muted underline-offset-4 transition-colors hover:text-accent hover:underline"
      >
        Volver a Actuaciones
      </Link>
      <div>
        <h1 className="text-2xl font-semibold">Nueva actuación</h1>
        <p className="mt-1 max-w-[70ch] text-sm text-muted">
          {canReverse
            ? "Registra una expulsión, una anulación de partidas ganadas o una reversión."
            : "Registra una expulsión o una anulación de partidas ganadas."}{" "}
          La actuación se aplica al guardar y se anuncia en el canal de avisos y por
          privado al participante. Cada actuación tiene una sola acción: si
          necesitas dos, se crean por separado.
        </p>
      </div>
    </header>
  );

  if (participantsRead.status === "degraded") {
    return (
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
        {cabecera}
        <EmptyState
          title="No se han podido leer los participantes"
          body="La base de datos no ha respondido. Sin la lista de aprobados no se puede elegir a quién expulsar ni a quién anular partidas. Vuelve a intentarlo en unos minutos."
        />
      </div>
    );
  }

  const participants = participantsRead.data
    .filter((player) => player.status === "APPROVED")
    .map((player) => ({ id: player.id, name: player.name }));

  const reversalPlayers = actPlayersRead.status === "ok" ? actPlayersRead.data : [];
  const reversalDegraded = actPlayersRead.status === "degraded";

  const requestedKind = readAdminActKind(single(params.accion)) ?? "BAN";
  const initialKind: AdminActKind =
    !canReverse && requestedKind === "REVERSAL" ? "BAN" : requestedKind;
  const initialPlayerId = single(params.participante) ?? "";
  const initialTargetActId =
    canReverse && initialKind === "REVERSAL"
      ? (single(params.actuacion) ?? null)
      : null;

  const initialPlayerIsApproved =
    initialKind === "MATCH_ANNULMENT" &&
    participants.some((player) => player.id === initialPlayerId);

  const initialMatchesRead = initialPlayerIsApproved
    ? await getAdminActMatchCandidates(initialPlayerId)
    : null;
  const initialMatches: AdminActMatchCandidate[] | null =
    initialMatchesRead?.status === "ok" ? initialMatchesRead.data : null;

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
      {cabecera}

      <ActForm
        canReverse={canReverse}
        participants={participants}
        reversalPlayers={reversalPlayers}
        reversalDegraded={reversalDegraded}
        initialKind={initialKind}
        initialPlayerId={initialPlayerId}
        initialMatches={initialMatches}
        initialTargetActId={initialTargetActId}
      />
    </div>
  );
}
