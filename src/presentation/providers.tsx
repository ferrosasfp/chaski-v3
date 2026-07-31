"use client";
// El árbol de providers de Solana se monta SIEMPRE, vía next/dynamic (chunk aislado, ssr:false).
// No hay nada que despachar: no hay una segunda opción.
import dynamic from "next/dynamic";

const SolanaProviders = dynamic(() => import("./solana/solana-providers"), { ssr: false });

export function Providers({ children }: { children: React.ReactNode }) {
  return <SolanaProviders>{children}</SolanaProviders>;
}
