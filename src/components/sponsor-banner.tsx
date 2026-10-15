import { SponsorLogo } from "@/components/sponsor";

/**
 * Estandarte del patrocinador.
 *
 * Cuelga del borde superior de la ventana —el paño aparece cortado por el borde,
 * como si la sujeción quedara fuera de la pantalla— y remata unos píxeles por
 * debajo de la cabecera. Es un estandarte de tela: cola de golondrina, orla
 * dorada, pliegues tenues y el escudo de la casa bordado en la parte baja, que
 * es la única franja que asoma libre por debajo de la barra.
 *
 * Va anclado a la cabecera (`absolute`, fuera de la rejilla para no empujar el
 * centrado de la navegación) y cuelga a mitad del hueco que queda entre las
 * acciones y el canto de la ventana: el `right` es un cuarto de la ventana menos
 * 20rem —64 px a 1536, 80 a 1600 y 160 a 1920—, con un mínimo de 24 px para
 * tableta, que es donde ese cuarto se queda corto. La celda de las acciones le
 * reserva el ancho para que el paño cuelgue por fuera de los controles y no tape
 * "Inscríbete" ni "Admin": la reserva es de `pr-24` mientras la cabecera va en dos
 * filas y de `pr-12` desde `2xl`, donde las tres celdas comparten fila y el ancho
 * se reparte entre todas. Con esa reserva estrecha quedan 20 px de aire entre los
 * controles y el paño en la anchura de activación (1536), y más a partir de ahí
 * —28 a 1568, 36 a 1600 y 116 a 1920—, porque el paño se separa del canto más
 * deprisa de lo que crece el contenedor, que ya está en su máximo. Por debajo de
 * `md` no se pinta: ahí la cabecera va justa y el crédito sigue entero en el pie.
 *
 * Es pura decoración: el escudo es `alt=""` y no hay texto, así que no añade
 * nada al árbol accesible. Quien acredita al patrocinador es el pie.
 */
export function SponsorBanner() {
  return (
    <div className="pointer-events-none absolute -bottom-12 right-[max(1.5rem,calc(25%-20rem))] z-10 hidden h-[190px] w-17 md:block">
      {/* Orla: la forma recortada en oro; el paño va encima, medio paso dentro. */}
      <div className="relative h-full w-full bg-[linear-gradient(180deg,#e6c98f,#c9a45c_45%,#7d6533)] [clip-path:polygon(0_0,100%_0,100%_100%,50%_88%,0_100%)]">
        <div className="absolute inset-0.5 bg-[linear-gradient(180deg,#262b34,#161a20_55%,#0d1014)] [clip-path:polygon(0_0,100%_0,100%_100%,50%_88%,0_100%)]">
          {/* Pliegues de la tela y caída: la trama vertical sugiere el paño y el
              degradado oscurece hacia la punta, que es como cae la tela. */}
          <span
            aria-hidden="true"
            className="absolute inset-0 bg-[repeating-linear-gradient(90deg,rgba(255,255,255,0.035)_0_3px,transparent_3px_9px)]"
          />
          <span
            aria-hidden="true"
            className="absolute inset-0 bg-[linear-gradient(180deg,rgba(0,0,0,0.55),transparent_35%,rgba(0,0,0,0.35))]"
          />
          <span className="absolute inset-x-0 bottom-8 flex justify-center">
            <SponsorLogo size={64} />
          </span>
        </div>
      </div>
    </div>
  );
}
