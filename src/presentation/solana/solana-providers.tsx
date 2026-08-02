"use client";
// Árbol @solana/wallet-adapter-react — montado SOLO cuando VM=solana (vía next/dynamic en
// providers.tsx). Único archivo que importa la lib + su CSS (seam AC-3). El sync component empuja
// el estado de useWallet() al singleton React-free y registra openModal.
import { useCallback, useEffect, useMemo, useRef } from "react";
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

/** Suscribe useWallet()/useWalletModal() y empuja al singleton React-free. No renderiza DOM.
 *  Exportado SÓLO para el test de la carrera del auto-cierre del modal (ver abajo): montarlo suelto
 *  es la única forma de controlar `visible`/`connecting` cuadro por cuadro. */
export function SolanaWalletBridgeSync(): null {
  const { publicKey, connected, connecting, signMessage, signTransaction } = useWallet();
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
