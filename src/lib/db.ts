import "server-only";

import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";

/**
 * Cliente de Prisma, **perezoso**.
 *
 * Antes se construía al importar este módulo. Eso obligaba a que `next build`
 * tuviera `DATABASE_URL`: al recopilar los datos de página Next importa las
 * rutas, el import creaba el cliente y el build moría con "DATABASE_URL no está
 * definida" si la variable no estaba en el entorno de compilación. Creándolo en
 * la primera llamada, importar `db` no toca la base y el build deja de
 * necesitar el secreto de la base de datos.
 *
 * La caché es la de siempre: una instancia por proceso en producción y una
 * guardada en `globalThis` fuera de ella, para que el hot reload de Next no
 * abra una conexión nueva en cada recarga.
 */

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

let porProceso: PrismaClient | undefined;

function createPrismaClient(): PrismaClient {
  const connectionString = process.env.DATABASE_URL;

  if (!connectionString) {
    throw new Error("DATABASE_URL no está definida.");
  }

  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}

function prisma(): PrismaClient {
  if (process.env.NODE_ENV !== "production") {
    globalForPrisma.prisma ??= createPrismaClient();

    return globalForPrisma.prisma;
  }

  porProceso ??= createPrismaClient();

  return porProceso;
}

/**
 * Proxy que hace de cliente sin instanciarlo: cada acceso resuelve el cliente
 * real y devuelve el método **ligado a él**, para que los campos privados de
 * `PrismaClient` sigan viendo su propio `this` y no el del proxy.
 */
export const db = new Proxy({} as PrismaClient, {
  get(_target, property) {
    const client = prisma();
    const value: unknown = Reflect.get(client, property);

    return typeof value === "function" ? value.bind(client) : value;
  },
});
