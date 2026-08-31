import { DiagnosticoDeVuelta } from "@/presentation/diagnostico-de-vuelta";
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
      {/* HU-075/diagnóstico · EL BLOQUE VA ACÁ POR TRES RAZONES, y ninguna es estética.
          1. HERMANO Y NO ADENTRO, por lo mismo que el splash: así `flow.tsx` —[[CENSO src/presentation/flow.tsx lineas=4453]] líneas y
             [[CENSO src/presentation/flow.tsx entrantes=155]] citas ancladas por número— no recibe ni una línea por esto. Lo único que sí necesita de ahí
             adentro es la causa cruda del corte, y eso entra por la bitácora, en una línea que ya
             existía.
          2. DESPUÉS DEL SPLASH, para no tocar el invariante de foco que el docblock de arriba declara:
             el splash tiene que seguir siendo el primer subárbol del documento.
          3. ANTES DE `RemittanceFlow`, para que quede ARRIBA DE TODO en el flujo normal y entre en
             una captura de pantalla sin scrollear, que es el entregable.
          ⛔ Sin `?diag=1` esto devuelve `null` y no ejecuta ninguna lectura: la página queda idéntica. */}
      <DiagnosticoDeVuelta />
      <RemittanceFlow />
    </>
  );
}
