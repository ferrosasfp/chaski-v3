// WKH-227 / HU-SOL-24 — hash canónico del IDL del escrow (DT-1). Idéntico algoritmo que W2
// (wasiai-facilitator): JSON canónico con claves ordenadas + SHA-256. Permite comparar el IDL
// pinneado en chaski (src/infrastructure/solana/escrow-idl.ts) contra la constante congelada y,
// best-effort, contra el sibling solana-programs/target/idl/escrow.json (AC-2/AC-3). Solo LECTURA.
import { createHash } from "node:crypto";

export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return "[" + v.map(canonicalJson).join(",") + "]";
  if (v !== null && typeof v === "object") {
    const obj = v as Record<string, unknown>;
    return (
      "{" +
      Object.keys(obj)
        .sort()
        .map((k) => JSON.stringify(k) + ":" + canonicalJson(obj[k]))
        .join(",") +
      "}"
    );
  }
  return JSON.stringify(v);
}

export function canonicalSha256(obj: unknown): string {
  return createHash("sha256").update(canonicalJson(obj), "utf8").digest("hex");
}
