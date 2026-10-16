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

  /**
   * La ficha de un participante paso de `/objetivos/<profileId>` a
   * `/detalle-jugador/<profileId>`, que es su ruta canonica: la ficha ya no es
   * solo de objetivos —tiene dos vistas, objetivos e historial de puntos— y la
   * vieja colgaba del catalogo sin serlo.
   *
   * Los enlaces internos ya apuntan a la ruta nueva; esto es para las URLs que
   * viven fuera del sitio (buscadores, historiales, lo que alguien compartiera).
   * Es permanente porque el cambio de ruta tambien lo es, y los parametros de la
   * URL se conservan: `/objetivos/123?page=2` lleva a
   * `/detalle-jugador/123?page=2`.
   */
  async redirects() {
    return [
      {
        source: "/objetivos/:profileId",
        destination: "/detalle-jugador/:profileId",
        permanent: true,
      },
    ];
  },
};

export default nextConfig;
