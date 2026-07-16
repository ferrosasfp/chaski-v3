# Validation Report — HU WKH-168 (COMPACT)

**Veredicto**: APROBADO PARA DONE
**Fecha**: 2026-07-15
**QA**: F4, sobre working tree sin commitear (HEAD `bda96ba`, verificado leyendo el árbol real, no `git diff` sobre untracked)

## Runtime checks
- Gate `npm run qa` (corrido por mí, no solo leído del CR): `tsc --noEmit` exit 0; `vitest run` → **362/362 tests, 30 test files, 0 fail**.
- **CD-1 (flags OFF) — verificado**: `.env.example` documenta `NEXT_PUBLIC_EIP3009_ENABLED=` y `NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER=` vacíos; `.env.local` — `grep -n "EIP3009\|VALUE_DELIVERY_ADAPTER" .env.local` → 0 matches (ausentes). CD-1 sostenido.
- **Env parity**: `FACILITATOR_BASE_URL`/`FACILITATOR_API_KEY` (`facilitator-client.ts:83-84`), `AVALANCHE_RPC_URL` (`onchain-verifier.ts:59`), `SETTLE_ATTESTATION_SECRET` (`attestation.ts:31,66`; `submit/route.ts:116`) — los 4 documentados en `.env.example:94,99,105,111`, todos server-only (sin `NEXT_PUBLIC_`), nombres coinciden exacto código↔doc.
- Sin migraciones/DB (confirmado por scope: única persistencia es el flag Upstash `SET NX` single-use de la atestación, no remesa — CD-8/WKH-207 fuera de scope, documentado).
- Greps de CD (corridos por mí):
  - CD-18 (`writeContract` en `src`/`app`) → **0**
  - CD-19 (`getRandomValues` en `wallet.ts`) → **0**
  - CD-21 (`facilitator`/`FACILITATOR` en `onchain-verifier.ts`) → **0**
  - CD-20 (`grep -rln "FACILITATOR_" src app`) → **2** (`facilitator-client.ts` + `app/api/settle/principal/route.test.ts`); verificado que el 2º NO lee `process.env.FACILITATOR_*` (usa `vi.stubEnv` para configurar el módulo bajo test) — el único lector de producción es `facilitator-client.ts` (confirmado también con `grep -rn "process.env.FACILITATOR_"` → únicamente `facilitator-client.ts:57,83,84`). CD-20 sostenido.
- Scope de archivos (CD-22, "exactamente 24 archivos de código"): `git status --short` + expansión de los 3 directorios untracked → **26 entradas**, de las cuales 2 son no-código (`doc/sdd/_INDEX.md` bookkeeping, `tsconfig.tsbuildinfo` build cache) → **24 archivos de código**, coincide con la tabla del Story File. Drift: none.

## ACs (11)

| AC | Status | Evidencia |
|----|--------|-----------|
| AC-1 | PASS | `confirm-and-send.test.ts:359` "modo real ⇒ settle() recibe la AUTORIZACIÓN COMPLETA" |
| AC-2 | PASS | `confirm-and-send.test.ts:494,515` (C4/C5 mismatch → `payout_failed`, sin `principal_in`); verificación real independiente de la cadena en `onchain-verifier.ts` (V1-V9), `onchain-verifier.test.ts` (9 tests) |
| AC-3 | PASS | `confirm-and-send.test.ts:440` (todo `SettlementFailureReason` → `payout_failed`, `principalTx` null), `:472` (throw de red no escapa) |
| AC-4 | PASS | `confirm-and-send.test.ts:380` "principalTx es el HASH VERIFICADO on-chain, NUNCA la firma cruda" |
| AC-5 | PASS | `wallet.test.ts` — `git diff -U0` confirma que los únicos cambios en los tests pre-existentes son args de setup (`authorizePrincipal(quote, "rem-1")`); asserts intactos. `container.test.ts:81` "flag OFF → ConfirmAndSend NO recibe settlement". Preservado por construcción (`container.ts:78-88`, 7º param opcional) |
| AC-6 | PASS | `confirm-and-send.ts:62` (`principal_settled_refund_manual`), `confirm-and-send.test.ts:537,560,561,579,580` |
| AC-7 | PASS | `app/api/settle/principal/route.test.ts:118` (Bearer + contrato de ENV, no del body), `:137` (respuesta al cliente nunca contiene la API key/base URL/RPC) |
| AC-8 | PASS | `container.ts:57-68` guard fail-loud byte-idéntico; `container.test.ts:21,27,34,50,59` (CD-3/4/16 + formato) — 11 tests confirmados por el runner |
| AC-9 | PASS | `ports.ts:115-119` comentario inline explícito: "Esta HU EMPEORA la consecuencia (antes no había plata; ahora sí)... → WKH-207"; residual también en `confirm-and-send.ts:55-60` (DT-8, clawback imposible) |
| AC-10 | PASS | `app/api/a2a/payout/submit/route.test.ts:334,353,369,380,393,421,437,517` (A3-A7′, incl. fix-pack `quoteId` swap A7′) |
| AC-11 | PASS | `route.test.ts:489` (replay → 409), `:502` (Upstash caído → 503 fail-closed, nunca forward) |

## Drift
- **none** en scope de archivos (24/24 código, coincide con la tabla del Story File; extensiones de `gateways.ts` y `submit/route.ts` corresponden a AC-10/AC-11, aprobados en el gate SPEC_APPROVED, no scope creep).
- Residual honestamente documentado (no suavizado): G3 cerrado pero NO habilita Fase A — faltan G5/WKH-206, Mitad B/TransFi, partners/legal (`story-WKH-168.md:1070-1072`, `sdd.md:435`); WKH-207 (huérfanas + atestación quemada con forward fallido) y clawback imposible (DT-8) nombrados explícitamente en código (`ports.ts:115-119`, `confirm-and-send.ts:55-60`), no solo en docs.
- `auto-blindaje.md`: honesto — registra 2 declaraciones de fundamento no reproducido (patrón WKH-203/204), la vacuidad de `git diff` sobre untracked (resuelto con `md5sum -c`, 7/7 OK), y el mutante fail-open sobreviviente en el primer test de `att.chainId` (fix-pack #2, ahora 4/4 mutantes muertos con el assert hostil `chainId` en el body). Ningún hallazgo suavizado.

## Gates (confirmados con mi propia salida — no solo leídos del CR)
- `tsc --noEmit`: exit 0
- `vitest run`: 362/362 passed, 30 test files
- Los 4 greps de CD (18/19/20/21): confirmados arriba
- CD-1 (flags off): confirmado arriba

## AR/CR follow-up
- AR (0 BLQ, 4 MNR, 17 mutantes) + CR (0 BLQ, 5 MNR) → fix-pack (3 items: `quoteId` binding A7′, comentario C4 corregido de "guard" a "eco/canario", `receiver` acoplado al gateway en vez de import application→infrastructure) → re-AR (0 BLQ, 2 MNR, 11 mutantes) → fix-pack #2 (`att.chainId` guard + assert hostil, 4/4 mutantes muertos).
- Todos los fix-packs verificados en el código presente (no solo declarados): `ports.ts:115-119`, `confirm-and-send.ts:26-41` (receiver acoplado), `submit/route.ts` (A7′/quoteId, tests línea 437), `route.test.ts:437-486` (chainId hostil).

**Listo para DONE.**
