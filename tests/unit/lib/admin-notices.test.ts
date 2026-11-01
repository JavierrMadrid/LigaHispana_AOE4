import { describe, expect, it } from "vitest";

import { adminNoticePlan } from "@/lib/admin-notices";

/**
 * El plan de avisos de administración: qué mensajes se pueden mandar.
 *
 * Todo es puro y sin red ni base de datos. Lo que se fija es que el privado y el global
 * sean independientes y que sin token no salga ninguno.
 *
 * Los textos de las actuaciones administrativas (expulsiones, anulaciones y
 * reversiones) se prueban en `admin-acts.test.ts`: tienen su propio módulo porque
 * llevan razón pública.
 */

describe("adminNoticePlan", () => {
  it("sin token no se puede avisar de nada", () => {
    expect(adminNoticePlan({ hasToken: false, hasAccount: true, hasChannel: true })).toEqual({
      dm: false,
      channel: false,
    });
  });

  it("con token, cuenta y canal salen los dos", () => {
    expect(adminNoticePlan({ hasToken: true, hasAccount: true, hasChannel: true })).toEqual({
      dm: true,
      channel: true,
    });
  });

  it("sin cuenta no hay privado, pero sí global", () => {
    expect(adminNoticePlan({ hasToken: true, hasAccount: false, hasChannel: true })).toEqual({
      dm: false,
      channel: true,
    });
  });

  it("sin canal no hay global, pero sí privado", () => {
    expect(adminNoticePlan({ hasToken: true, hasAccount: true, hasChannel: false })).toEqual({
      dm: true,
      channel: false,
    });
  });

  it("sin cuenta ni canal no hay ninguno", () => {
    expect(adminNoticePlan({ hasToken: true, hasAccount: false, hasChannel: false })).toEqual({
      dm: false,
      channel: false,
    });
  });
});
