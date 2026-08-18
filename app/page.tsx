import { RemittanceFlow } from "@/presentation/flow";
import { Splash } from "@/presentation/splash";

/**
 * HU-066 · El splash va ACÁ, hermano de `RemittanceFlow` y no adentro.
 *
 * 🔴 EL ORDEN NO ES ESTÉTICO. `<Splash />` va PRIMERO en el árbol, así que el `<div fixed>` del splash
 * queda antes en el orden del documento; lo que lo pone encima es su `z-50`, no la posición. Va primero
 * para que el foco del teclado, al entrar a la página, encuentre el splash antes que el primer control
 * de la app: si estuviera después, un `Tab` durante el splash movería el foco a un botón invisible.
 *
 * ⛔ Y `RemittanceFlow` NO CAMBIA NI UN BYTE POR ESTO: no recibe props nuevas, no sabe que el splash
 * existe y sigue montándose a la vez. Eso es exactamente lo que hace que el resume del KYC y la vuelta
 * por enlace no se retrasen — sus efectos de montaje corren igual, esté o no el splash arriba. El
 * splash no aplaza nada; a lo sumo lo TAPA, y por eso la puerta de `splash-puerta.ts` existe.
 */
export default function Page() {
  return (
    <>
      <Splash />
      <RemittanceFlow />
    </>
  );
}
