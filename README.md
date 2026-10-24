<p align="center">
  <img src="src/app/opengraph-image.jpg" alt="Liga Hispana — Age of Empires IV" width="640">
</p>

<h1 align="center">Liga Hispana · Age of Empires IV</h1>

<p align="center">
  Seguimiento del torneo individual de Age of Empires IV: clasificación, partidas en directo,
  objetivos especiales, puntuación, streams de los participantes y reglas.
</p>

<p align="center">
  <a href="https://laligahispana.es"><b>Sitio en vivo</b></a> ·
  <a href="docs/REGLAS.md">Reglas</a> ·
  <a href="docs/PUNTUACION.md">Puntuación</a> ·
  <a href="docs/OBJETIVOS.md">Objetivos</a>
</p>

<p align="center">
  <a href="https://github.com/JavierrMadrid/LigaHispana_AOE4/actions/workflows/ci.yml">
    <img src="https://github.com/JavierrMadrid/LigaHispana_AOE4/actions/workflows/ci.yml/badge.svg" alt="CI">
  </a>
</p>

---

## Qué es

Un torneo **individual** de Age of Empires IV. No hay equipos: cada persona compite con su propia
cuenta y la clasificación se calcula **sola** a partir de las partidas que publica la API de
[AoE4World](https://aoe4world.com/api), sin que nadie apunte resultados a mano.

La web es el marcador del torneo: se entra a ver quién va primero, qué partidas están en juego ahora
mismo y quién está en directo.

## Qué ofrece la web

| Página | Qué se ve |
|---|---|
| **Clasificación** (`/`) | La tabla del torneo: puesto, jugador, partidas, puntos desglosados en permanentes (los logros, con las victorias dentro porque son el objetivo Victorias) y temporales (competiciones), elo con su rango de liga, V-D y racha; además, quién está en directo y cuánto queda de torneo. Se busca por nombre o canal, se filtra por estado y por varias divisiones a la vez, y pulsar los puntos de un jugador despliega su resumen de objetivos, con enlace a su ficha y cada objetivo del resumen abriendo su clasificación en una ventana volteable. Cuando el ruleset activo todavía no se ha recalculado, se muestra la última clasificación calculada y una nota sobre la tabla lo dice. |
| **Partidas** (`/partidas`) | Las partidas que los participantes están jugando en este momento, con el mapa, el tipo de partida y quién está en directo enlazando a su retransmisión de Twitch, YouTube o Kick. Se filtran por tipo de partida, por varias divisiones a la vez y por «en directo» (solo las que se pueden ver), y cuando dos participantes de la misma partida emiten a la vez la tarjeta lleva al visor multi-stream con sus canales. |
| **Objetivos** (`/objetivos`) | Los objetivos activos (hoy 88: 29 competiciones y 59 logros), con sus puntos y quién los cobra. Los de civilización se agrupan por familia (la cabeza y sus subobjetivos, con un filtro de banderas para saltar a cada uno y un riel que se recorre con la rueda, el gesto táctil o dos botones de flecha); las 23 competiciones `Masterizando <civ>` —que no tienen cabeza— van en su propio carrusel, «Masterizando», con el mismo filtro de banderas y riel. La tarjeta de la cabeza explica cómo puntúa el conjunto y cada tarjeta abre una ventana volteable: de primeras se ve la clasificación —solo quien disputa el objetivo—, con su avance (`12/23` civilizaciones, `2/3` victorias o el valor de su métrica en una competición) sobre una barra de fondo que lo compara con el líder de la lista, un check en quien lo ha completado —ninguno en un objetivo sin tope, que lo cobra todo el que suma— y el recuento de completadores sobre el total («3 de 12 lo han completado»); quien todavía no ha empezado la participación no sale en la lista, y su censo está en la clasificación del torneo. Al girarla aparece el resumen de la propia tarjeta, recompuesto en una columna centrada alrededor del emblema del objetivo, que se enseña en grande en un medallón: el arte de la civilización cuando el objetivo es de civilización y el glifo propio de la casa en el resto. Las tarjetas encienden un halo dorado al pasar el ratón y dejan una estela dorada que sigue al cursor por dentro. |
| **Detalle de un participante** (`/detalle-jugador/<id>`) | Quién es un jugador y cómo va, en dos pestañas que son dos rutas: **Objetivos** e **Historial de puntos**. La cabecera —avatar, nombre con su emblema de liga, enlace a su perfil de AoE4World y las cifras de cabecera— es común a las dos. En **Objetivos** está su avance en los objetivos activos: una entradilla con el más cercano, el índice de secciones y los individuales en tres bloques —Al alcance (ordenado de más a menos cerca de cobrarlo), En posesión y Sin disputar—; dentro de "Al alcance", tras sus tarjetas, los de civilización se agrupan en los carruseles de Líder y Acólito, con el mismo riel y filtro de banderas que `/objetivos` pero con el avance del jugador y ordenados de mayor a menor porcentaje de consecución, y la tarjeta de la cabeza de familia resume su avance civilización por civilización —la lista más corta de las dos, las hechas o las que quedan, con su bandera y la unidad de la cifra: partidas en Jugón, victorias en Polifacético—. En «Por tierra y agua», los mapas que le faltan sustituyen al pool entero («Faltan 3 mapas · 2 × Golden Heights, …») y un objetivo repetible lleva sus repeticiones en el rótulo (`2 x Imparable`, `24 x Victorias`), con lo que ha cobrado de verdad en cada cifra. Al pulsar una tarjeta se abre su clasificación en una ventana volteable: cada fila lleva su avance sobre una barra de fondo que lo compara con el umbral o con el líder, la del jugador de la ficha se distingue con la etiqueta «Tú» —la ventana no tiñe ninguna fila— y, en «Por tierra y agua», lo que le falta encabeza la lista, entre la cabecera y la clasificación; en los logros de familia, el avance por civilización ocupa ese mismo sitio; al girarla aparece su resumen, con el mismo detalle de mapas o de civilizaciones. En **Historial de puntos** está su feed de puntos, el mismo que el global pero de un solo jugador, con filtro de fechas y paginación. La ruta vieja (`/objetivos/<id>`) redirige aquí de forma permanente. |
| **Puntuación** (`/puntuacion`) | Cuánto vale cada victoria y cómo la multiplica un evento puntual, qué cuenta como partida clasificatoria, los objetivos especiales y los desempates. Las cifras (puntos por victoria, objetivos activos y su total, premio base) salen del ruleset y de la edición activos. |
| **Historial de puntos** (`/historial`) | El historial de puntos del torneo: cada victoria clasificatoria y cada logro cumplido, más los cambios de liderazgo de las competiciones —«ahora lidera» y «ya no lidera»—, de lo más reciente a lo más antiguo, paginados en servidor. Se filtra por participante y por rango de fechas (el día final entra completo), y se llega desde Puntuación. Cada participante tiene además su propio historial en su detalle. El bono de los eventos puntuales no sale en el historial: se suma al total de la clasificación. Una ganancia revertida por la organización sale tachada y marcada con texto, y no suma. Los liderazgos de las competiciones se registran en vivo durante el torneo; los logros, que se resuelven en caliente, se apuntan cuando el torneo termina. |
| **Reglas** (`/reglas`) | Las normas del torneo: formato, participación, eventos puntuales con su calendario y su multiplicador, normas de obligado cumplimiento y organización. La retransmisión en directo se lista solo cuando la edición la exige, y la sección de organización anuncia el premio base y las donaciones cuando están publicados. |
| **Participar** (`/participar`) | La inscripción pública al torneo. |

Además, cuando la organización tiene publicada una campaña, todas las páginas públicas muestran arriba
un **banner de donaciones** con el enlace a Matcherino. Mientras un **evento puntual** está en curso, su
banner aparece por encima de ese aviso, con el multiplicador, las fechas y el requisito de Discord, y
lleva al calendario de Reglas.

La organización tiene además un **panel de administración** para aprobar participantes, revisar
partidas y alertas, gestionar el torneo y publicar la campaña de donaciones. La pestaña
**Actuaciones** es el expediente de la organización: registra **expulsiones**, **anulaciones de
partidas ganadas** y **reversiones**, cada una con su razón pública —que se anuncia en el canal de
avisos y por privado al participante— y, si hace falta, una información privada que nunca sale del
panel. Una reversión es final y no se puede revertir. El **superadministrador** configura además la
**edición**: su nombre y su premio base, la marca (emblema y color de acento) que se
aplica a la web pública, si la retransmisión es obligatoria, las reglas de puntuación (ventana,
familias, puntos y objetivos desactivados) y los **eventos puntuales**, todo sin desplegar. También
puede **deshacer** lo que hicieron los admins regulares.

Un **bot de Discord** avisa del comienzo y el final del torneo en el canal de avisos, una sola vez por
aviso, con el nombre de la edición y sus fechas. También recuerda cada **evento puntual** 24, 12 y 1 hora
antes de que empiece, y el mensaje de comienzo incluye el resumen del calendario de eventos.

## Cómo se compite

- **Individual, en la ladder *ranked*** del juego: 1v1 y ranked por equipos. El resto de modos no
  puntúa.
- **Los puntos del ruleset activo**: por defecto **2 por victoria**, que se cobran como el objetivo
  **Victorias**, más los demás **objetivos activos** (hoy 88) que reparten puntos extra:
  **competiciones** (los cobra quien va primero) y **logros** (los cobra quien cumple la condición).
- **Ventana de fechas**: solo cuentan las partidas jugadas dentro del periodo del torneo.
- **Eventos puntuales**: ventanas programadas antes del torneo en las que cada victoria paga un
  multiplicador, aplicado solo a los puntos por victoria. Algunos exigen estar en el Discord al
  empezar el evento.
- **Equipos equilibrados**: una partida por equipos solo cuenta si ningún compañero está a dos
  escalones o más de división del jugador, por encima o por debajo.
- **Transparencia**: la organización vigila comportamientos que podrían inflar la clasificación
  (abandonar para bajar de elo, rivales repetidos…) y avisa para revisarlos.
- **Directos**: se detecta si un participante está transmitiendo en Twitch, YouTube o Kick.

Todo el detalle está en [`docs/REGLAS.md`](docs/REGLAS.md), [`docs/PUNTUACION.md`](docs/PUNTUACION.md)
y [`docs/OBJETIVOS.md`](docs/OBJETIVOS.md).

<p align="center">
  <img src="public/imagenes/iconos-ligas/solo_bronze_1.svg" width="44" alt="Bronce">
  <img src="public/imagenes/iconos-ligas/solo_silver_1.svg" width="44" alt="Plata">
  <img src="public/imagenes/iconos-ligas/solo_gold_1.svg" width="44" alt="Oro">
  <img src="public/imagenes/iconos-ligas/solo_platinum_1.svg" width="44" alt="Platino">
  <img src="public/imagenes/iconos-ligas/solo_diamond_1.svg" width="44" alt="Diamante">
  <img src="public/imagenes/iconos-ligas/solo_conqueror_1.svg" width="44" alt="Conquistador">
</p>

---

## Especificaciones técnicas

Resumen de con qué está hecho. El detalle vive en [`docs/`](docs).

### Stack

| Capa | Elección |
|---|---|
| Framework | Next.js 16 (App Router) + TypeScript |
| Estilos | TailwindCSS v4, tokens en `src/app/globals.css` |
| Datos | PostgreSQL en Supabase + Prisma 7 (`prisma/schema.prisma`) |
| Auth | Supabase Auth, solo para el panel de administración |
| Datos externos | API de AoE4World; YouTube y Kick para los directos |
| Despliegue | Cloudflare Workers con OpenNext |

### Cómo funciona

```
Supabase Cron ──► Worker (Cloudflare) ──► API de AoE4World
                       │
                       ├──► YouTube / Kick (directos)
                       ▼
                  PostgreSQL (Supabase)
                       │
                       ▼
   Web: clasificación · partidas · objetivos · puntuación · reglas
                       ▲
                       └── Panel /admin (solo organización)
```

- El **reloj** es un job de `pg_cron` en la base de datos que dispara la sincronización cada 10 minutos;
  un workflow de GitHub queda como red de seguridad.
- El **motor de puntuación** lee las partidas guardadas, aplica el ruleset activo y escribe la
  clasificación. Se recalcula solo.
- Las **reglas y los puntos** son configurables sin desplegar (viven en la tabla `Setting`).

### Acceso al panel

El panel de administración (`/admin`) es solo para la organización, y tiene **dos papeles**:

- **Superadministrador**: la cuenta cuyo correo está en `SUPERADMIN_EMAIL`. Es única y puede, además
  de todo lo de un admin, invitar a otros admins, darlos de baja y reactivarlos, **deshacer** lo que
  hicieron los admins regulares desde el historial de `/admin/acciones`, **revertir actuaciones
  administrativas** y mandar un aviso de prueba al canal de Discord del torneo.
- **Admin**: cualquier cuenta de la tabla `Admin` que esté **activa**. No puede tocar la lista de
  admins ni revertir actuaciones; sí puede crear **expulsiones** y **anulaciones de partidas**.

La pestaña **Actuaciones** (`/admin/actuaciones`) es el expediente de esas decisiones: cada fila
guarda una sola acción, su razón pública, la información privada opcional, el autor y la fecha. La
expulsión deja al participante en estado **Expulsado** y solo se levanta revirtiéndola; la anulación
marca partidas ganadas que dejan de sumar; la reversión deshace una o varias actuaciones vigentes y
es **final**. Todo se anuncia en el canal de avisos y por privado al participante, sin la
información privada.

Lo del superadministrador vive en la pestaña **Administración**, que solo él ve y que se organiza en
subpestañas: **Administradores** (invitar, dar de baja y reactivar), **Edición**, **Puntuación**,
**Eventos** (el calendario con multiplicador), **Inscripciones** (el plazo y los países admitidos),
**Donaciones** y **Avisos** (la prueba del canal de Discord). Fuera de Administración y de la
reversión de actuaciones, el panel es igual para los dos papeles.

El alta es **por invitación**: se escribe el correo en el panel y la persona recibe un enlace para
fijar su contraseña (pasa por `/auth/confirm` y termina en `/login/establecer-contrasena`); un enlace
caducado o ya usado lleva a `/login?error=enlace`, que lo explica. Dar de baja **desactiva** la
cuenta —no la borra—, así que se puede reactivar. Quien entra con una cuenta sin acceso ve
`/sin-acceso`. El detalle operativo está en
[`docs/OPERACION.md`](docs/OPERACION.md#administración-del-panel).

### Entornos

| Entorno | Base de datos | Auth | Dónde |
|---|---|---|---|
| Producción | Proyecto Supabase de producción | Supabase Auth de producción | `main` → `https://laligahispana.es` |
| Desarrollo y Previews | Proyecto Supabase de desarrollo | Supabase Auth de desarrollo | `next dev` y cada Preview |

- `.env.local` apunta al proyecto de **desarrollo**. Producción no se toca desde `next dev` ni desde
  los comandos diarios.
- Los Previews comparten la base de desarrollo; es desechable y se rellena con fixtures.
- Las variables de producción viven en el panel de Cloudflare y en las operaciones manuales
  deliberadas, nunca en el entorno local. El detalle está en
  [`docs/DESPLIEGUE.md`](docs/DESPLIEGUE.md#variables-los-dos-sitios-del-panel).

### Puesta en marcha

Requiere Node.js 20+ y una base de datos PostgreSQL.

```bash
npm install          # dependencias + cliente Prisma
cp .env.example .env.local  # rellena la URL del proyecto de DESARROLLO
npm run db:push      # crea las tablas en desarrollo
npm run countries:seed
npm run db:window
npm run mock:tournament   # datos de prueba
npm run dev          # http://localhost:3000
```

### Comandos

| Comando | Qué hace |
|---|---|
| `npm run dev` | Servidor de desarrollo. |
| `npm run build` / `npm run start` | Build y arranque de producción. |
| `npm run lint` / `npm test` | ESLint y tests (Vitest). |
| `npm run sync` | Sincroniza partidas de AoE4World. |
| `npm run score` | Recalcula la clasificación. |
| `npm run backfill:objective-leads` | Reconstruye el historial de liderazgos de la edición desde las partidas ya jugadas (`-- --dry-run` no escribe). |
| `npm run db:push` / `npm run db:security` | Sincroniza el schema y aplica la postura de RLS en el entorno de `DATABASE_URL` (por defecto, desarrollo). |
| `npm run db:cron` | Programa el reloj del torneo en producción (Supabase Cron). No ejecutar contra desarrollo. |
| `npm run mock:tournament` / `npm run mock:clean` | Simula el torneo con fixtures locales y lo deshace. |
| `npm run deploy` / `npm run preview` | Despliega el Worker (producción manual / preview local). |

### Despliegue

**Producción despliega sola**: el repositorio está conectado a Cloudflare Workers Builds. Un push a
`main` publica en `https://laligahispana.es`; un push a cualquier otra rama genera un **Preview** con
su propia URL, apuntando al proyecto Supabase de **desarrollo**. GitHub Actions comprueba lint, build y
tests en cada pull request.

El despliegue manual (`npm run deploy`) compila con el entorno del proceso. Como `.env.local` apunta a
desarrollo, para publicar a producción hay que exportar antes las variables `NEXT_PUBLIC_*` de
producción o usar Workers Builds. El detalle está en
[`docs/DESPLIEGUE.md`](docs/DESPLIEGUE.md#despliegue-manual).

### Documentación

| Documento | Contenido |
|---|---|
| [`docs/REGLAS.md`](docs/REGLAS.md) | Normas para participar y reglas internas del torneo. |
| [`docs/PUNTUACION.md`](docs/PUNTUACION.md) | El sistema de puntuación: qué cuenta y cuánto vale. |
| [`docs/OBJETIVOS.md`](docs/OBJETIVOS.md) | Los 88 objetivos, con sus puntos. |
| [`docs/MODELO-DATOS.md`](docs/MODELO-DATOS.md) | El esquema de la base de datos, tabla por tabla. |
| [`docs/DESPLIEGUE.md`](docs/DESPLIEGUE.md) | Producción y previews, variables, Hyperdrive y problemas conocidos. |
| [`docs/OPERACION.md`](docs/OPERACION.md) | Sincronización, alertas, simulaciones y operativa diaria. |

### Desarrollo con agentes

El trabajo se reparte entre dos subagentes, cada uno con su guía en `.opencode/agent/`:
`@design-ux` (interfaz y copy) y `@logic-data` (lógica, datos, auth y API). Las reglas de enrutado y
las convenciones del repositorio están en [`AGENTS.md`](AGENTS.md).

---

<p align="center">
  <img src="public/imagenes/marca/emblema-256.png" width="72" alt="Emblema de la Liga Hispana">
</p>
