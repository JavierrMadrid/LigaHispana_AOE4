import { describe, expect, it } from "vitest";

import {
  isSuperadminEmail,
  normalizeAdminEmail,
  resolveAdminAccess,
} from "@/lib/admin-access";

/**
 * La decisión de quién entra al panel.
 *
 * Es la puerta de `/admin`, así que sus reglas se fijan aquí: la normalización del
 * correo (una sola forma para comparar), que el superadministrador salga del entorno
 * y no de la tabla, y que una fila **inactiva** no deje entrar. Son funciones puras:
 * ni base de datos, ni entorno, ni red.
 */

describe("normalizeAdminEmail", () => {
  it("quita espacios y baja a minúsculas", () => {
    expect(normalizeAdminEmail("  Beast@Correo.COM ")).toBe("beast@correo.com");
  });

  it("dos formas del mismo correo dan la misma clave", () => {
    expect(normalizeAdminEmail("PEDRO@Correo.com")).toBe(normalizeAdminEmail(" pedro@correo.com "));
  });
});

describe("isSuperadminEmail", () => {
  it("reconoce el correo aunque la variable venga con otra caja o con espacios", () => {
    expect(isSuperadminEmail("jefe@correo.com", " Jefe@Correo.com ")).toBe(true);
  });

  it("sin variable configurada, nadie es superadministrador", () => {
    expect(isSuperadminEmail("jefe@correo.com", null)).toBe(false);
    expect(isSuperadminEmail("jefe@correo.com", undefined)).toBe(false);
  });

  it("una variable vacía no convierte en superadmin a un correo vacío", () => {
    expect(isSuperadminEmail("", "")).toBe(false);
    expect(isSuperadminEmail("", "   ")).toBe(false);
  });

  it("un correo distinto no lo es", () => {
    expect(isSuperadminEmail("otro@correo.com", "jefe@correo.com")).toBe(false);
  });
});

describe("resolveAdminAccess", () => {
  it("el correo del superadministrador es superadmin aunque no tenga fila", () => {
    expect(
      resolveAdminAccess({
        email: "jefe@correo.com",
        superadminEmail: "jefe@correo.com",
        admins: [],
      }),
    ).toBe("superadmin");
  });

  it("una fila activa da admin", () => {
    expect(
      resolveAdminAccess({
        email: "pedro@correo.com",
        superadminEmail: "jefe@correo.com",
        admins: [{ email: "pedro@correo.com", active: true }],
      }),
    ).toBe("admin");
  });

  it("una fila inactiva no deja entrar", () => {
    expect(
      resolveAdminAccess({
        email: "pedro@correo.com",
        superadminEmail: "jefe@correo.com",
        admins: [{ email: "pedro@correo.com", active: false }],
      }),
    ).toBe("none");
  });

  it("sin fila no hay acceso", () => {
    expect(
      resolveAdminAccess({
        email: "nadie@correo.com",
        superadminEmail: "jefe@correo.com",
        admins: [{ email: "pedro@correo.com", active: true }],
      }),
    ).toBe("none");
  });

  it("la comparación del correo es sobre la forma canónica", () => {
    expect(
      resolveAdminAccess({
        email: "  Pedro@Correo.com ",
        superadminEmail: null,
        admins: [{ email: "pedro@correo.com", active: true }],
      }),
    ).toBe("admin");
  });

  it("sin superadministrador configurado, sigue habiendo admins por fila", () => {
    expect(
      resolveAdminAccess({
        email: "pedro@correo.com",
        superadminEmail: null,
        admins: [{ email: "pedro@correo.com", active: true }],
      }),
    ).toBe("admin");
  });

  it("un correo vacío no entra aunque haya filas activas", () => {
    expect(
      resolveAdminAccess({
        email: "",
        superadminEmail: null,
        admins: [{ email: "", active: true }],
      }),
    ).toBe("none");
  });

  it("si el correo es el del superadmin, lo es aunque haya una fila suya inactiva", () => {
    // El entorno manda: la baja de una fila no puede quitar el superadministrador.
    expect(
      resolveAdminAccess({
        email: "jefe@correo.com",
        superadminEmail: "jefe@correo.com",
        admins: [{ email: "jefe@correo.com", active: false }],
      }),
    ).toBe("superadmin");
  });
});
