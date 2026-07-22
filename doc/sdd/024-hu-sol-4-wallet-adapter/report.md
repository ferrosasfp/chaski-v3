# Report — HU-SOL-4 / WKH-212: Integración `@solana/wallet-adapter` (React) en chaski-v3

## Resumen ejecutivo

**HU-SOL-4 / WKH-212** cierra la conexión de wallet Solana real (Phantom/Solflare) en chaski-v3, puenteada al `WalletPort` imperativo existente vía un singleton React-free, montada condicionalmente (NEXT_PUBLIC_VM=solana). El path EVM queda **byte-idéntico** (AC-3, regresión-cero). Implementa **SÓLO connect/getAddress con base58 real** — firma SPL (HU-SOL-2), PoP (HU-SOL-8) y settle Solana quedan fuera. **DONE (2026-07-21)**: 6/6 ACs PASS, 571 tests verdes (562 EVM + 9 nuevos), 0 BLQ/0 MENOR en AR/CR/F4, branch `feat/024-hu-sol-4-wallet-adapter` commit `2dd1758`.

---

## Pipeline ejecutado

| Fase | Estado | Fecha | Evidencia |
|------|--------|-------|-----------|
| **F0** | project-context cargado + baseline `npm run qa` ✓ | 2026-07-20 | Baseline verde preF1 |
| **F1 (HU_APPROVED)** | Work Item aprobado — 6 ACs EARS, 3 `[NEEDS CLARIFICATION]` cerrados en F2 | 2026-07-20 | `work-item.md` (196 líneas) |
| **F2 (SPEC_APPROVED)** | SDD FULL: Context Map (13 archivos), diseño del seam React-free, readiness check ✓ | 2026-07-21 | `sdd.md` (438 líneas) |
| **F2.5** | Story File: Anti-Hallucination checklist (13 hechos), 4 waves, código concreto | 2026-07-21 | `story-HU-SOL-4.md` (779 líneas) |
| **F3** | Implementación: W0→W3 COMPLETO. **571 tests: 562 EVM (intactos) + 9 nuevos**. `npm run qa` exit 0. | 2026-07-21 | `feat/024` commit `2dd1758` (9 ficheros) |
| **AR** | **8 vectores probados**: regresión EVM, side-effect bundle, seam React-free, base58 opaco, connect timeout, WalletPort intacto, mutation self-check. **APROBADO** (0 BLQ/0 MENOR). | 2026-07-21 | Auto-blindaje documentado |
| **CR** | Estructura: 5 críticos (bridge/adapter/providers/container/layout), TS strict, patrones exemplar. **APROBADO** (0 hallazgos). | 2026-07-21 | Tests cubren todos los paths |
| **F4 (VALIDADO)** | **6/6 ACs PASS**: AC-1 (árbol Solana montado), AC-2 (base58 sin transformar), AC-3 (EVM byte-idéntico), AC-4 (wiring gateado), AC-5 (VM inválida fail-loud), AC-6 (case-sensitive). **Drift: NONE**. | 2026-07-21 | Validation completada |

---

## Acceptance Criteria — resultado final

| AC | Status | Evidencia |
|----|--------|-----------|
| **AC-1** | PASS | `solana-providers.tsx:307-357` árbol montado; `providers.tsx:376-378` dispatcher; `providers.test.tsx` (jsdom) verifica montaje con VM=solana |
| **AC-2** | PASS | `solana-wallet.ts:438-453` abre modal + valida base58; devuelve OPACO sin `.toLowerCase()`; test verifica base58 sin transformar |
| **AC-3** | PASS | **Seam garantizado por construcción**: `solana-providers.tsx` (ÚNICO con `@solana/wallet-adapter-*`) cargado SÓLO via `next/dynamic({ssr:false})`; adapter/bridge React-free; VM=evm devuelve `<>{children}</>`; 562 tests EVM verdes SIN cambios |
| **AC-4** | PASS | `container.ts:493` dispatcher único: `resolveActiveVm()==="solana" ? new SolanaWalletAdapter() : pickWallet()`; test + mutation self-check confirmaN cobertura |
| **AC-5** | PASS | `resolveActiveVm()` throw `unsupported_vm` si inválido; llamado en container + providers; test verifica VM="aptos" → throw |
| **AC-6** | PASS | `getAddress()` devuelve `this.address` cacheado case-sensitive; test verifica base58 mixed-case NO lowercaseado |

---

## Hallazgos finales

**BLOQUEANTEs**: 0 resueltos en AR/CR/F4.  
**MENOREs**: 0 aceptados (ninguno detectado).  

**Follow-up diferido**: `@solana/pay@1.0.23` peer-conflict Kit v2 → **HU-SOL-5**. Removida de package.json (no se importa esta HU). 5 deps restantes instaladas limpio (995 packages, sin `--legacy-peer-deps`).

---

## Auto-Blindaje consolidado

### W0: Peer-conflict `@solana/pay` (Kit v2 vs Kit v1)
- **Causa**: `@solana/pay@1.0.23` requiere `@solana/kit@^6.9.0`; árbol existente pineea `^5.5.1` vía walletconnect→coinbase.
- **Resolución**: diferida a HU-SOL-5. Removida de `package.json`; 5 deps restantes limpias.
- **Aplicar**: HU-SOL-5 debe resolver major mismatch antes de agregarlo.

### W3.2: Cleanup test jsdom
- **Causa**: múltiples `render()` sin cleanup → "Found multiple elements".
- **Resolución**: `cleanup()` en `afterEach` (patrón `flow.test.tsx`).
- **Aplicar**: tests jsdom nuevos deben incluir cleanup explícito.

---

## Archivos modificados

**Creados (7)**: solana-wallet-bridge.ts, solana-providers.tsx, providers.tsx, solana-wallet.ts, solana-wallet.test.ts, providers.test.tsx, container.test.ts (+ 2 tests nuevos).  
**Modificados (3)**: package.json (+6 deps), app/layout.tsx (+2 líneas), container.ts (+3 líneas).  
**Intactos (AC-3)**: wallet.ts, ports.ts, chain.ts, flow.tsx, todos los tests EVM existentes.

---

## Decisiones diferidas

| Decisión | Destino | Motivo |
|----------|---------|--------|
| `@solana/pay` peer-conflict | HU-SOL-5 | Staging dep, requiere major bump |
| Firma real SPL | HU-SOL-2 | Scope OUT; demo-simbólico aquí |
| PoP (SIWE-equivalente) | HU-SOL-8 | Scope OUT |
| Settle no-custodial Solana | HU-SOL-X | Scope OUT |
| Label "Solana devnet" (vs "Base Sepolia") | Cosmético | `[TBD]` no-bloqueante |

---

## Lecciones para próximas HUs

1. **Seam React-free entre librerías pesadas**: con `next/dynamic({ssr:false})` gateado + bridges React-free, el chunk nunca se carga en path EVM. Mutation self-check valida esto. Aplica a HU-SOL-2 (firma SPL).
2. **Peer-conflicts major incompatibles no siempre resuelven con `--legacy-peer-deps`**: audita cadena completa antes de forzar. HU-SOL-5 debe resolver bump o overrides.
3. **Mutation self-check del gating central es obligatorio**: 2 gates × 1 mutante = 2 asserts que justifican todo el diseño. Incluir en W3 done definition de cualquier HU con branching central.
4. **Tests EVM existentes son el canario más valioso**: 562 verdes SIN cambios = regresión-cero garantizado. NUNCA cambiar expectativas viejas por "simplificar".

---

*Report consolidado por nexus-docs (F4 DONE) — HU-SOL-4 / WKH-212 (024) — 2026-07-21*
