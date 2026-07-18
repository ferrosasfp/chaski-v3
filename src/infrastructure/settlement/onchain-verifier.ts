// Infrastructure — verificación on-chain INDEPENDIENTE del settlement (WKH-168, AC-2/CD-7/DT-5).
// ESTE ES EL CORAZÓN DE LA HU.
//
// ⚠️ POR QUÉ EXISTE: la respuesta del broadcaster es un ECO de nuestro propio input, NO una
// verificación. Chequear `res.to === receiver` compara nuestro input contra nuestro input: es una
// TAUTOLOGÍA que siempre pasa y no verifica nada (CD-10). Acá leemos el receipt NOSOTROS, con
// NUESTRO RPC, y buscamos el log `Transfer` EMITIDO POR EL CONTRATO USDC. Ese log lo emite el token,
// no nosotros: ahí sí `from`/`to`/`value` son hechos de la cadena.
//
// ⚠️ AGNÓSTICO DEL BROADCASTER (CD-21, directiva del gate — legal/PSAV): su input es un txHash de
// CUALQUIER origen. NO importa el cliente de broadcast, NO lee ninguna env de broadcast, y no sabe
// ni le importa quién transmitió. Si mañana el usuario se auto-broadcastea y nos postea el hash,
// este archivo funciona SIN CAMBIAR UNA LÍNEA. Leer una cadena no es "transferir en nombre de otro"
// ⇒ riesgo regulatorio NULO ⇒ sobrevive intacto a cualquier veredicto legal.
//
// CD-18: read-only puro. Cero wallet, cero clave privada, cero escrituras on-chain de ningún tipo.
import { createPublicClient, http, isAddressEqual, parseEventLogs } from "viem";
import { resolveChain, resolveRpcUrl, resolveUsdcAddress } from "../chain";

/** ABI mínima del evento Transfer de ERC-20. El CONTRATO no se hardcodea: sale de
 *  resolveUsdcAddress() (env-driven, fail-loud). */
const USDC_TRANSFER_ABI = [
  {
    type: "event",
    name: "Transfer",
    inputs: [
      { name: "from", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "value", type: "uint256", indexed: false },
    ],
  },
] as const;

export type VerifyFailureReason =
  | "settle_unverified" // V1/V2 (no se pudo verificar), V4 (0 logs), V5 (ambigüedad)
  | "settle_reverted" // V3
  | "settle_receiver_mismatch" // V6
  | "settle_sender_mismatch" // V7
  | "settle_amount_mismatch"; // V8

export type VerifyResult =
  | { ok: true; txHash: string; from: string; to: string; valueMinor: number }
  | { ok: false; reason: VerifyFailureReason };

export interface VerifyInput {
  /** De CUALQUIER origen (CD-21): nuestro relayer, el propio usuario, un tercero. Da igual. */
  txHash: string;
  expectedFrom: string;
  expectedTo: string;
  expectedValueMinor: number;
}

/**
 * Verifica leyendo la cadena. FAIL-CLOSED en cada rama (CD-12): si no podemos verificar, NO se
 * atestigua. Nunca throw.
 */
export async function verifySettlementOnChain(input: VerifyInput): Promise<VerifyResult> {
  // V1 — sin RPC no hay verificación posible ⇒ NO se atestigua (fail-closed, nunca "asumir que fue").
  const rpc = resolveRpcUrl(); // CD-14: env (indirecta, RPC de Base por red) leída dentro de la función
  if (!rpc) return { ok: false, reason: "settle_unverified" };

  let usdc: `0x${string}`;
  try {
    usdc = resolveUsdcAddress(); // fail-loud si falta/malformada → acá se captura → fail-closed
  } catch {
    return { ok: false, reason: "settle_unverified" };
  }

  // V2 — receipt no legible (throw/timeout/hash inexistente) ⇒ fail-closed.
  let receipt: { status: string; logs: unknown[] };
  try {
    const client = createPublicClient({ chain: resolveChain(), transport: http(rpc) });
    receipt = (await client.getTransactionReceipt({
      hash: input.txHash as `0x${string}`,
    })) as unknown as { status: string; logs: unknown[] };
  } catch {
    return { ok: false, reason: "settle_unverified" };
  }

  // V3 — la tx se minó pero REVIRTIÓ: no se movió nada.
  if (receipt.status !== "success") return { ok: false, reason: "settle_reverted" };

  // ⚠️ EL FILTRO VA SOLO POR EMISOR (el contrato USDC), JAMÁS por `to`.
  // Si filtráramos por `to === receiver`, el log superviviente tendría `to === receiver` POR
  // CONSTRUCCIÓN ⇒ V6 sería inalcanzable ⇒ el chequeo del receiver volvería a ser la tautología que
  // esta HU vino a matar (el bug reintroducido DENTRO de su propia solución). NO lo "simplifiques".
  let transfers: Array<{ args: { from: string; to: string; value: bigint }; address: string }>;
  try {
    transfers = parseEventLogs({
      abi: USDC_TRANSFER_ABI,
      eventName: "Transfer",
      logs: receipt.logs as never,
    }).filter((l) => isAddressEqual(l.address as `0x${string}`, usdc)) as unknown as Array<{
      args: { from: string; to: string; value: bigint };
      address: string;
    }>;
  } catch {
    return { ok: false, reason: "settle_unverified" };
  }

  // V4 — ningún Transfer del USDC en el receipt: la tx hizo otra cosa (o nada). NO hay evidencia.
  if (transfers.length === 0) return { ok: false, reason: "settle_unverified" };
  // V5 — un transferWithAuthorization de USDC (FiatTokenV2) emite EXACTAMENTE 1 Transfer. >1 es algo
  // que no entendemos ⇒ ambigüedad ⇒ BLOQUEAR. PROHIBIDO elegir "el primero" (sería fail-open: un
  // atacante metería su Transfer real de $0.01 junto a otro y nos haría verificar el equivocado).
  if (transfers.length > 1) return { ok: false, reason: "settle_unverified" };

  const t = transfers[0];
  if (!t) return { ok: false, reason: "settle_unverified" }; // defensivo (noUncheckedIndexedAccess)

  // V6/V7/V8 — asserts sobre el ÚNICO log, cada uno con su reason distinguible. Hechos de la cadena.
  let sameTo: boolean;
  let sameFrom: boolean;
  try {
    sameTo = isAddressEqual(t.args.to as `0x${string}`, input.expectedTo as `0x${string}`);
    sameFrom = isAddressEqual(t.args.from as `0x${string}`, input.expectedFrom as `0x${string}`);
  } catch {
    return { ok: false, reason: "settle_unverified" }; // address malformada ⇒ fail-closed
  }
  if (!sameTo) return { ok: false, reason: "settle_receiver_mismatch" }; // V6 — AC-2
  if (!sameFrom) return { ok: false, reason: "settle_sender_mismatch" }; // V7

  // V8 — igualdad EXACTA. El facilitador acepta value >= amount (base-adapter.ts:609) y reporta
  // accepted.amount: un settle honesto puede mover MÁS de lo que reporta. Somos MÁS ESTRICTOS que él
  // a propósito: acá comparamos contra el valor REAL del log. NO lo relajes a >=.
  if (t.args.value !== BigInt(input.expectedValueMinor)) {
    return { ok: false, reason: "settle_amount_mismatch" };
  }

  // V9 — verificado contra la cadena. Recién ACÁ se puede emitir la atestación (DT-7).
  return {
    ok: true,
    txHash: input.txHash,
    from: t.args.from,
    to: t.args.to,
    valueMinor: input.expectedValueMinor,
  };
}
