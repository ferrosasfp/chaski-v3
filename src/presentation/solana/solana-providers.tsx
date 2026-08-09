"use client";
// Árbol @solana/wallet-adapter-react — montado SOLO cuando VM=solana (vía next/dynamic en
// providers.tsx). Único archivo que importa la lib + su CSS (seam AC-3). El sync component empuja
// el estado de useWallet() al singleton React-free y registra openModal.
import { useCallback, useEffect, useMemo, useRef } from "react";
import { WalletReadyState } from "@solana/wallet-adapter-base";
import { ConnectionProvider, WalletProvider, useWallet } from "@solana/wallet-adapter-react";
import { WalletModalProvider, useWalletModal } from "@solana/wallet-adapter-react-ui";
import { PhantomWalletAdapter, SolflareWalletAdapter } from "@solana/wallet-adapter-wallets";
import {
  resolveSolanaNetworkConfig,
  resolveSolanaRpcUrlPublic,
} from "../../infrastructure/chain";
import { solanaWalletBridge } from "../../infrastructure/solana-wallet-bridge";
import { walletErrorCode } from "./wallet-error-code";
import "@solana/wallet-adapter-react-ui/styles.css";

/**
 * Cuánto se espera, desde el MONTAJE, antes de poder afirmar "acá no hay ninguna wallet".
 *
 * ⚠️ ES UNA PERILLA DE UX, NO DE CORRECCIÓN, y así hay que leerla. Con 900 ms los ACs se cumplen
 * igual, porque el efecto A corrige en cuanto llega el alta. Nada acá afirma que 1500 sea "el valor
 * correcto".
 *
 * 🔴 Y ACOTAR NO ES CERRAR: ESTA CONSTANTE NO ELIMINA EL DESTELLO DEL AVISO. Sólo lo evita para las
 * altas que llegan ANTES de que la gracia venza. Para CUALQUIER alta posterior el destello sigue
 * entero: el aviso se pinta y después se va. Y no hace falta una sonda aparte para verlo, es lo que
 * asierta `T-341-11` en `solana-providers.test.tsx`: avanza el reloj a 1500 (⇒ `"none"`, o sea el
 * aviso YA está en pantalla), y SÓLO DESPUÉS hace llegar el alta (⇒ `"injected"`). Con una wallet que
 * aparece a t=1600 la persona lee "no vemos ninguna wallet" y después el cartel desaparece. Lo que
 * 1500 compra es que el destello dure 0 ms cuando la detección cae en el primer tick (t=1000), contra
 * los 1000 ms que duraba SIEMPRE antes de esta HU.
 *
 * O sea, y que el resumen diga lo mismo que la línea: lo que esta HU ELIMINÓ es el camino que
 * afirmaba `"none"` en el PRIMER render sin haber medido nada. Lo que queda es un NÚMERO, y lo único
 * que lo reinicia es el MONTAJE del árbol de providers.
 *
 * De dónde sale el número, medido: la detección de Phantom es `setInterval(detectAndDispose, 1000)`
 * (node_modules/@solana/wallet-adapter-base/lib/cjs/adapter.js:92), o sea primer tick en t=1000.
 * 1500 deja 500 ms de holgura.
 *
 * ⚠️ NO la unifiques con el poll de 1500 ms del seguimiento (`flow.tsx:525`). Coinciden en el número
 * y no tienen nada que ver: ése mide cada cuánto se le pregunta al backend por una remesa viva.
 *
 * Los tests de la gracia NO importan esta constante: avanzan el reloj con `1499` y `1500` LITERALES.
 * Un test que avanzara por la propia constante que vigila pasaría con cualquier valor, incluidos diez
 * minutos — sería un guard que se compara consigo mismo (CD-8).
 */
export const WALLET_GRACE_MS = 1500;

/** Suscribe useWallet()/useWalletModal() y empuja al singleton React-free. No renderiza DOM.
 *  Exportado SÓLO para el test de la carrera del auto-cierre del modal (ver abajo): montarlo suelto
 *  es la única forma de controlar `visible`/`connecting` cuadro por cuadro. */
