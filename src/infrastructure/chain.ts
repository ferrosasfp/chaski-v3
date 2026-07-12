// Infrastructure — chain env-driven (M1/AC-7, CD-5). ÚNICA fuente del chainId para AMBOS
// adapters de WalletPort (InjectedWallet + WalletConnectWallet). PROHIBIDO hardcodear el
// chainId en un adapter y config en el otro.
import { type Chain, isAddress } from "viem";
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

/** Dirección del contrato USDC para la firma EIP-3009 (WKH-186/DT-10, CD-14/CD-16). ÚNICA fuente
 * (env `NEXT_PUBLIC_USDC_CONTRACT_ADDRESS`); fail-loud si falta o está malformada — NUNCA se
 * hardcodea el contrato (el `.env.example` documenta el USDC canónico de Circle por chain como
 * comentario). Sólo se llama en la rama EIP-3009 real, ya gateada por el guard del container. */
export function resolveUsdcAddress(): `0x${string}` {
  const raw = process.env.NEXT_PUBLIC_USDC_CONTRACT_ADDRESS;
  if (!raw || !isAddress(raw)) throw new Error("usdc_contract_not_configured"); // fail-loud
  return raw;
}

/** Dirección del RECEIVER del payout (destino de la firma EIP-3009, WKH-186/MNR-A). Simétrico con
 * `resolveUsdcAddress`: ÚNICA fuente (env `NEXT_PUBLIC_PAYOUT_RECEIVER_ADDRESS`); fail-loud si falta
 * o está MALFORMADA (`isAddress`). Antes se tomaba con `as \`0x${string}\`` crudo → un typo con
 * checksum válido firmaría al destino equivocado. Se usa en el guard del container (la app NO arranca
 * con un receiver malformado cuando EIP-3009 está on) y en wallet.ts (en lugar del cast crudo). */
export function resolveReceiverAddress(): `0x${string}` {
  const raw = process.env.NEXT_PUBLIC_PAYOUT_RECEIVER_ADDRESS;
  if (!raw || !isAddress(raw)) throw new Error("payout_receiver_not_configured"); // fail-loud
  return raw;
}
