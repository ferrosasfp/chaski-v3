"use client";
// Árbol @solana/wallet-adapter-react — montado SOLO cuando VM=solana (vía next/dynamic en
// providers.tsx). Único archivo que importa la lib + su CSS (seam AC-3). El sync component empuja
// el estado de useWallet() al singleton React-free y registra openModal.
import { useEffect, useMemo } from "react";
import { clusterApiUrl } from "@solana/web3.js";
import { ConnectionProvider, WalletProvider, useWallet } from "@solana/wallet-adapter-react";
import { WalletModalProvider, useWalletModal } from "@solana/wallet-adapter-react-ui";
import { PhantomWalletAdapter, SolflareWalletAdapter } from "@solana/wallet-adapter-wallets";
import { resolveSolanaNetworkConfig } from "../../infrastructure/chain";
import { solanaWalletBridge } from "../../infrastructure/solana-wallet-bridge";
import "@solana/wallet-adapter-react-ui/styles.css";

/** Suscribe useWallet()/useWalletModal() y empuja al singleton React-free. No renderiza DOM. */
function SolanaWalletBridgeSync(): null {
  const { publicKey, connected } = useWallet();
  const { setVisible, visible } = useWalletModal();

  // Registra el handle imperativo openModal (capturado desde useWalletModal).
  useEffect(() => {
    solanaWalletBridge.registerOpenModal(() => setVisible(true));
  }, [setVisible]);

  // Empuja el estado en cada cambio. base58 OPACO (CD-3): publicKey.toBase58(), SIN toLowerCase.
  useEffect(() => {
    solanaWalletBridge.setState({
      publicKey: publicKey ? publicKey.toBase58() : null,
      connected,
    });
  }, [publicKey, connected]);

  // Best-effort cancel: modal cerrado sin conexión → rechaza la espera pendiente del adapter.
  useEffect(() => {
    if (!visible && !connected) solanaWalletBridge.cancelConnection();
  }, [visible, connected]);

  return null;
}

export default function SolanaProviders({ children }: { children: React.ReactNode }) {
  // Endpoint = clusterApiUrl(cluster) — NUNCA resolveSolanaRpcUrl() (server-only, PROHIBIDO).
  const endpoint = useMemo(() => clusterApiUrl(resolveSolanaNetworkConfig().cluster), []);
  const wallets = useMemo(
    () => [new PhantomWalletAdapter(), new SolflareWalletAdapter()],
    [],
  );
  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>
          <SolanaWalletBridgeSync />
          {children}
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
