# Auto-Blindaje — WKH-181 (PII persistence + historial por-wallet + riskLevel AML)

Registro de errores/desvíos durante la implementación (F3). Protege futuras HUs.

### [2026-07-11 03:48] Wave 1 — Anchor gap: caller de `startKyc` fuera de la tabla del Story File
- **Error**: al hacer `startKyc(now)` → `startKyc(now, ownerAddress)` con el 2º param REQUERIDO, el typecheck rompía en `src/application/use-cases/confirm-and-send.test.ts:38` (`r.startKyc(T0)`), un caller NO listado en la tabla "Files to Modify/Create" ni en la tabla de anchors (que solo ancló `remittance.test.ts` como caller de `startKyc`).
- **Causa raíz**: la tabla de anchors del Story File enumeró los callers de `startKyc` de forma incompleta — omitió el helper `seedQuoted()` de `confirm-and-send.test.ts`. El grep `\.startKyc(` reveló 3 callers de test, no 2.
- **Fix**: fix mecánico determinista de 1 línea → `r.startKyc(T0, "0xSender")` (misma convención de address usada en todo el suite). NO se tocó `confirm-and-send.ts` (el use-case, CD-7) — solo su archivo de test. Desvío mínimo e inevitable dado el contrato del Story File (param requerido). Documentado como desvío de la tabla en el reporte al orquestador.
- **Aplicar en**: ante cualquier cambio de firma de un método de dominio, correr `grep -rn "\.<metodo>(" src app --include=*.ts --include=*.tsx` ANTES de tocar, para enumerar TODOS los callers (prod + test), no solo los que ancló el Story File. Un anchor incompleto de callers es esperable en cambios de firma; el fix mecánico de compilación de tests es parte del contrato "typecheck verde".

### [2026-07-11 03:50] Wave 2 — `noUncheckedIndexedAccess` en el stub `Storage` de test
- **Error potencial (prevenido)**: `[...this.m.keys()][index]` en el `MemStorage` de test es `string | undefined` bajo `noUncheckedIndexedAccess` (CD-9); devolver eso directo violaría `key(index): string | null`.
- **Causa raíz**: `tsconfig` tiene `noUncheckedIndexedAccess` activo (auto-blindaje WKH-179#2).
- **Fix**: `?? null` en el acceso por índice. Aplicado también a la lectura de entries del store (`isEntry` type-guard con narrowing explícito, sin `any`).
- **Aplicar en**: todo acceso por índice a arrays/records en tests nuevos de infra debe usar `?? null` / `!` deliberado. Los stubs `Storage` tipan `implements Storage` completo (getItem/setItem/removeItem/clear/key/length) — no castear a `any`.
