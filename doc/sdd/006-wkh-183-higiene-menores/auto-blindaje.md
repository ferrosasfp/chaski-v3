# Auto-Blindaje — WKH-183 (higiene menor)

Sin errores de implementación en la sesión F3 (tsc/vitest/build verdes al primer intento).
Se documentan aprendizajes de coordinación de merge que blindan futuras HUs sobre archivos
compartidos.

### [2026-07-11] W1/W4 — Re-verificación de archivos compartidos con 182
- **Riesgo evitado**: `.env.example` y `fallback/gateways.ts` fueron tocados por WKH-182 antes de
  esta HU. Anclar por número de línea del Story File habría producido un Edit contra texto movido
  o duplicado un hunk ajeno.
- **Causa raíz**: los Story Files fijan anchors sobre un `main` previo al merge de la HU anterior.
- **Fix**: antes de cada Edit se re-verificó por CONTENIDO (grep/Read del snippet exacto). Resultado:
  **AC-10 (`NEXT_PUBLIC_REOWN_PROJECT_ID` en `.env.example`) resultó no-op** — 182 ya lo agregó
  (sección "── Wallet (WalletConnect / Reown) ──"). NO se duplicó. **V4 (doble redondeo en
  `gateways.ts`) seguía vivo** — 182 no tocó ese archivo — y se aplicó.
- **Aplicar en**: toda HU que declare "archivo COMPARTIDO con HU-N" → grep del snippet antes de
  editar; marcar explícitamente qué ACs quedaron no-op tras el merge previo.

### [2026-07-11] W2 — Orden save/persist para no dejar agregados huérfanos
- **Aprendizaje (V1)**: cuando un paso de persistencia secundario (localStorage `pending.save`)
  puede fallar, debe ir ANTES del `repo.save` que muta el estado agregado. Si el secundario lanza,
  el `repo.save` no corre → el agregado sigue en su último estado válido (`created`) → el retry
  usa una transición legal (`created→kyc_pending`) sin brick ni compensación.
- **Aplicar en**: cualquier use-case que escriba en dos stores donde uno gobierna la máquina de
  estados y el otro es correlación auxiliar. Guardá primero el auxiliar.