export function SolanaWalletBridgeSync(): null {
  const { publicKey, connected, connecting, signMessage, signTransaction, wallets } = useWallet();
  const { setVisible, visible } = useWalletModal();

  // Registra el handle imperativo openModal (capturado desde useWalletModal).
  useEffect(() => {
    solanaWalletBridge.registerOpenModal(() => setVisible(true));
  }, [setVisible]);

  // HU-SOL-8: registra el handle imperativo signMessage (capturado desde useWallet). Sólo si la wallet
  // lo expone (Phantom/Solflare sí; el tipo del adapter es `... | undefined`).
  useEffect(() => {
    if (signMessage) solanaWalletBridge.registerSignMessage((bytes) => signMessage(bytes));
  }, [signMessage]);

  // HU-SOL-5: el gemelo del de arriba, para FIRMAR LA TRANSACCIÓN del depósito.
  //
  // ⚠️ ESTE EFECTO NO EXISTÍA. El bridge decía "registrado por el sync component" y nadie lo
  // registraba: el único `registerSignTransaction()` del repo vivía en los tests, que se lo pasan a
  // mano y por eso pasaban. En el navegador `signTransaction()` tiraba `wallet_sign_not_available`
  // SIEMPRE, así que el depósito al escrow no se podía firmar desde la app en ninguna plataforma. No
  // se veía porque el flujo se cortaba antes, en el prepare del payout.
  useEffect(() => {
    if (signTransaction)
      solanaWalletBridge.registerSignTransaction((tx) =>
        signTransaction(tx as Parameters<NonNullable<typeof signTransaction>>[0]),
      );
  }, [signTransaction]);

  // ¿Alguna wallet se INYECTÓ en esta pestaña? `wallets` es la lista viva que arma WalletProviderBase
  // y se re-emite en cada `readyStateChange` (WalletProviderBase.js:104-118), así que esto sigue a la
  // detección asíncrona de la librería en vez de congelar una foto del montaje.
  //
  // El criterio es `Installed` y NADA MÁS. `Loadable` NO sirve para esto: Solflare reporta `Loadable`
  // SIEMPRE, hasta en un escritorio sin ninguna extensión (medido), y Phantom reporta `Loadable` en
  // iOS sólo para poder redirigir a su universal link. O sea que "hay algo Loadable" no distingue el
  // caso que nos importa. `Installed` significa exactamente una cosa: encontramos la API de una wallet
  // en el scope global de ESTE navegador.
  //
  // Y por eso NO se mira el user agent. La pregunta que importa es "¿hay wallet acá?", no "¿es un
  // celular?": un celular DENTRO del navegador de Phantom inyecta igual que un escritorio con la
  // extensión (medido: `Phantom=Installed` con user agent de Android), y ahí no hay nada que avisar.
  // 🔴 Y ACÁ ESTABA LA CARRERA, medida en la fuente de la librería y no supuesta. Este efecto escribía
  // `"none"` en el PRIMER render tras el montaje si ningún adapter reportaba `Installed`. En ese primer
  // render la lista de Wallet Standard es la foto SÍNCRONA de
  // node_modules/@solana/wallet-standard-wallet-adapter-react/src/useStandardWalletAdapters.ts:10; las
  // altas llegan después, por `on('register')` (:12-26). O sea que en un teléfono DENTRO del navegador
  // de Phantom la app afirmaba "no vemos ninguna wallet" en su única puerta de entrada, y lo afirmaba
  // antes de tener con qué.
  //
  // El arreglo es una gracia corta ANCLADA AL MONTAJE, en dos efectos:
  //   · Efecto A (deps `[wallets]`): si hay `Installed` escribe `"injected"`; si no hay y la gracia YA
  //     venció escribe `"none"`; si no hay y la gracia sigue en curso NO escribe nada, o sea deja el
  //     `"unknown"` inicial, que es el valor que no habilita a afirmar nada (CD-2: `NoWalletHere` sólo
  //     pinta con `"none"`).
  //   · Efecto B (deps `[]`): UN solo `setTimeout` que marca la gracia como vencida y, si en ESE
  //     instante no hay `Installed`, escribe `"none"`.
  //
  // EL TIMER NO SE RE-ARMA, y eso no es cosmético. Si el `clearTimeout` viviera en el cleanup de
  // `[wallets]`, la pared se correría en cada cambio de identidad de `wallets`, y esa identidad cambia
  // en cada `readyStateChange`
  // (node_modules/@solana/wallet-adapter-react/lib/cjs/WalletProviderBase.js:104-118): el retraso total
  // pasaría a depender de cuántas transiciones emita la librería. Por eso el efecto B lee un ref
  // espejo (`hayInstaladaRef`) en vez de la closure de `wallets`. T-341-9 pone esa versión en rojo.
  //
  // EL CRITERIO SIGUE SIENDO `Installed` Y NADA MÁS. `Loadable` está prohibido acá: Solflare lo fija en
  // su constructor (node_modules/@solana/wallet-adapter-solflare/lib/cjs/adapter.js:67-69), así que
  // aceptarlo borraría el aviso en TODO dispositivo, no sólo en el que hoy pierde la carrera. T-341-12
  // es el par que lo impide.
  const hayInstaladaRef = useRef(false);
  const graciaVencidaRef = useRef(false);

  useEffect(() => {
    const hayInstalada = wallets.some((w) => w.readyState === WalletReadyState.Installed);
    hayInstaladaRef.current = hayInstalada;
    if (hayInstalada) solanaWalletBridge.setWalletAvailability("injected");
    else if (graciaVencidaRef.current) solanaWalletBridge.setWalletAvailability("none");
  }, [wallets]);

  useEffect(() => {
    const t = setTimeout(() => {
      graciaVencidaRef.current = true;
      if (!hayInstaladaRef.current) solanaWalletBridge.setWalletAvailability("none");
    }, WALLET_GRACE_MS);
    return () => clearTimeout(t);
  }, []);

  // Empuja el estado en cada cambio. base58 OPACO (CD-3): publicKey.toBase58(), SIN toLowerCase.
  useEffect(() => {
    solanaWalletBridge.setState({
      publicKey: publicKey ? publicKey.toBase58() : null,
      connected,
    });
  }, [publicKey, connected]);

  // Best-effort cancel: el modal se cerró y NO hay conexión en curso → la persona salió del selector
  // sin elegir nada.
  //
  // ⚠️ EL `!connecting` NO ES DEFENSIVO, ES EL ARREGLO. WalletModal cierra solo 150 ms DESPUÉS de que
  // tocás una wallet (`select(name)` y acto seguido `setTimeout(() => setVisible(false), 150)`, ver
  // node_modules/@solana/wallet-adapter-react-ui/lib/cjs/WalletModal.js:65-76). Sin este guard, ese
  // cierre automático disparaba `cancelConnection()` a los 150 ms del toque, o sea MUCHO antes de que
  // nadie llegue a aprobar en un teléfono, y rechazaba una conexión que estaba perfectamente viva.
  // En el escritorio no se veía: con la extensión ya autorizada la conexión resuelve antes de los
  // 150 ms y `settle()` gana la carrera. En el celular la perdía siempre.
  //
  // Y se exige una TRANSICIÓN abierto → cerrado, no el mero hecho de estar cerrado: con la segunda
  // lectura, montar el árbol (que arranca con el modal cerrado) contaba como "cerró el selector" y
  // cancelaba cualquier espera viva. Un cierre es un cambio, no un estado.
  const wasVisible = useRef(false);
  useEffect(() => {
    const justClosed = wasVisible.current && !visible;
    wasVisible.current = visible;
    if (justClosed && !connected && !connecting) solanaWalletBridge.cancelConnection();
  }, [visible, connected, connecting]);

  return null;
}

