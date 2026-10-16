import Link from "next/link";

/**
 * Acción principal de la cabecera: la inscripción.
 *
 * Vive aparte del layout para que el cromo (marca y navegación) no se mezcle con
 * la conversión. No es un componente cliente: no lee la ruta activa porque la
 * llamada no cambia de aspecto en su propia página (el formulario que encuentra
 * allí ya da el contexto) y así la cabecera se queda sin JavaScript.
 *
 * Es cromo de la barra, no un cartel: para no competir con el contenido se viste
 * como un control del sistema —radio de control, relleno interno y alto propio,
 * sin estirarse al alto de la barra— y la jerarquía la declara el color, no el
 * volumen. El oro de marca se queda solo aquí, así que sigue siendo la acción
 * principal, pero en vez de una cinta rellena de dos tonos se pinta como la
 * ficha dorada que ya usa el resto del sitio —filete `accent/40`, tinte
 * `accent/10` y etiqueta en `accent`—, el mismo dialecto de las píldoras de
 * puntos y de poseedor. Sin degradado ni relleno macizo: menos luz, menos peso y
 * menos contraste, la misma lectura. El hover sube el tinte y el filete un punto,
 * y el enlace entero es la zona pulsable. El foco lo dibuja el anillo dorado
 * global por fuera, que sobre el tinte se lee.
 */
export function ParticipateCta() {
  return (
    <Link
      href="/participar"
      className="inline-flex shrink-0 items-center gap-2.5 whitespace-nowrap rounded-md border border-accent/40 bg-accent/10 px-3.5 py-2.5 text-sm font-medium text-accent transition-colors hover:border-accent/60 hover:bg-accent/15 hover:text-accent-strong sm:px-4"
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
