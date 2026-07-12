# Auto-Blindaje — WKH-187 (quote-before-KYC reorder)

Registro de errores cometidos y corregidos durante F3, para blindar futuras HUs.

### [2026-07-12 10:00] Wave 1 — El reorden de la FSM rompe MÁS tests que los anchoreados en el Story File
- **Error**: El Story File §2 sólo anchoreaba `use-cases.test.ts` en el "V1 orphan (L187-219)". Al reordenar `TRANSITIONS` (`created→quoted` en vez de `created→kyc_pending`), rompieron 24 tests: TODO el happy-path de `use-cases.test.ts` (que hacía `create → startKyc → lock`), `persistence.test.ts` (`withOwner` seedea con `startKyc` desde `created`) y `track-remittance.test.ts`.
- **Causa raíz**: cualquier fixture que llamaba `r.startKyc()` (o `startKyc.execute`) sobre una remesa recién creada asumía el orden viejo (KYC antes de cotizar). El anchor list del Story File no era exhaustivo para el cambio de invariante de la FSM.
- **Fix**: reordené el seeding al nuevo orden `create → attachQuote/lock → startKyc → applyKyc` en TODOS los fixtures afectados (dentro del Scope IN: los archivos ya estaban listados como tocables). Tests cuya premisa se invirtió se reescribieron: "no se puede lock antes de KYC" → "no se puede startKyc antes de cotizar (created→kyc_pending inválido)". CD-6 (cero rojos, cero validando el orden viejo).
- **Aplicar en**: toda HU que reordene una FSM. Al cambiar `TRANSITIONS`, grepear TODOS los tests que ejerciten la transición eliminada (`grep "startKyc"` / `\.create(` seguido del estado viejo) — NO confiar solo en los line-anchors del Story File; correr la suite completa como red de seguridad antes de dar por cerrada la wave.

### [2026-07-12 10:00] Wave 1 — `startKyc.execute` desde `created` cambia el ERROR observado (invalid_transition vs kyc_pending_unavailable)
- **Error**: El test "V1 AC-4" y "V1 orphan" esperaban que `startKyc.execute` fallara con `kyc_pending_unavailable` (pending.save lanza). Con el reorden, si la remesa está en `created`, `r.startKyc()` lanza `invalid_transition:created->kyc_pending` ANTES de llegar a `pending.save` — otro error, y `repo.save` nunca corre.
- **Causa raíz**: el gate de la FSM (`to()` → `canTransition`) corre antes que el I/O del pending store; al mover el KYC después del quote, la precondición de estado cambió.
- **Fix**: seedear el quote (`lock.execute`) antes del `startKyc.execute` en esos tests → la remesa está en `quoted`, `startKyc` avanza a `kyc_pending`, y recién ahí `pending.save` lanza `kyc_pending_unavailable` (comportamiento original preservado). El estado persistido tras el fallo pasa de `"created"` a `"quoted"` (WKH-187), asserts actualizados.
- **Aplicar en**: tests de fallo de I/O que dependen del ORDEN relativo entre el guard de la FSM y el side-effect. Verificar que la precondición de estado sigue habilitando el path que se quiere probar.

### [2026-07-12 10:00] Wave 3 — `isQuoteStillValid` en el resume usa tiempo REAL, no el clock del container
- **Error**: Al escribir T-AC6 (resume con quote vigente) casi uso un quote con `expiresAt = QUOTE_EXPIRES` (T0+10min = 2026-07-09), que bajo RTL es tiempo PASADO respecto de `new Date()` real → el resume habría tomado el path de auto-requote en vez del "quote vigente".
- **Causa raíz**: el efecto de resume en `flow.tsx` usa `Remittance.rehydrate(snapshot).isQuoteStillValid(new Date().toISOString())` (tiempo real del navegador, CD-11), NO el `FixedClock` del container de test.
- **Fix**: los snapshots de resume "vigente" usan `expiresAt` en el futuro real (`"2099-01-01..."`); los "vencidos" usan `QUOTE_EXPIRES`. `attachQuote` se sigue construyendo con `T0` (donde ambos son válidos al momento de cotizar).
- **Aplicar en**: cualquier test RTL que ejercite lógica de expiry que lea `new Date()` en vez del clock inyectado. Elegir fechas relativas al reloj REAL, no a `T0`.
