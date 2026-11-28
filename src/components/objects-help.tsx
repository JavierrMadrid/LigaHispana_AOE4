"use client";

import { useId, useState } from "react";
import Link from "next/link";
import { ArrowUpRight } from "@phosphor-icons/react/dist/csr/ArrowUpRight";
import { Info } from "@phosphor-icons/react/dist/csr/Info";
import { Modal } from "@/components/modal";
import { ObjectIcon } from "@/components/object-icon";
import type { ObjectKind } from "@/generated/prisma/enums";

/** Un objeto del catálogo, ya resuelto a texto plano para el cliente. */
export type ObjectHelpEntry = {
  kind: ObjectKind;
  name: string;
  /** Con qué victoria se obtiene, tal como lo redacta `OBJECT_CATALOG`. */
  obtainedBy: string;
  penalties: readonly { id: string; text: string }[];
};

/**
 * Botón de información de `/objetos` y la ventana que abre.
 *
 * La explicación de qué es un objeto no cabe en la columna de contexto de 192 px
 * sin convertirla en un párrafo de pie, y abrirla sobre el feed le quitaba el
 * sitio a lo que se viene a leer: el historial. Vive en un modal que abre un
 * botón bajo el resumen, y la columna conserva lo que se consulta mientras se
 * lee el feed —el resumen, el selector local, la leyenda de tipos de evento y el
 * enlace a la puntuación—.
 *
 * Es cliente porque abre y cierra un estado; el catálogo entra por prop ya
 * resuelto desde el servidor (`OBJECT_CATALOG`), así que el texto de las
 * desventajas no se duplica aquí y el bundle del navegador no toca Prisma. Toda
 * la mecánica del diálogo —foco, `Esc`, clic en el fondo, bloqueo del scroll y
 * devolución del foco al botón— la pone `Modal`.
 */
export function ObjectsHelp({ objects }: { objects: readonly ObjectHelpEntry[] }) {
  const [open, setOpen] = useState(false);
  const titleId = useId();
  const leadId = useId();

  return (
    <div className="objects-help">
      <button
        type="button"
        className="objects-help-trigger"
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        <Info size={18} aria-hidden="true" />
        <span>Cómo funcionan los objetos</span>
      </button>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        labelledBy={titleId}
        describedBy={leadId}
        closeLabel="Cerrar la información de los objetos"
        className="objects-help-dialog"
      >
        <header className="objects-help-head">
          <p className="objects-help-eyebrow">Objetos de la edición</p>
          <h2 id={titleId}>Cómo funcionan los objetos</h2>
          <p id={leadId} className="objects-help-lead">
            Una carga que se gana con la victoria del día y llega con una desventaja.
          </p>
        </header>

        {/* El cuerpo desplazable recibe el foco para que se pueda recorrer con el
            teclado: la ventana no tiene otros controles hasta el pie. */}
        <div className="objects-help-body" tabIndex={0}>
          <section className="objects-help-step">
            <h3>
              <span aria-hidden="true">01</span>Cómo se gana
            </h3>
            <p>
              Cada día UTC reparte como mucho un objeto de cada tipo. Lo gana la
              primera partida del día que termina con la victoria que lo desbloquea.
            </p>
            <p className="objects-help-footnote">
              La retirada del rival también cuenta si es temprana: con 3 minutos o
              menos, como victoria sagrada; entre 3 y 5 minutos, como victoria por
              maravilla.
            </p>
          </section>

          <section className="objects-help-step">
            <h3>
              <span aria-hidden="true">02</span>Mientras lo lleva
            </h3>
            <p>
              El portador carga con una de las tres desventajas del objeto. Mientras
              no la cumpla, sus partidas no puntúan: quedan fuera de la clasificación
              y de los objetivos, aunque se jueguen y se registren.
            </p>
          </section>

          <section className="objects-help-step">
            <h3>
              <span aria-hidden="true">03</span>Lanzar y devolver
            </h3>
            <p>
              El portador puede lanzar el objeto a otro participante; la desventaja
              viaja con el objeto y el nuevo portador queda en la misma situación.
            </p>
            <p>
              Si se lo devuelven, la desventaja se queda con quien lo lanzó y el
              objeto se pierde: no vuelve a su mano.
            </p>
          </section>

          <section className="objects-help-step">
            <h3>
              <span aria-hidden="true">04</span>Cómo se cumple
            </h3>
            <p>
              El portador supera la desventaja en una partida y la organización lo
              valida sobre esa partida concreta. Desde ella, sus partidas vuelven a
              puntuar.
            </p>
          </section>

          <section className="objects-help-step">
            <h3>Los tres objetos</h3>
            <p>
              Cada objeto reparte por sorteo una de sus tres desventajas posibles.
            </p>

            <ul className="objects-help-catalog">
              {objects.map((entry) => (
                <li key={entry.kind} className="objects-help-object">
                  <div className="objects-help-object-head">
                    <span className="objects-help-object-icon">
                      <ObjectIcon kind={entry.kind} className="size-5 shrink-0" />
                    </span>
                    <div className="objects-help-object-title">
                      <h4>{entry.name}</h4>
                      <p>Se gana con {entry.obtainedBy}.</p>
                    </div>
                  </div>

                  <ul className="objects-help-penalties">
                    {entry.penalties.map((penalty) => (
                      <li key={penalty.id}>{penalty.text}</li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          </section>
        </div>

        <footer className="objects-help-footer">
          <Link href="/reglas#objetos">
            Reglas de los objetos
            <ArrowUpRight size={14} aria-hidden="true" />
          </Link>
          <Link href="/puntuacion">
            Cómo se puntúa
            <ArrowUpRight size={14} aria-hidden="true" />
          </Link>
        </footer>
      </Modal>
    </div>
  );
}
