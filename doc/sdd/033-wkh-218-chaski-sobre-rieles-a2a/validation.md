# Validation Report — WKH-218 Chaski sobre rieles A2A (COMPACT)

**Veredicto**: APROBADO PARA DONE
**Fecha**: 2026-07-24
**Branch**: `feat/033-wkh-218-chaski-sobre-rieles-a2a` (diff vs `feat/032-wkh-227-contratos-idl-golden`)

## Runtime checks
- No aplica DB/env-deployment (HU no toca schema ni deploy target); código server-only verificado in-repo.
- Secrets: `WASIAI_A2A_AGENT_KEY`/`WASIAI_A2A_GATEWAY_URL` sin prefijo `NEXT_PUBLIC_` (grep 0 matches); jamás en `console.*` (0 matches en `gateway-client.ts`/routes).
- `gateway-client.ts` importado SOLO por `app/api/a2a/{quote,payout/submit}/route.ts` (grep confirma: nunca `container.ts` ni componente cliente) — CD-A2A-10 OK.

## ACs
| AC | Status | Evidencia |
|----|--------|-----------|
| AC-1 quote vía compose (flag ON) | PASS | `app/api/a2a/quote/route.ts:36-50` rama `a2a-gateway` al tope; test `quote/route.test.ts:119-130` (`{GW}/discover`+`{GW}/compose`, `directCalls.toHaveLength(0)`) |
| AC-2 payout vía compose post-guards (flag ON) | PASS | `app/api/a2a/payout/submit/route.ts:372-399` (post guard 8, L364 comentario "A10"); test `payout/submit/route.test.ts:1188-1199` |
| AC-3 discover antes de compose, no slug hardcodeado | PASS | `gateway-client.ts:49-69` (discover→pick→compose); test `gateway-client.test.ts:43-89` (orden + `expectedSlug` desambigua) |
| AC-4 (estrella) fail-closed sin fallback | PASS | `gateway-client.ts:55-93` (todo throw/!ok/shape→`unavailable`/`no_agent`, nunca lanza); tests `quote/route.test.ts:132-151`, `payout/submit/route.test.ts:1215-1232` (`directCalls.toHaveLength(0)` en discover-throw y discover-vacío), `guard8-intact.test.ts:65-73` (`runViaGatewayMock).not.toHaveBeenCalled()` cuando guard 8 corta) |
| AC-5 gateway resuelve x402/precio, Chaski solo autentica | PASS | `gateway-client.ts:74-79` (único header `x-a2a-key`, sin firma); test `gateway-client.test.ts:177-192` (`raw.not.toContain("x402"/"signature"/"challenge")`) |
| AC-6 flag OFF byte-idéntico | PASS | diffstat `quote/route.ts` 25+/1- (única deleción: `body` movido antes del branch, no cambia respuesta), `payout/submit/route.ts` 37+/0- (guards 1-8 intactos); tests `it.each(["fallback","a2a",undefined])` en ambos routes (`quote/route.test.ts:190-206`, `payout/submit/route.test.ts:1266-1282`) confirman fetch directo byte-idéntico aunque las envs del gateway estén seteadas |
| AC-7 creds server-only, nunca logueadas | PASS | grep: 0 `NEXT_PUBLIC_WASIAI*`, 0 `console.*` en los 3 archivos nuevos/tocados; test `gateway-client.test.ts:195-226` (`not_configured` sin fetch + `serialized.not.toContain(KEY/URL)`) |
| AC-8 idempotencyKey intacto + PII-free | PASS | `gateway-client.ts:77-78` (`input: params.input` tal cual); `route.ts:377` (`input: body as Record<...>`); test `payout/submit/route.test.ts:1201-1213` (`stepInput.idempotencyKey`/`beneficiary` intactos) + `:1234-1242` (`raw.not.toContain("999888777")`) |

## Drift
- Diff = exactamente los 9 archivos de Scope IN (+ `container.ts` 2+/2- descrito en SDD §5, + `.env.example` 11+, + 4 test files) + artefactos doc/build (`sdd.md`,`story`,`work-item`,`_INDEX.md`,`auto-blindaje.md`,`tsconfig*.tsbuildinfo`). Sin archivos fuera de scope.
- `payout/submit/route.ts`: 37 insertions, **0 deletions** — guards 1-8 (L74-333) byte-idénticos (CD-2 confirmado por diff, no solo por lectura).
- `container.ts`: 2 líneas cambiadas (`useA2a` + guard EIP-3009), ambas inertes con default (flag ≠ "a2a-gateway" no las ejercita) — coincide con SDD §5.
- `src/infrastructure/a2a/gateways.ts` (client-side, Scope OUT): 0 cambios (no aparece en el diff).
- Sin `any` en los 3 archivos nuevos/tocados (grep 0 matches) — CD-A2A-11 OK.

## Gates (ejecutados directamente, no solo leídos — no hay cr-report.md en disco para esta HU)
- `npx tsc --noEmit` → exit 0 ("TypeScript compilation completed").
- `npx vitest run` → **Test Files 64 passed (64)**, **Tests 730 passed (730)** — coincide con el conteo esperado (auto-blindaje.md reporta corrida limpia W0→W3 sin ciclos de fix).
- `next lint` NO ejecutado (roto en Next 16, gate estático del repo es tsc+vitest per CD-A2A-9).

## AR/CR follow-up
- No se encontró `ar-report.md`/`cr-report.md` en `doc/sdd/033-wkh-218-chaski-sobre-rieles-a2a/` — el veredicto "0 BLQ, 2 MNR" fue reportado por el orquestador sin artefacto en disco para esta HU. F4 no depende de ese reporte: se verificó código+tests+gates independientemente (arriba) y no se encontró ningún hallazgo adicional.
- 2 MNR (según orquestador): no bloqueantes, no requieren fix-pack para DONE.

**Listo para DONE.**
