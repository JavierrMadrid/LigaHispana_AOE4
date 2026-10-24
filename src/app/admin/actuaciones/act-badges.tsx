import {
  ADMIN_ACT_KIND_LABELS,
  type AdminActKind,
  type AdminActState,
} from "@/lib/admin-acts";

/**
 * Distintivos de una actuación: el tipo y su estado.
 *
 * El color no es la única señal: cada píldora lleva su palabra. La expulsión usa
 * el rojo de la casa, la anulación el oro del acento y la reversión el verde de lo
 * que vuelve; el estado va en neutro cuando la actuación ya no manda y en el verde
 * de lo vigente o el oro de lo final.
 */
const KIND_STYLES: Record<AdminActKind, string> = {
  BAN: "border-loss/40 text-loss",
  MATCH_ANNULMENT: "border-accent/40 text-accent",
  REVERSAL: "border-win/40 text-win",
};

const STATE_LABELS: Record<AdminActState, string> = {
  active: "Vigente",
  reverted: "Revertida",
  final: "Final",
};

const STATE_STYLES: Record<AdminActState, string> = {
  active: "border-win/40 text-win",
  reverted: "border-line-strong text-muted",
  final: "border-accent/40 text-accent",
};

export function AdminActKindBadge({
  kind,
  className = "",
}: {
  kind: AdminActKind;
  className?: string;
}) {
  return (
    <span
      className={`inline-block whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium ${KIND_STYLES[kind]} ${className}`}
    >
      {ADMIN_ACT_KIND_LABELS[kind]}
    </span>
  );
}

export function AdminActStateBadge({
  state,
  className = "",
}: {
  state: AdminActState;
  className?: string;
}) {
  return (
    <span
      className={`inline-block whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium ${STATE_STYLES[state]} ${className}`}
    >
      {STATE_LABELS[state]}
    </span>
  );
}