/** Único lugar que sabe POR QUÉ falló una conexión: la lib entrega el WalletError acá y en ningún
 *  otro lado. Lo traducimos a un código interno y cortamos la espera del adapter con esa causa, en
 *  vez de dejarla morir en el timeout de 120 s o disfrazarla de cancelación. */
function useWalletErrorHandler(): (error: unknown) => void {
  return useCallback((error: unknown) => {
    solanaWalletBridge.failConnection(walletErrorCode(error));
  }, []);
}

export default function SolanaProviders({ children }: { children: React.ReactNode }) {
  // Endpoint = resolveSolanaRpcUrlPublic() — NUNCA resolveSolanaRpcUrl() (server-only, PROHIBIDO:
  // su env no es NEXT_PUBLIC y no debe viajar al bundle del browser). El resolver público lee
  // NEXT_PUBLIC_SOLANA_RPC_URL y cae al endpoint público de la lib si no está, así que este cambio
  // no puede dejar el árbol sin endpoint. Motivo: el RPC público de Solana está muy limitado por
  // tasa y desde una red móvil es donde más se nota.
  const endpoint = useMemo(
    () => resolveSolanaRpcUrlPublic(resolveSolanaNetworkConfig().cluster),
    [],
  );
  const wallets = useMemo(
    () => [new PhantomWalletAdapter(), new SolflareWalletAdapter()],
    [],
  );
  const onError = useWalletErrorHandler();
  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={wallets} autoConnect onError={onError}>
        <WalletModalProvider>
          <SolanaWalletBridgeSync />
          {children}
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
