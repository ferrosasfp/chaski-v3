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
