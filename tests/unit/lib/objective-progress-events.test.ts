import { describe, expect, it } from "vitest";

import { ObjectiveProgressKind } from "@/generated/prisma/enums";
import type { ScoringWindow } from "@/lib/ranked-match";
import { objectiveProgressEventAt } from "@/lib/objective-progress-events";

/**
 * El instante de un evento del feed del progreso: la parte pura de
 * `src/lib/objective-progress-events.ts`.
 *
 * La reconciliación entera es Prisma (leer el estado de la edición, comparar,
 * escribir la diferencia) y se comprueba con datos de verdad; lo que se decide sin
 * base de datos es **qué fecha lleva el evento**, que es lo que este fichero cubre.
 *
 * La regla: `at` es el instante del recálculo salvo en la siembra de un logro con la
 * ventana ya cerrada, donde es `window.to` porque ahí el torneo lo dio por cumplido.
 */

/** El pase que se está simulando: después del cierre de la ventana de prueba. */
const NOW = new Date("2026-10-20T12:00:00.000Z");

/** Una ventana cerrada antes de `NOW`. */
const CERRADA: ScoringWindow = {
  from: "2026-09-15T00:00:00.000Z",
  to: "2026-10-15T00:00:00.000Z",
};

/** La misma ventana, todavía abierta por la derecha. */
const ABIERTA: ScoringWindow = { from: "2026-09-15T00:00:00.000Z", to: null };

/** Un `to` que todavía no ha llegado. */
const FUTURA: ScoringWindow = { from: "2026-09-15T00:00:00.000Z", to: "2026-11-15T00:00:00.000Z" };

/** Un `to` que no se puede leer. */
const ILEGIBLE: ScoringWindow = { from: "2026-09-15T00:00:00.000Z", to: "el viernes" };

/** Un logro del catálogo (`kind: "achievement"`). */
const LOGRO = "imparable";

/** Una competición del catálogo (`kind: "competition"`). */
const COMPETICION = "loco-por-ganar";

describe("objectiveProgressEventAt: qué fecha lleva el evento", () => {
  it("la siembra de un logro con la ventana cerrada se fecha en `window.to`", () => {
    const at = objectiveProgressEventAt(
      { kind: ObjectiveProgressKind.CUMPLIDO, objectiveId: LOGRO },
      true,
      CERRADA,
      NOW,
    );

    expect(at.toISOString()).toBe("2026-10-15T00:00:00.000Z");
  });

  it("la siembra de un logro con la ventana abierta se fecha en el pase", () => {
    const at = objectiveProgressEventAt(
      { kind: ObjectiveProgressKind.CUMPLIDO, objectiveId: LOGRO },
      true,
      ABIERTA,
      NOW,
    );

    expect(at).toBe(NOW);
  });

  it("la siembra de un logro con un `to` futuro se fecha en el pase", () => {
    const at = objectiveProgressEventAt(
      { kind: ObjectiveProgressKind.CUMPLIDO, objectiveId: LOGRO },
      true,
      FUTURA,
      NOW,
    );

    expect(at).toBe(NOW);
  });

  it("la siembra de un logro con un `to` ilegible se fecha en el pase", () => {
    const at = objectiveProgressEventAt(
      { kind: ObjectiveProgressKind.CUMPLIDO, objectiveId: LOGRO },
      true,
      ILEGIBLE,
      NOW,
    );

    expect(at).toBe(NOW);
  });

  it("la siembra de una competición se fecha en el pase aunque la ventana esté cerrada", () => {
    const at = objectiveProgressEventAt(
      { kind: ObjectiveProgressKind.CUMPLIDO, objectiveId: COMPETICION },
      true,
      CERRADA,
      NOW,
    );

    expect(at).toBe(NOW);
  });

  it("la siembra de un avance parcial se fecha en el pase aunque sea un logro cerrado", () => {
    const at = objectiveProgressEventAt(
      { kind: ObjectiveProgressKind.PROGRESADO, objectiveId: LOGRO },
      true,
      CERRADA,
      NOW,
    );

    expect(at).toBe(NOW);
  });

  it("un cumplimiento que no es siembra se fecha en el pase", () => {
    const at = objectiveProgressEventAt(
      { kind: ObjectiveProgressKind.CUMPLIDO, objectiveId: LOGRO },
      false,
      CERRADA,
      NOW,
    );

    expect(at).toBe(NOW);
  });
});
