# Auto-Blindaje — WKH-188 (escape + timeout 20 s del resume de KYC)

### [2026-07-12] Wave 0.2 — Timer del escape (useEffect) no dispara a los 5 s exactos bajo fake timers
- **Error**: T-ESC1..T-ESC4 fallaban con "Unable to find button /Empezar de nuevo/". Al avanzar
  `advanceTimersByTimeAsync(5000)` (o 6000) en un solo chunk, el botón de escape no aparecía, aunque
  el overlay `resuming` sí estaba visible.
- **Causa raíz**: el `useEffect([resuming])` agenda `setTimeout(() => setShowResumeEscape(true), 5000)`
  cuando `resuming` pasa a `true`. Bajo `vi.useFakeTimers()`, el flush del efecto *passive* de React
  (que ejecuta ese `setTimeout`) NO ocurre en t≈0: se ancla al FINAL del primer chunk de
  `advanceTimersByTimeAsync`. Si el primer advance es grande (p.ej. 4000/6000), el `setTimeout(5000)`
  se agenda tarde (fake-now ≈ 3000-4000) y dispara recién a ~8000-9000, después de la aserción.
- **Fix (SOLO en los tests, sin tocar el mecanismo del Story File)**: anclar el timer con un primer
  flush chico — `await act(async () => { await vi.advanceTimersByTimeAsync(1); })` — que fuerza
  `resuming=true` + agenda el `setTimeout` cerca de t≈0. Luego se avanza a ~7 s (helper `armEscape`)
  para la aserción de presencia. La aserción de ausencia se mantiene a ~4 s (segura frente al jitter).
  El mecanismo de producción (`useEffect` con `setTimeout(RESUME_ESCAPE_DELAY_MS)`) queda intacto
  como manda W1.2 del Story File.
- **Aplicar en**: cualquier test con fake timers que dependa de un `setTimeout` agendado dentro de un
  `useEffect` cuya dep cambia por un `setState` asincrónico (efectos passive). Regla: hacer un flush
  chico (`advanceTimersByTimeAsync(1)`) para anclar el timer antes del gran avance de tiempo; no
  asumir que el timer se ancla en t=0.

### [2026-07-12] Fix-pack — BLQ-MED-1: 3er punto de suspensión del resume-loop no cubierto por el cancel
- **Error**: el guard `cancelledRef` cubría solo 2 de las 3 ventanas async del resume-loop (top de
  iteración + post-sleep). Faltaba el check inmediatamente tras `await c.resumeKyc.execute()`. Si el
  usuario clickeaba "Empezar de nuevo" mientras `execute()` estaba EN VUELO y ese `execute()` resolvía
  DESPUÉS del click (p.ej. `processing`), el loop caía en `setResuming(true)` → el overlay
  "Verificando tu identidad…" re-colgaba encima de `send`, permanente (el mismo bug que la HU vino a
  matar, reintroducido en una ventana de carrera de ~15-25% por poll).
- **Causa raíz**: CD-CANCEL (Story §4) especificó "al inicio de cada iteración Y tras cada
  `await sleep(...)`" y omitió el `await` de `resumeKyc.execute()`. El Dev siguió la spec al pie; el
  hueco era de la spec. Un `await` es un punto de suspensión donde el estado externo (`cancelledRef`)
  puede haber cambiado; TODO `await` de una operación cancelable necesita re-chequear la bandera al
  volver, no solo los `sleep`.
- **Fix**: agregar `if (cancelledRef.current) return;` justo después de `if (!alive) return;`
  (tras el `await execute()`), antes de mirar `res.kind`. Ahora las 3 ventanas quedan cubiertas:
  (a) top de iteración, (b) tras `execute()`, (c) tras `sleep()`. Test de regresión T-ESC7 con
  promesa DIFERIDA (resuelta a mano tras el click) — queda ROJO sin el guard, VERDE con él.
- **Aplicar en**: cualquier async-loop cancelable (poll, retry, stream). Regla: re-chequear la bandera
  de cancelación tras CADA `await`, no solo tras los `sleep`. Un `await execute()` es tan suspendible
  como un `await sleep()`.

### [2026-07-12] Fix-pack — Footguns latentes documentados (MNR-2 AR + MENOR-2 CR, no bugs hoy)
- **`cancelledRef` nunca vuelve a `false`** (`flow.tsx:78`, seteado en `onCancelResume` L277): tras un
  escape queda `true` para siempre en ese mount. Hoy es INOCUO porque `resumedRef` (L100-103) corre el
  resume-loop una sola vez por mount y el retorno de Didit es un reload same-tab (remonta → refs
  frescos). Footgun latente: si algún día el loop pudiera re-armarse en el mismo mount (p.ej. un botón
  "reintentar resume" sin reload), arrancaría ya cancelado y no poletearía. Mitigación futura:
  resetear `cancelledRef.current = false` en `resetTo`/`onRetryKyc` si se habilita re-entrada.
- **Helper `armEscape` acoplado al flush interno de fake-timers de React** (`flow.test.tsx`): el patrón
  `advanceTimersByTimeAsync(1)` + `6999` depende de que el flush del efecto passive se ancle al final
  del primer chunk de avance (ver primera entrada de este archivo). Es determinista HOY (suite verde),
  pero frágil ante upgrades de React/vitest o cambios del scheduler. Si en el futuro se toca el timing
  del escape o se actualiza React/vitest, re-verificar el anclaje del timer (no asumir t=0).
