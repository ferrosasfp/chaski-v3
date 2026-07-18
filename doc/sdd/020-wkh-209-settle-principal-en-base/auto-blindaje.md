# Auto-Blindaje — WKH-209 (settle del principal Avalanche → Base)

Errores cometidos + corregidos durante F3, y resultado del mutation self-check (obligatorio).

### [2026-07-17] W1.3 — old_string mal transcrito en .env.example
- **Error**: el `Edit` del bloque RPC falló ("String to replace not found"). Copié "significa" cuando el archivo decía "signifique".
- **Causa raíz**: transcribí de memoria del Read en vez de copiar textual el token exacto.
- **Fix**: re-leí las líneas 115-120 y usé el string exacto ("signifique").
- **Aplicar en**: siempre copiar verbatim del Read inmediato antes de un Edit sobre prosa larga; no reconstruir de memoria.

### [2026-07-17] Auto-blindaje mutación (c) — const sin usar rompería tsc-strict
- **Error**: al montar el MUTANT-C introduje `const rpc2 = rpc ?? "..."` sin usarlo → `noUnusedLocals` habría tirado tsc antes de correr el test (falso "kill" por typecheck, no por el assert).
- **Causa raíz**: quise forzar un fallback pero el mutante correcto es simplemente comentar el `if (!rpc) return`.
- **Fix**: quité `rpc2`; `http(rpc)` acepta `string | undefined`, así el mutante ejercita la rama sin ruido de tsc.
- **Aplicar en**: un mutante debe morir por el ASSERT del test, no por typecheck; mantenerlo mínimo.

## Mutation self-check (3/3 — cada uno mató ≥1 test, todos revertidos)

| # | Mutación | Test que murió | Reason |
|---|----------|----------------|--------|
| (a) | `NETWORKS[84532].eip712.name` `"USDC"` → `"USD Coin"` | `wallet.test.ts` AC-4 (`domain.name==='USDC'`) | `expected 'USD Coin' to be 'USDC'` — el name está atado a la red |
| (b) | `resolveRpcUrl()` case `BASE_SEPOLIA_RPC_URL` → `process.env.AVALANCHE_RPC_URL` | `onchain-verifier.test.ts` AC-6 KILLER (+ happy tests) | leería la cadena (getReceiptMock llamado) → el killer prueba que NO se lee el env viejo |
| (c) | comentar `if (!rpc) return settle_unverified` | `onchain-verifier.test.ts` V1/AC-11 + KILLER | `getReceiptMock` se llama cuando no debía → fail-closed roto |

Los 3 restaurados. `grep -rn MUTANT src app` = 0 tras revertir. `npm run qa` verde (36 files / 460 tests, tsc 0).

## [STORY-GAP] comentario stale en código fuera de scope
- `app/api/a2a/payout/submit/route.ts:251` tiene un comentario `// ... resolveChainId() no tira (chain.ts:9-13 hace fallback a 43114) ...`. El fallback ahora es 84532 (Base Sepolia) y la línea cambió.
- El comentario es pura prosa; la afirmación funcional ("no tira") sigue siendo VERDADERA. No afecta comportamiento ni tests.
- NO lo toqué: CD-2 + "Out of Scope" prohíben modificar el código de `submit/route.ts` (solo su test). CD-6 exceptúa "comentarios históricos explícitos". Se escala al Architect para que decida si lo actualiza en una HU de scope de esa ruta.
