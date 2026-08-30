/**
 * WKH-075 — LA ESPERA A QUE LA DISPONIBILIDAD DE BILLETERA SEA **DECIDIBLE**.
 *
 * 🔴 QUÉ DEFECTO CIERRA, Y POR QUÉ NO ES UN VALOR MAL CALCULADO SINO UNA CARRERA DE ARRANQUE.
 * Al volver de un salto por enlace, el consumidor de montaje (`useVueltaPorEnlace`,
 * `../../presentation/flow.tsx:3956`) corre a `t ≈ 0`. En ese instante `getWalletAvailability()`
 * todavía vale `"unknown"`. El gate de la rama de enlace es `!== "none"`
 * (`../solana-wallet.ts:2240`), así que `"unknown"` cae del lado de `"injected"`: el recorrido se va
 * al camino inyectado, `connect()` cae a `solanaWalletBridge.openModal()`, se abre el selector de la
 * librería, se auto-cierra 150 ms después de tocar una billetera, ese cierre dispara
 * `cancelConnection()` y la persona lee «Se cerró el selector de wallet sin conectar». **Una acción
 * que no hizo**, y leída después de haber firmado, o sea después de gastar un viaje redondo.
 *
 * MEDIDO (foto del 2026-08-29, ⛔ NO re-derivable desde esta suite): `t=50ms availability=unknown
 * selector-en-el-DOM=true` · `t=1750ms availability=none`. **El dato nunca faltó: llegaba tarde.** El
 * instrumento fue la Sonda 2 de `doc/sdd/075-la-vuelta-.../sdd.md` §0.2 —`SolanaProviders` real, adapters reales,
 * reloj real, ninguna wallet inyectada—, un archivo temporal que se creó, se corrió y se BORRÓ, así
 * que estos dos números son una FOTO fechada y no algo que el gate re-mida (fix-pack · AR/MNR-3).
 *
 * ⛔ POR QUÉ EL ARREGLO NO ES CAMBIAR EL GATE A `!== "injected"`. Está prohibido por escrito en
 * (`el gate`, `../solana-wallet.ts:2222-2228`) y lo mata `T-065-GATE-3`: con esa forma, un escritorio
 * con la extensión **todavía sin montar** entraría a la rama de enlace, que es justo el camino que el
 * video del Demo Day corre. El arreglo tiene que distinguir «todavía no medimos» de «no hay», y
 * ⛔ nunca fundirlos del otro lado.
 *
 * ⛔ ESTE MÓDULO NO LEE NINGUNA ENV Y NO EXPONE NINGUNA PERILLA (CD-20). El repo declara dos y sólo
 * dos formas de replegar el camino por enlace: la env que lee (`deeplinkEnabled`,
 * `../../presentation/wallet-availability.ts:156`) repliega el BUILD, y el control «Cambiar de
 * billetera» repliega el DISPOSITIVO. Ésta no es una tercera.
 * ⚠️ El nombre de esa env NO se escribe acá A PROPÓSITO: el barrido de `T-075-4` mide el texto
 * crudo del archivo y no distingue un comentario de una lectura, así que nombrarla dejaría el
 * candado rojo por una frase. El nombre vive donde se lee.
 * `techoMs` es inyectable **SÓLO para que los tests no esperen 3 s** —mismo patrón que
 * `confirmTimeoutMs` en `../solana-wallet.ts:185`— y ⛔ no se cablea desde producción.
 *
 * ⛔ NO IMPORTA REACT NI NADA DE `src/presentation/`: es infraestructura, igual que el bridge.
 */
import { solanaWalletBridge } from "../solana-wallet-bridge";
import { DEEPLINK_DISPONIBILIDAD_SIN_RESOLVER } from "./deeplink/firma-por-enlace";

/** 🔴 POR QUÉ 3000 Y NO OTRO NÚMERO: tiene que superar `WALLET_GRACE_MS = 1500`
 *  (`../../presentation/solana/solana-providers.tsx:84`), que es el instante en que el efecto de la
 *  gracia escribe `"none"` sí o sí. **3000 = 2× la gracia.**
 *  ⛔ NO SE IMPORTA `WALLET_GRACE_MS` acá: invertiría la dependencia (presentación → infraestructura)
 *  y ataría en silencio dos perillas que el repo declara independientes. Lo que sí existe es el
 *  invariante que las relaciona, escrito como test (`T-075-TECHO`, `./disponibilidad-decidible.test.ts`),
 *  que deriva la gracia leyendo su archivo con un regex y se pone rojo el día que alguien la suba por
 *  encima de este techo. */
export const TECHO_DISPONIBILIDAD_MS = 3_000;

/** ⚠️ EL TECHO VENCIDO **NO** ES `"none"`. Devuelve una causa propia a propósito: un techo que degrada
 *  callado es el mismo defecto una capa más abajo, y degradar a `"none"` acá reabriría el camino
 *  inyectado que esta HU vino a cerrar. Quien reciba `sin-decidir` corta y lo dice. */
export type Decidible =
  | { estado: "decidida"; valor: "injected" | "none" }
  | { estado: "sin-decidir"; causa: typeof DEEPLINK_DISPONIBILIDAD_SIN_RESOLVER };

/**
 * ⚠️ SI YA ESTÁ DECIDIDA, RESUELVE **SIN ESPERAR UN SOLO TICK**, y ese corte no es una optimización:
 * es lo que deja el camino inyectado y los ~100 `it` que montan la pantalla sin marca
 * **byte-idénticos**. Sin él, `T-075-2` se pone rojo.
 *
 * ⚠️ ALCANZABILIDAD DE LA RAMA DEL TECHO — no es código defensivo. `SolanaProviders` entra por
 * `next/dynamic` con `ssr:false` (`../../presentation/providers.tsx:6`). Si ese chunk no carga, el
 * árbol nunca monta, el efecto de la gracia nunca corre y la disponibilidad queda en `"unknown"`
 * **para siempre**. Hoy ese caso termina en `openModal()` tirando `wallet_bridge_not_mounted`
 * (`../solana-wallet-bridge.ts:92`); con esta HU termina en una causa que la persona puede leer.
 *
 * ⚠️ SE DESUSCRIBE SIEMPRE, gane la suscripción o gane el techo: el bridge es un **singleton que vive
 * toda la sesión** y un listener que sobrevive a su consumidor es un leak.
 */
export function esperarDisponibilidadDecidible(
  techoMs: number = TECHO_DISPONIBILIDAD_MS,
): Promise<Decidible> {
  const yaEsta = solanaWalletBridge.getWalletAvailability();
  if (yaEsta !== "unknown") return Promise.resolve({ estado: "decidida", valor: yaEsta });
  return new Promise<Decidible>((resolve) => {
    let desuscribir: (() => void) | null = null;
    let techo: ReturnType<typeof setTimeout> | null = null;
    const cerrar = (): void => {
      if (techo !== null) { clearTimeout(techo); techo = null; }
      if (desuscribir !== null) { desuscribir(); desuscribir = null; }
    };
    desuscribir = solanaWalletBridge.subscribeWalletAvailability(() => {
      const ahora = solanaWalletBridge.getWalletAvailability();
      if (ahora === "unknown") return; // el bridge sólo avisa cuando CAMBIA, pero no se asume
      cerrar();
      resolve({ estado: "decidida", valor: ahora });
    });
    techo = setTimeout(() => {
      cerrar();
      resolve({ estado: "sin-decidir", causa: DEEPLINK_DISPONIBILIDAD_SIN_RESOLVER });
    }, techoMs);
  });
}
