import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // `pg-cloudflare` publica su socket de Cloudflare solo bajo la condicion de
  // exports "workerd", y la rama que ve Node (la que usa el trazador de ficheros
  // de Next) es un modulo vacio. Al trazar, nft solo se lleva `package.json` y
  // `dist/empty.js`, pero el empaquetador de OpenNext si resuelve con la
  // condicion "workerd" y busca `dist/index.js`, que no esta copiado: el build
  // del Worker muere con 'Could not resolve "pg-cloudflare"'.
  // Estas dos globs meten en el trace la rama de workerd, que es la que se
  // empaqueta y la que hace falta en runtime para abrir el socket TCP.
  outputFileTracingIncludes: {
    "/*": ["node_modules/pg-cloudflare/dist/**/*", "node_modules/pg-cloudflare/esm/**/*"],
  },
};

export default nextConfig;
