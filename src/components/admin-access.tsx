import Link from "next/link";

/**
 * Acceso de la organización, a la derecha de la inscripción.
 *
 * Es la segunda acción de la cabecera, así que comparte forma con
 * `ParticipateCta` —radio de control, relleno interno y alto propio— y cambia el
 * peso: donde la inscripción lleva el oro, este acceso se queda sin relleno, con
 * un filete `line` y la etiqueta en `muted`, y solo se enciende al pasar por
 * encima (`bg-surface` y texto marfil). Es la puerta de la organización, no una
 * llamada para quien visita el torneo: se lee como cromo de la barra y deja que
 * el oro siga señalando la conversión. Antes era una cinta de pergamino macizo
 * que competía con la inscripción; ahora la jerarquía la marca el color, no el
 * volumen.
 *
 * La etiqueta es "Admin" y no "Panel de administración": es una acción de una
 * persona de la organización, no de quien visita el torneo, y el nombre largo
 * ocuparía media cabecera. Es la palabra que la distingue de "Inscríbete" sin
 * competir con ella. El `aria-label` repite "Admin" para que el enlace conserve
 * su nombre cuando el móvil más estrecho esconde la palabra y solo queda el
 * candado. El login es quien protege `/admin`; aquí solo se enlaza su puerta,
 * sin lógica de sesión.
 *
 * Se estrecha por tramos en vez de desaparecer, como la inscripción:
 *  - Desde `sm`, la palabra y el candado.
 *  - Por debajo de `sm` cede el decorativo (el candado) y queda la palabra, que
 *    es la que nombra la acción.
 *  - Por debajo de 400 px cede también la palabra y queda el candado solo, con
 *    el nombre accesible puesto en el enlace (`aria-label`). El corte está ahí y
 *    no más abajo porque a 320–400 px la fila ya viene justa y el wordmark se
 *    recorta: recuperar el ancho de "Admin" es la diferencia entre el nombre de
 *    la liga entero y unos puntos suspensivos. A cualquier ancho el acceso sigue
 *    disponible desde el pie ("Acceso de la organización").
 *
 * El glifo es un candado: es la lectura universal de "acceso a una zona
 * protegida", que es justo lo que hay al otro lado del enlace. Un escudo diría
 * "seguridad" y una llave diría "credencial", que no son la acción. Lo dibuja
 * `AccessIcon` con el mismo trazo que el resto de glifos del sitio, y es
 * decorativo: el texto del enlace (o el `aria-label` cuando solo se ve el
 * candado) es quien nombra la acción.
 *
 * Como `ParticipateCta`, es un Server Component sin JavaScript: no lee la ruta
 * activa ni cambia de aspecto. El `Link` se queda como `Link` a propósito: la
 * ventana de login la abre la navegación, no un estado de cliente.
 */
export function AdminAccess() {
  return (
    <Link
      href="/login"
      aria-label="Admin"
      className="inline-flex shrink-0 items-center gap-2.5 whitespace-nowrap rounded-md border border-line px-3.5 py-2.5 text-sm font-medium text-muted transition-colors hover:border-line-strong hover:bg-surface hover:text-foreground sm:px-4"
    >
      <span className="hidden min-[400px]:inline">Admin</span>
      {/* En el móvil más estrecho el texto cede su sitio al glifo, que es lo
          único que cabe; el `aria-label` del enlace conserva el nombre, así que
          el candado se queda decorativo. */}
      <AccessIcon className="hidden size-5 shrink-0 max-[400px]:block sm:block" />
    </Link>
  );
}

/**
 * Candado: cuerpo redondeado, arco del cierre y ojo de la cerradura.
 *
 * Mismo trazo que `RegistrationIcon` y los glifos de `objective-icon.tsx` (caja
 * de 24, `currentColor`, 1.5 de grosor y extremos redondeados): la cabecera no
 * estrena un lenguaje de iconos propio.
 */
function AccessIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <rect x="5" y="10.5" width="14" height="9.5" rx="2" />
      <path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" />
      <path d="M12 13.75v2.5" />
    </svg>
  );
}
