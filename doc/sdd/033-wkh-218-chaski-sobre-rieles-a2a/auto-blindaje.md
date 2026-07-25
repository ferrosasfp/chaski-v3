# Auto-Blindaje — WKH-218 (Chaski sobre rieles A2A)

Registro de errores cometidos y corregidos durante F3. Cada entrada protege futuras HUs del mismo error.

---

## Corrida limpia (sin ciclos de corrección)

La implementación de las 4 waves (W0→W3) pasó el gate estático (`npx tsc --noEmit` + `npx vitest run`)
en el primer intento de cada wave, sin errores de tipo, sin tests rojos y sin re-trabajo. No hubo
ciclos error→fix que documentar.

Factores que evitaron errores (patrones seguidos, no descubiertos):
- **Story File autosuficiente**: firma exacta de `runViaGateway`, tipos narrow del gateway, algoritmo
  fail-closed paso a paso y paths de import ya resueltos en F2 (Anti-Hallucination Checklist §3).
- **Exemplars byte-exactos**: `isRecord` (gateways.ts:42), route fail-closed opaco (quote/route.ts),
  test stubEnv+stubGlobal (quote/route.test.ts) copiados tal cual.
- **Ramificación aditiva**: quote y payout agregan una rama al tope/post-guard-8 dejando el bloque
  punto-a-punto intacto ⇒ cero riesgo de romper los guards 1-8 ni la byte-identidad del flag OFF.

Si en AR/CR/QA aparece un hallazgo, se documenta acá con el formato estándar
(`### [YYYY-MM-DD HH:MM] Wave N — título` / Error / Causa raíz / Fix / Aplicar en).
