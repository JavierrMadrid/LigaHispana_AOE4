"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

/**
 * Aviso del resultado de una acción con confirmación.
 *
 * El error se queda dentro del diálogo, pegado al botón que lo provocó, porque
 * es ahí donde se está mirando cuando falla. El éxito, en cambio, cierra el
 * diálogo, así que su mensaje necesita un sitio propio: esta banda, encima del
 * contenido, que es lo primero que se ve al volver la vista.
 */
export type ActionNotice = {
  tone: "success" | "error";
  message: string;
};

const ActionFeedbackContext = createContext<(notice: ActionNotice) => void>(() => {});

/**
 * Publica un aviso en la banda del proveedor más cercano.
 *
 * Sin proveedor no pasa nada (la función es un no-op): así un componente de
 * acción se puede montar aislado sin obligar a envolverlo.
 */
export function useActionFeedback() {
  return useContext(ActionFeedbackContext);
}

/**
 * Banda de avisos de las acciones del panel.
 *
 * Va encima de `children` y conserva su estado entre refrescos de la ruta, que
 * es lo que hace que el mensaje sobreviva justo cuando la fila afectada
 * desaparece del listado.
 */
export function ActionFeedbackProvider({ children }: { children: ReactNode }) {
  const [notice, setNotice] = useState<ActionNotice | null>(null);
  const report = useCallback((next: ActionNotice) => setNotice(next), []);
  const value = useMemo(() => report, [report]);

  return (
    <ActionFeedbackContext.Provider value={value}>
      {notice !== null ? (
        <div
          role="status"
          className={`flex items-start justify-between gap-3 rounded-md border px-3 py-2 text-sm ${
            notice.tone === "success"
              ? "border-accent/40 bg-accent/5 text-foreground"
              : "border-loss/40 bg-loss/5 text-loss"
          }`}
        >
          <p className="leading-relaxed">{notice.message}</p>
          <button
            type="button"
            onClick={() => setNotice(null)}
            className="shrink-0 text-xs text-muted underline-offset-4 transition-colors hover:text-foreground hover:underline"
          >
            Cerrar
          </button>
        </div>
      ) : null}
      {children}
    </ActionFeedbackContext.Provider>
  );
}
