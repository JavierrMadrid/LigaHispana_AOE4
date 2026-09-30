import { LoginModal } from "@/app/login/login-modal";
import { LoginPanel } from "@/app/login/login-panel";
import { redirectIfAuthenticated } from "@/lib/auth";

/**
 * Variante interceptada de `/login`: se abre como ventana sobre la web pública
 * cuando se llega por navegación de cliente (el `Link` de la cabecera).
 *
 * El matcher `(...)` alcanza el segmento desde la raíz de `app`. El slot vive
 * dentro del grupo `(public)`, y como la intercepción se resuelve por segmentos
 * de ruta —no por ficheros, y los grupos y slots no cuentan como segmento—, el
 * interceptor tiene que llegar a la raíz para encontrar el `/login` que está
 * fuera del grupo.
 *
 * Es un Server Component asíncrono: comprueba la sesión antes de pintar el
 * formulario, igual que la página propia. El contenido es la misma tarjeta
 * (`LoginPanel`) que aquella, solo que envuelta en `LoginModal`.
 */
export default async function InterceptedLoginPage() {
  await redirectIfAuthenticated();

  return (
    <LoginModal>
      <LoginPanel />
    </LoginModal>
  );
}
