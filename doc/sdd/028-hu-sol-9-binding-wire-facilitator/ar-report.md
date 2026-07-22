# AR Report — HU-SOL-9 / WKH-208 (Wave W4 · facilitator schema base58)

**Veredicto: APROBADO con MENORs (0 BLOQUEANTE).**
Fecha: 2026-07-22 · Repo: `wasiai-facilitator` · Evidencia: `tsc --noEmit` limpio, `npm test` 993 passed (979 EVM byte-idénticos + 14 TF).

## Vectores atacados
1. **EVM byte-identidad / orden del union (CD-1) — OK.** Ramas disjuntas por discriminante: `0x`-hex contiene `0` (no base58) → `new PublicKey('0x…')` tira → rama Solana rechaza todo EVM; `AddressHexSchema` rechaza base58. Solana va última en el `z.union` (primera-que-matchea). Repro Node confirmó: `EVM 0x as pubkey=false`, `sol pk as pubkey=true`. TF2 asserta `evmWithBase58 → success:false`.
2. **Desacople tipo estático (`as unknown as z.ZodType<VerifyRequest>`) — OK (vector crítico).** Trazados TODOS los consumers de `.data`: `settleCore`/`verifyCore` early-return al adapter en `namespace==='solana'` ANTES de los reads EVM (`accepted.extra.assetTransferMethod` settle:123/verify:99, `payload.authorization` cap-check). Routes solo leen campos comunes (`payTo`/`network`) + `buildSettleIdempotencyKey` (hash del objeto entero, `idempotency.ts:325`). `buildLedgerEntry` degrada a `payer:''` sin throw. Campos Solana solo consumidos por `_parseSolanaInput` (boundary cast propio). El tipo mentiroso NO esconde bug.
3. **Base58 laxo / type-confusion / anti-smuggling — OK.** `Base58*Schema` idénticos al criterio del adapter (`isBase58Pubkey/Signature`, CD-9). `0x`-hex rechazado en ambos. `.strict()` rechaza `extra.assetTransferMethod` (TF3).
4. **Bypass del gate — OK por diseño.** El schema es gate de forma; la atestación `payTo==beneficiary` vive server-side en chaski y la verificación real es on-chain (adapter). Un `payTo` arbitrario no matchea tx finalizada → verify falla.
5. **Scope / Ownership Guard (CD-4') — OK.** `git status` acotado a 2 schemas + 2 tests. Ninguna query sobre `a2a_agent_keys`/`tasks` → Ownership Guard N/A.

## Findings (MENOR, no bloquean)
- **MNR-1 (test coverage, informational)** `routes.settle.solana.test.ts:23-33`: TF4 mockea `buildLedgerEntry` → el path ledger-sobre-Solana se valida por inspección (código real degrada sin throw), no por test.
- **MNR-2 (data integrity, carry-forward a HU-SOL-13)** `routes/settle.ts:287,339,381`: un settle Solana que llega al ledger se persiste con `method:'eip3009'` hardcodeado → fila mislabeleada como EVM (telemetría, no rompe funcionalidad). No fixeable acá (CD-4' prohíbe tocar `routes/*`); **deuda a resolver en el wiring de HU-SOL-13.**
