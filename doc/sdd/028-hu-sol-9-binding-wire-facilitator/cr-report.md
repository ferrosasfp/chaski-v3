# CR Report — HU-SOL-9 / WKH-208 (Wave W4 · facilitator base58 wire)

**Veredicto: APROBADO (0 BLOQUEANTE).**
Fecha: 2026-07-22 · Repo: `wasiai-facilitator` · Build: `tsc --noEmit` OK · `npm test` 993/993 (979 EVM byte-idénticos + 14 TF).

## Checklist
1. **Corrección — OK.** La 3ª rama matchea 1:1 lo que `_parseSolanaInput` consume (`accepted.{network,asset,payTo,amount}` + `payload.{signature,reference?}`, `solana-adapter.ts:154-158`). `.strict()` rechaza `extra`/`authorization`. Primitivos base58 consistentes con `isBase58Pubkey/Signature` del adapter (CD-9). Nota inofensiva: el schema rechaza `reference:""` (más estricto que el adapter que lo tolera como null) — chaski nunca envía `""`.
2. **Cast `as unknown as z.ZodType<VerifyRequest>` (`core/schemas.ts:201-205`) — OK.** Patrón sancionado (mismo de `core/settle.ts:144`), bien comentado, type-lie contenido (ningún consumer deref-ea `.accepted.extra`/`.payload.authorization` sobre body Solana). No requiere DT nueva.
3. **Cobertura de tests — OK** con 4 MENOR opcionales (ver abajo).
4. **Byte-identidad EVM — OK.** Único cambio al path EVM = la línea del `z.union`. `Eip3009RequestSchema`/`NonEip3009RequestSchema`/`AcceptedSchema`/`PayloadSchema`/primitivos hex sin tocar.
5. **Naming/consistencia — OK.** Convención `<Dominio>Schema`, sin `any`, sin `console.log`.
6. **Idempotencia/seguridad — OK.** Regex base58/network lineales (sin ReDoS); `new PublicKey` en try/catch; `bodyLimit` Fastify default 1MB acota DoS; idempotency key = hash del body canónico.

## Findings (MENOR test-coverage, no bloquean — backlog opcional)
- **MNR-1** `eip3009/schemas.ts:105`: no se testea el límite superior de longitud de signature (>120).
- **MNR-2**: no se testea `reference` no-vacío pero inválido (rama refine).
- **MNR-3**: no se testea campo required faltante (rechazo Zod estándar, sin assert).
- **MNR-4** `core.schemas.solana.test.ts:171-185`: `payTo` base58 inválido no testeado (solo `asset`; simétricos).
