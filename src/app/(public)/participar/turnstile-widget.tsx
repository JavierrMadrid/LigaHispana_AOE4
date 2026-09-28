"use client";

import Script from "next/script";
import { TURNSTILE_RESPONSE_FIELD } from "@/lib/turnstile-contract";

/**
 * Widget de Cloudflare Turnstile del formulario de inscripción.
 *
 * Va en su propio módulo y no dentro del formulario por dos motivos: el tipo
 * global de `window.turnstile` queda declarado en un solo sitio, y el reseteo
 * —que el formulario necesita tras un error, porque el token es de un solo
 * uso— se pide desde fuera sin que el formulario sepa cómo habla Turnstile.
 *
 * Se monta por **renderizado implícito**: cuando carga `api.js`, Turnstile busca
 * los elementos con la clase `cf-turnstile` y crea dentro el iframe del reto y
 * el campo oculto con el token. El nombre de ese campo se configura con
 * `data-response-field-name` y no se escribe a mano, porque tiene que ser
 * exactamente el que lee la Server Action y los dos salen del contrato compartido.
 *
 * El script se carga con `afterInteractive` y no con un `<script>` suelto: Next
 * lo inyecta después de la hidratación, así no bloquea el primer render, y el
 * contenedor ya está en el DOM cuando Turnstile lo busca. El contenedor reserva
 * los 65 px del widget normal para que el botón no dé un salto cuando el reto
 * termina de pintarse.
 */
const TURNSTILE_SCRIPT = "https://challenges.cloudflare.com/turnstile/v0/api.js";

declare global {
  interface Window {
    /** API que publica `api.js` en la ventana cuando termina de cargar. */
    turnstile?: {
      /** Sin argumento resetea todos los widgets de la página. */
      reset: (widgetId?: string) => void;
    };
  }
}

export function TurnstileWidget({ siteKey }: { siteKey: string }) {
  return (
    <>
      <Script src={TURNSTILE_SCRIPT} strategy="afterInteractive" />
      <div
        className="cf-turnstile min-h-[65px]"
        data-sitekey={siteKey}
        data-theme="dark"
        data-size="normal"
        data-response-field-name={TURNSTILE_RESPONSE_FIELD}
      />
    </>
  );
}

/**
 * Pide un token nuevo. Hay que llamarlo tras cada error de envío: el token ya se
 * ha canjeado contra Cloudflare y reenviarlo tal cual fallaría siempre. Si el
 * widget no se ha pintado no hay API que resetear, así que no hace nada.
 */
export function resetTurnstileWidget() {
  window.turnstile?.reset();
}
