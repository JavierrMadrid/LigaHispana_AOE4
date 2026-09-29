import Link from "next/link";

/**
 * Acción principal de la cabecera: la inscripción.
 *
 * Vive aparte del layout para que el cromo (marca y navegación) no se mezcle con
 * la conversión. No es un componente cliente: no lee la ruta activa porque la
 * llamada no cambia de aspecto en su propia página (el formulario que encuentra
 * allí ya da el contexto) y así la cabecera se queda sin JavaScript.
 *
 * El tratamiento es una cinta de oro relleno: la etiqueta anuncia la acción en
 * tinta oscura (`--accent-ink`), no en oro, para que el texto no quede en oro
 * sobre oro, y el icono viaja dentro de la misma cinta. El relleno es el
 * mismo de los demás controles primarios del sitio (entrar, filtros activos),
 * así que el dialecto se mantiene: la elevación se declara con relleno y sin
 * filete. A partir de `xl` —cuando marca, navegación y CTA comparten una sola
 * fila— la cinta abandona el radio y se estira todo el alto de la barra, de modo
 * que la cabecera se cierra en oro; por debajo de `xl` la navegación baja a su
 * propia fila y la cinta vuelve a ser un control redondeado de alto propio. El
 * enlace entero es la zona pulsable, y el foco se dibuja por dentro en tinta
 * oscura para seguir viéndose sobre el oro.
 */
export function ParticipateCta() {
  return (
    <Link
      href="/participar"
      className="inline-flex shrink-0 items-center gap-2.5 whitespace-nowrap rounded-md bg-accent px-3.5 py-2.5 text-sm font-medium text-accent-ink transition-colors hover:bg-accent-strong focus-visible:outline-accent-ink focus-visible:-outline-offset-2 sm:px-4 xl:-my-3 xl:self-stretch xl:rounded-none xl:py-0"
    >
      Inscríbete
      {/* En el móvil más estrecho (320 px) el icono cede su sitio al wordmark,
          que si no se queda sin ancho útil; el texto ya nombra la acción. */}
      <RegistrationIcon className="hidden size-5 shrink-0 sm:block" />
    </Link>
  );
}

/**
 * Formulario de inscripción: portapapeles con el clip en el borde superior y
 * tres renglones.
 *
 * Mismo trazo que los glifos de `objective-icon.tsx` (caja de 24, `currentColor`,
 * 1.5 de grosor y extremos redondeados): la cabecera no estrena un lenguaje de
 * iconos propio. Es decorativo, el nombre accesible lo da el texto del enlace.
 */
function RegistrationIcon({ className }: { className?: string }) {
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
      <path d="M9 4.5H8a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2v-12a2 2 0 0 0-2-2h-1" />
      <path d="M10.2 3h3.6A1.2 1.2 0 0 1 15 4.2v1.1A1.2 1.2 0 0 1 13.8 6.5h-3.6A1.2 1.2 0 0 1 9 5.3V4.2A1.2 1.2 0 0 1 10.2 3Z" />
      <path d="M9 11h6" />
      <path d="M9 14.25h6" />
      <path d="M9 17.5h3.5" />
    </svg>
  );
}
