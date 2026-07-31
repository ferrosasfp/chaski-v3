"use client";
// WKH-320: Chaski es una DApp Solana. El árbol de providers Solana se monta SIEMPRE, vía next/dynamic
// (chunk aislado, ssr:false). Ya no hay dispatcher por VM porque ya no hay una segunda VM.
import dynamic from "next/dynamic";

const SolanaProviders = dynamic(() => import("./solana/solana-providers"), { ssr: false });

export function Providers({ children }: { children: React.ReactNode }) {
  return <SolanaProviders>{children}</SolanaProviders>;
}
