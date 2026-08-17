// Lo que la pantalla necesita saber sobre la wallet ANTES de que la persona toque nada.
//
// Este módulo NO importa `@solana/wallet-adapter-*` (mismo seam que `solana-wallet-bridge.ts`): lee
// el singleton React-free, que es donde el sync component deja la medición. Así la pantalla del
// flujo puede reaccionar sin arrastrar la librería a su chunk.
import { useSyncExternalStore } from "react";
import {
  type SolanaWalletAvailability,
  solanaWalletBridge,
} from "../infrastructure/solana-wallet-bridge";

/**
 * Universal link de Phantom para abrir una URL DENTRO del navegador de Phantom.
 *
 * El esquema NO está inventado: es el mismo que usa la propia librería cuando el adapter de Phantom
 * está en `Loadable` (`node_modules/@solana/wallet-adapter-phantom/lib/cjs/adapter.js`, rama
 * `readyState === WalletReadyState.Loadable` de `connect()`), incluido el `?ref=` con el origin.
 *
 * Existe acá, además de en la librería, porque la librería SÓLO lo dispara en `Loadable`, y `Loadable`
 * es iOS: en Android el adapter se queda en `NotDetected` y ese camino nunca corre (medido). Este
 * enlace es el que la persona toca a mano, en cualquiera de las dos plataformas.
 *
 * Los dos componentes van encodeados: `href` puede traer query string (`?kyc=return`) y sin encodear
 * se comería el `?ref=`.
 */
export function phantomBrowseUrl(href: string, origin: string): string {
  return `https://phantom.app/ul/browse/${encodeURIComponent(href)}?ref=${encodeURIComponent(origin)}`;
}

/**
 * ¿Hay una wallet inyectada en este navegador? Tres valores (ver `SolanaWalletAvailability`).
 *
 * En el servidor devuelve "unknown" y no "none": el servidor no puede medir el scope global del
 * navegador de nadie, y contestar "no hay" sería afirmar algo que no sabe.
 */
export function useWalletAvailability(): SolanaWalletAvailability {
  return useSyncExternalStore(
    (onChange) => solanaWalletBridge.subscribeWalletAvailability(onChange),
    () => solanaWalletBridge.getWalletAvailability(),
    () => "unknown" as const,
  );
}

/**
 * WKH-354/AC-1 · Qué cuenta tiene ACTIVA la billetera en este instante, reactivo.
 *
 * `useWalletAvailability` (arriba) contesta "¿hay alguna wallet?"; ésta contesta "¿cuál cuenta?".
 * Las dos leen el MISMO singleton React-free, así que este módulo sigue sin importar
 * `@solana/wallet-adapter-*`.
 *
 * En el servidor devuelve `null` y no una dirección: el servidor no sabe qué tiene conectado el
 * navegador de nadie, y `null` acá significa "no hay ninguna billetera conectada": el mismo
 * significado de `null` que `ConnectedWalletProbe` (`../application/ports.ts:541`), que es
 * bi-estado a propósito (`ports.ts:537`). Nadie puede leer este `null` como "cambió la cuenta".
 *
 * ⚠️ ESTA ES LA LECTURA RENDER-TIME, y existe además del puerto por una razón de React y no por
 * gusto: `useSyncExternalStore` exige un `getSnapshot` SÍNCRONO, y
 * `ConnectedWalletProbe.getConnectedAddress()` es `async`. Un puerto no puede alimentar un
 * `useSyncExternalStore`. Las decisiones (gesture-time) siguen yendo por el puerto inyectado, que es
 * la costura que los tests controlan.
 */
export function useConnectedWalletAddress(): string | null {
  return useSyncExternalStore(
    (onChange) => solanaWalletBridge.subscribeState(onChange),
    () => solanaWalletBridge.getState().publicKey,
    () => null,
  );
}

/**
 * WKH-MWA · ¿Está prendida la bandera de Mobile Wallet Adapter?
 *
 * 🔴 QUÉ GATEA ESTA BANDERA, Y QUÉ NO — leerlo al revés es el error caro:
 *   · NO gatea el adapter. El adapter NO ES NUESTRO: lo antepone `@solana/wallet-adapter-react` solo,
 *     sin que este repo importe nada (ver el docblock de `MWA_WALLET_NAME` en
 *     `../infrastructure/solana-wallet-bridge.ts`, con la medición de las cuatro plataformas).
 *   · SÍ gatea lo único que sí es nuestro: si la app le DICE a la persona que ese camino existe.
 *
 * POR QUÉ NO SE GATEA EL ADAPTER, que es la decisión de diseño de esta HU y no un descuido: quitarlo
 * cuando la bandera está apagada dejaría el selector de wallets VACÍO en Chrome de Android, que es
 * donde hoy es la única entrada. Sería romper algo que existe para poder decir que está apagado. La
 * bandera apagada tiene que ser byte-idéntica a hoy, y hoy el adapter está.
 *
 * POR QUÉ UNA ENV Y NO EL USER AGENT: la pregunta "¿este navegador ofrece MWA?" ya la contesta la
 * librería y la reporta (`getMwaOffered`, `../infrastructure/solana-wallet-bridge.ts:239`); mirar el
 * user agent por nuestra cuenta sería una segunda opinión que puede contradecir a la primera, y este
 * repo ya tiene esa lección escrita en el docblock del efecto de `solana-providers.tsx`. La env
 * contesta OTRA pregunta, que ninguna medición puede contestar: "¿alguien ya probó esto en un
 * teléfono?". Esa respuesta la tiene una persona, no el navegador.
 *
 * OPT-IN ESTRICTO, mismo patrón que (`solanaSettleOn`, `../composition/container.ts:141`): sólo el
 * literal `"true"` prende. Ausente, vacía, `"1"`, `"TRUE"` o un typo ⇒ APAGADA. No hay ningún valor
 * que la prenda por accidente.
 *
 * ⚠️ GOTCHA DE DESPLIEGUE: las `NEXT_PUBLIC_` las inlinea el build, no se leen en runtime. Cambiar el
 * valor en Vercel y REDESPLEGAR el mismo artefacto NO cambia nada: hay que REBUILDEAR.
 */
export function mwaEnabled(): boolean {
  return process.env.NEXT_PUBLIC_SOLANA_MWA_ENABLED === "true";
}

/**
 * WKH-MWA · ¿El selector ofrece HOY la entrada de Mobile Wallet Adapter en este navegador?
 *
 * Reactivo por la misma razón que `useWalletAvailability` (arriba): la lista de wallets de la librería
 * se re-emite en cada `readyStateChange`, así que una lectura única al renderizar congelaría la foto
 * del primer cuadro.
 *
 * En el servidor devuelve `false`: el servidor no sabe qué selector va a armar el navegador de nadie,
 * y `false` acá es el valor que NO habilita a afirmar nada (la pantalla sólo lo usa para AGREGAR una
 * salida). El significado exacto de la bandera, y las dos lecturas falsas que invita, están en
 * (`setMwaOffered`, `../infrastructure/solana-wallet-bridge.ts:233`).
 */
export function useMwaOffered(): boolean {
  return useSyncExternalStore(
    (onChange) => solanaWalletBridge.subscribeMwaOffered(onChange),
    () => solanaWalletBridge.getMwaOffered(),
    () => false,
  );
}
