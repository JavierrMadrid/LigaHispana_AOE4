"use client";

import { useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { Modal } from "@/components/modal";

/**
 * Ventana emergente del acceso, la variante que se abre al pulsar `Admin` en la
 * cabecera pública.
 *
 * Envuelve la misma tarjeta que la página `/login` (`LoginPanel`, un Server
 * Component que llega como `children`) con la capa de `Modal`. Es cliente
 * porque necesita leer el historial del navegador para cerrarse.
 *
 * El cierre va por `router.back()`: así el botón "atrás" del navegador también
 * cierra la ventana y devuelve a la página desde la que se abrió, que es media
 * razón de usar rutas interceptadas. En una pestaña abierta directamente en
 * `/login` no hay entrada anterior que recuperar, así que `back()` sería un
 * no-op y la ventana se quedaría sin salida: en ese caso se va a la portada.
 */
export function LoginModal({ children }: { children: ReactNode }) {
  const router = useRouter();

  function close() {
    if (window.history.length > 1) {
      router.back();
    } else {
      router.push("/");
    }
  }

  return (
    <Modal
      open
      onClose={close}
      ariaLabel="Acceso al panel de administración"
      closeLabel="Cerrar"
      className="m-auto w-[calc(100%-2rem)] max-w-sm bg-transparent p-0 text-foreground"
    >
      {children}
    </Modal>
  );
}
