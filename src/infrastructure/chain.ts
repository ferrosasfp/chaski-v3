// Infrastructure — chain env-driven (M1/AC-7, CD-5). ÚNICA fuente del chainId para AMBOS
// adapters de WalletPort (InjectedWallet + WalletConnectWallet). PROHIBIDO hardcodear el
// chainId en un adapter y config en el otro.
import type { Chain } from "viem";
import { avalanche, avalancheFuji } from "viem/chains";

/** Deriva el chainId de NEXT_PUBLIC_CHAIN_ID. Solo Avalanche mainnet (43114) / Fuji (43113)
 * soportados; cualquier otra cosa (unset, "99", basura) → 43114 (prod actual, fail-safe). */
export function resolveChainId(): number {
  const raw = process.env.NEXT_PUBLIC_CHAIN_ID;
  const n = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return n === 43113 ? 43113 : 43114;
}

/** El objeto Chain de viem correspondiente al chainId resuelto (CD-9: derivado de la lib). */
export function resolveChain(): Chain {
  return resolveChainId() === 43113 ? avalancheFuji : avalanche;
}
