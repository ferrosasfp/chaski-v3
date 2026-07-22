# Auto-Blindaje — HU-SOL-4 / WKH-212

### [2026-07-21 22:22] Wave 0 (W0.1) — BLOQUEO: `@solana/pay@1.0.23` peer-conflict irreconciliable
- **Error/Blocker**: `npm install` de las 6 deps del Story File falla con `ERESOLVE`. NO se pudo
  completar el gate de W0.1.
- **Causa raíz**: `@solana/pay@1.0.23` peer-requiere la familia **Solana Kit v2** (`@solana/kit@^6.9.0`,
  `@solana/keys@^6.9.0`, `@solana-program/system@^0.12.0`, etc.). El árbol existente del proyecto ya
  pin­ea **Solana Kit v1** (`@solana/kit@5.5.1` → `@solana/keys@5.5.1`) traído transitivamente por
  `@walletconnect/ethereum-provider@2.23.10` → `@reown/appkit@1.8.19` → `@base-org/account@2.4.0` →
  `@coinbase/cdp-sdk@1.51.2` → `@solana/kit@5.5.1`. Son generaciones **major incompatibles** (5.x vs 6.x)
  del mismo paquete → conflicto de peer irreconciliable sin `--force`/`--legacy-peer-deps`.
- **Aislamiento verificado**: quitando SOLO `@solana/pay`, las otras 5 deps (spl-token + los 4
  `@solana/wallet-adapter-*`) resuelven limpio (`npm install --dry-run` → exit 0, 995 packages). El
  conflicto NO involucra los `@solana/wallet-adapter-*` (que era lo que W0.1 pedía verificar entre sí).
- **Nota clave (DT-SDD-7)**: `@solana/pay` es un **staging dep para HU-SOL-2**, NO se importa en esta
  HU. El conflicto no afecta la funcionalidad de HU-SOL-4 (connect/getAddress), pero CD-5 exige las 6
  pinneadas y W0.1 lista `@solana/pay@1.0.23`.
- **Fix (RESUELTO por el orquestador)**: escalado y **decidido diferir `@solana/pay` a HU-SOL-5**
  (no lo usa esta HU; era staging para el `reference` del deposit). Se **removió `@solana/pay` del
  `package.json`**; se instalaron limpio las **5 deps restantes** (los 4 `@solana/wallet-adapter-*` +
  `@solana/spl-token`) → `npm install` exit 0, 995 packages, siblings deduped. **SIN**
  `--legacy-peer-deps` ni `overrides` (Golden Path). W0.1→W3 continuaron normal.
- **Aplicar en**: HU-SOL-5 (que traerá `@solana/pay`) chocará el peer-conflict Kit v2 (`@solana/pay`)
  vs el árbol Kit v1 (walletconnect/coinbase). Antes de agregarlo hay que resolver el `@solana/keys`
  major mismatch (bump de la cadena walletconnect a Kit v2, `overrides`, o pin de `@solana/pay` a una
  versión con peer Kit v1).

### [2026-07-21 22:xx] Wave 3 (W3.2) — providers.test.tsx: children duplicados sin cleanup
- **Error**: el 2º test de `providers.test.tsx` fallaba con `Found multiple elements by:
  [data-testid="child"]` — el DOM del 1º `render()` no se desmontaba entre tests.
- **Causa raíz**: sin `vitest.config.ts` no hay auto-cleanup de `@testing-library/react`; el template
  del Story File no incluía `cleanup()` en el `afterEach`.
- **Fix**: agregué `import { cleanup }` + `cleanup()` al inicio del `afterEach`, siguiendo el patrón
  EXACTO del exemplar `flow.test.tsx` (que ya usa `cleanup` explícito). NO se creó `setup.ts` nuevo.
- **Aplicar en**: cualquier test de componente nuevo (jsdom) que haga múltiples `render()` en el mismo
  archivo debe llamar `cleanup()` en `afterEach` (o importar el auto-cleanup de testing-library).
