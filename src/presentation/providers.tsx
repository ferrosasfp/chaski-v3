"use client";
// Dispatcher de providers gateado por VM. En "evm" → passthrough (cero DOM/contexto/chunk Solana,
// AC-3). En "solana" → árbol Solana cargado vía next/dynamic (chunk aislado). resolveActiveVm()
// throwea con VM inválida → fail-loud en render (AC-5).
import dynamic from "next/dynamic";
import { resolveActiveVm } from "../infrastructure/chain";

const SolanaProviders = dynamic(() => import("./solana/solana-providers"), { ssr: false });

export function Providers({ children }: { children: React.ReactNode }) {
  if (resolveActiveVm() === "solana") {
    return <SolanaProviders>{children}</SolanaProviders>;
  }
  return <>{children}</>;
}
