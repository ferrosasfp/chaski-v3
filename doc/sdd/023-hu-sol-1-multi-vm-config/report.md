# Report — HU-SOL-1 / WKH-206: Config de red multi-VM (EVM + Solana)

**Status: DONE (2026-07-21)** · Branch `feat/023-hu-sol-1-multi-vm-config` · impl `1b6aa22` · cierre `60c69a0`

## Resumen
Fundación del port a Solana (Solana LATAM Labs). Generaliza `chain.ts` y `ports.ts` de EVM-only a multi-VM (`vm: 'evm' | 'solana'`) sin tocar el path EVM vivo. NO agrega wallet Solana, firma SPL, binding ni settle (eso es HU-SOL-2/4+). Devnet, cero plata real.

**Entrega:** 7/7 ACs PASS · `npm run qa` = typecheck 0 + **562 tests** (553 EVM intactos + 9 Solana nuevos) · build OK · mutation self-check 3/3 · AR + CR + F4 APROBADOS (0 bloqueantes).

## Acceptance Criteria (veredicto F4, evidencia archivo:línea)

| AC | Veredicto | Evidencia |
|----|-----------|-----------|
| AC-1 · EVM byte-idéntico | PASS | 6 resolvers EVM firma+cuerpo intactos (`chain.ts:48-96`); 0 `expect` EVM removidos (`git diff` de `chain.test.ts`); 553 tests EVM verdes |
| AC-2 · Config Solana resolvible | PASS | `chain.ts` `resolveSolanaNetworkConfig` + dispatcher `resolveActiveNetworkConfig`; test asserta `vm:'solana'`, `cluster:'devnet'`, sin `viemChain` |
| AC-3 · Validación PublicKey fail-loud | PASS | `resolveSolanaUsdcMint` usa `new PublicKey(raw)` try/catch (nunca `isAddress`); test cubre válido/ausente/malformado + rechazo de address EVM (CD-2) |
| AC-4 · `VmAuthorization` discriminado | PASS | `ports.ts` `EvmAuthorization`/`SolanaAuthorization`/`VmAuthorization` a nivel envelope; `Eip3009Authorization` intacto (6 campos) |
| AC-5 · WalletPort/money-path intacto | PASS | 0 archivos de money-path tocados (`wallet.ts`/gateways/rutas/`fakes.ts`); default `resolveActiveVm()` = `'evm'` |
| AC-6 · VM no soportada → fail-loud | PASS | `throw "unsupported_vm"` en resolver + dispatcher; test `NEXT_PUBLIC_VM='aptos'` → throw |
| AC-7 · typecheck/build íntegros | PASS | `tsc --noEmit` 0 errores + `next build` OK |

## Cadena de gates
HU_APPROVED (clinical review) → SPEC_APPROVED (clinical review) → F2.5 Story File → F3 (6 archivos Scope IN) → **AR** APROBADO (7 vectores de ataque, 0 BLQ) → **CR** APROBADO (8/8 checklist) → **F4 QA** APROBADO (7/7 ACs, drift NONE) → DONE.

## Decisiones arquitectónicas clave
1. **Discriminación a nivel ENVELOPE**, no dentro del payload EIP-3009: la `authorization` se firma y serializa cruda al money-path, así que el tag `vm` vive en la envoltura `{ vm, authorization, signature }`; `Eip3009Authorization` queda inmutable. Evita mutar el body serializado de `/api/settle/principal` (CD-3).
2. **`NEXT_PUBLIC_VM` ortogonal** (default `evm` fail-safe; valor inválido explícito → throw fail-loud). Garantiza byte-identidad: ningún test EVM setea la env → siempre caen en la rama `evm`.
3. **Config Solana separada** (keyed por cluster, no chainId numérico); resolvers EVM intactos, resolvers Solana nuevos, dispatcher con `switch` literal.
4. **`@solana/web3.js` v1** para validar base58 con `PublicKey` (patrón derivado de lib, análogo a viem del lado EVM).

## Archivos modificados (Scope IN exacto)
`package.json` (+`@solana/web3.js@^1.98.4`), `package-lock.json`, `src/application/ports.ts`, `src/infrastructure/chain.ts`, `src/infrastructure/chain.test.ts`, `.env.example` (3 envs Solana documentadas, vacías).

## Desbloquea
HU-SOL-2/4/5/7/8/9 (necesitan `VmAuthorization` + config multi-VM en main).

## Pendiente (orquestador)
Merge de la branch a `main` — diferido a la decisión de integración de cierre de Sprint 1.
