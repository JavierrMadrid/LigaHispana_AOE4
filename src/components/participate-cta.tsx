import Link from "next/link";

/**
 * Acción principal de la cabecera: la inscripción.
 *
 * Vive aparte del layout para que el cromo (marca y navegación) no se mezcle con
 * la conversión. No es un componente cliente: no lee la ruta activa porque la
 * llamada no cambia de aspecto en su propia página (el formulario que encuentra
 * allí ya da el contexto) y así la cabecera se queda sin JavaScript.
 *
 * El tratamiento es texto más sello, no placa: la etiqueta anuncia la acción en
 * marfil y el icono la respalda dentro de un aro dorado. Así sigue siendo la
 * acción principal, pero el oro vuelve a ser filete y no relleno, como manda el
 * dialecto del sitio (la elevación se declara con filete o con relleno, nunca
 * con los dos). El aro se enciende al pasar el ratón, y el enlace entero es la
 * zona pulsable, de modo que texto e icono llevan al mismo sitio.
 */
export function ParticipateCta() {
  return (
    <Link
      href="/participar"
      className="group inline-flex shrink-0 items-center gap-2.5 whitespace-nowrap text-sm font-medium text-foreground transition-colors hover:text-accent active:translate-y-px"
    >
      Inscríbete
      <span className="flex size-11 shrink-0 items-center justify-center rounded-md border border-accent/40 text-accent transition-colors group-hover:border-accent/70 group-hover:bg-accent/10 group-hover:text-accent-strong">
        <RegistrationIcon className="size-5" />
      </span>
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
