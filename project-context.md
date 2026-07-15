# project-context.md
> Generado por NexusAgil F0 — Bootstrap de Proyecto (2026-07-12, durante F0/F1 de WKH-188)
> Actualizar cuando cambie el stack, arquitectura o guardrails.

---

## Proyecto

| Campo | Valor |
|-------|-------|
| **Nombre** | Chaski v2 |
| **Descripcion** | DApp mobile (PWA Web3) de remesas USDC→PEN→Yape/Plin/CCI. Producto real en paralelo al demo (`yarvis`/`agentshop-*`), NO lo toca. Clean Architecture. |
| **Tipo** | web-app (PWA, Next.js app router) |
| **Estado** | produccion (hackathon-grade, pipeline QUALITY end-to-end) |

---

## Stack

| Capa | Tecnologia | Version |
|------|-----------|---------|
| Lenguaje | TypeScript | ^5.6.2 |
| Framework | Next.js (app router, webpack) | ^16.2.10 |
| UI | React | 19.0.0 |
| Web3 | wagmi + viem + @walletconnect/ethereum-provider | wagmi ^2.12.0 / viem ^2.21.0 |
| Estilos | Tailwind CSS | ^3.4.13 |
| Animacion | framer-motion (mockeada pass-through en tests) | ^11.5.0 |
| Rate limit | @upstash/ratelimit + @upstash/redis | ^2.0.8 / ^1.38.0 |
| Validacion | zod | ^3.23.8 |
| Testing | vitest + @testing-library/react (jsdom) | vitest ^2.1.1 / RTL ^16.1.0 |
| Deploy | Vercel (`chaski-v2.vercel.app`) | - |

Sin base de datos relacional propia: persistencia de estado de remesa vive en
`src/infrastructure/persistence.ts` (localStorage-based hoy); KYC pendiente en
`src/infrastructure/kyc-pending-store.ts` (`localStorage`, key `chaski.kyc.pending.v1`).

---

## Arquitectura de Carpetas

```
chaski-v2/
├── app/                          # Next.js app router (PWA shell)
│   ├── page.tsx                  # unico caller real de <RemittanceFlow/>
│   └── api/
│       ├── kyc/session/route.ts  # crea sesion Didit (server-side, key nunca en cliente)
│       ├── kyc/decision/route.ts # GET decision de Didit (auth x-kyc-token, WKH-179)
│       ├── payout/validate/route.ts
│       └── a2a/{quote,payout/submit}/route.ts
├── src/
│   ├── domain/                   # entidades PURAS (Remittance FSM, Money, etc.) sin deps
│   ├── application/
│   │   ├── use-cases/            # RequestQuote, StartKyc, ResumeKyc, ConfirmAndSend, etc.
│   │   └── ports.ts              # interfaces (KycGateway, KycPendingStore, RemittanceRepository...)
│   ├── infrastructure/           # adapters: didit/, fallback/, a2a/, wallet.ts, persistence.ts
│   ├── presentation/             # React: flow.tsx (pantalla principal), ui.tsx, flow-vm.ts
│   ├── composition/container.ts  # composition root (inyecta fallback vs real por env)
│   └── test-support/             # fakes.ts + test-container.ts (buildTestContainer, WKH-185)
└── doc/sdd/                      # NexusAgil QUALITY pipeline (work-item, SDD, story, reportes)
```

**Patron de arquitectura**: Clean Architecture (Presentation → Application → Domain;
Infrastructure implementa los ports). Ver `docs/architecture.md` para el detalle completo.

---

## Comandos

```bash
# Desarrollo
npm run dev              # next dev --webpack

# Build produccion
npm run build             # next build --webpack

# Tests
npm run test              # vitest run (todo el repo)
npm run test:core         # vitest run src/domain src/application (rapido, sin UI)

# Lint / Typecheck
npm run lint
npm run typecheck         # tsc --noEmit

# Todo junto (gate de QA)
npm run qa                # typecheck && test
```

---

## Patrones de Codigo

### Patron de componente / modulo
`RemittanceFlow` (`src/presentation/flow.tsx`) es un unico componente-pantalla con maquina de
`Step` (`"send"|"connect"|"review"|"verify"|"confirm"|"track"|"done"`) manejada con `useState` +
un `Container` inyectado (composition root, `c.someUseCase.execute(...)`). Acepta
`container?: Container` opcional para tests (default preserva comportamiento real, WKH-185).

### Patron de manejo de errores
`guard(fn)` (flow.tsx) envuelve las acciones async: setea `busy`, catchea y mapea el error con
`humanError()` (`flow-vm.ts`) a copy legible en español. Los use-cases lanzan `Error(codigo)`
(ej. `"confirm_quote_expired"`) que `humanError` traduce.

### Patron de acceso a base de datos
No hay DB relacional; los adapters de infraestructura (`persistence.ts`, `kyc-pending-store.ts`,
`kyc-store.ts`) usan `localStorage`. Dos politicas de fallo del write segun criticidad del dato:
- `kyc-pending-store.ts` (write critico: sin el pendiente no se retoma el KYC): fail explicito,
  `throw new Error(...)` si el write falla (el caller decide, WKH-183/187).
- `kyc-store.ts` (cache no-critico de KYC-once): `save`/`clear` son best-effort/fail-silent —
  el `setItem` va envuelto en try/catch que traga quota/private-browsing sin re-lanzar, para que un
  fallo del cache NUNCA bloquee la persistencia del KYC aprobado en el repo (WKH-199/184).

### Patron de auth / autorizacion
- Rutas `/api/kyc/*` protegidas con auth server-side (WKH-179): `x-kyc-token` HMAC generado en
  `/api/kyc/session` y verificado en `/api/kyc/decision`.
- Autoridad de payout SIEMPRE server-side (WKH-180): `confirm-and-send.ts` llama
  `authority.authorize()` DESPUES de `r.confirm()`, nunca confia solo en el gate client-side.
- Gate de compliance duro en el dominio: `Remittance.confirm()` (`src/domain/remittance.ts`)
  rechaza con `confirm_requires_kyc_passed` si `!state.kyc.approved || !state.kyc.payoutAllowed`.

---

## Exemplars

| Cuando crear... | Usar como exemplar |
|----------------|-------------------|
| Use-case nuevo (application) | `src/application/use-cases/abandon-pending-kyc.ts` (simple, 1 dependencia) |
| Test de UI con fake timers | `src/presentation/flow.test.tsx` — bloque `describe("T3 (fake timers aislados, CD-10)")` |
| Adapter que mapea payload externo puro | `src/infrastructure/didit/decision.ts` (`mapDiditDecision`) |
| Test de use-case con fakes | `src/application/use-cases/abandon-pending-kyc.test.ts` |

---

## Guardrails (Reglas del Proyecto)

### OBLIGATORIO
- Metodologia NexusAgil modo **QUALITY** siempre (ver historial completo en `doc/sdd/_INDEX.md`:
  F0→F1→F2→F2.5→F3→AR→CR→F4→DONE en TODAS las HUs 178-187).
- Toda transicion nueva en `TRANSITIONS` (`remittance.ts`) lleva razon de negocio en comentario
  inline.
- Tests actualizados en la MISMA HU que toca el codigo que cubren (no dejar tests rojos).
- `container?: Container` opcional en componentes de presentacion para poder inyectar fakes en
  tests (patron establecido por WKH-185).

### PROHIBIDO
- NUNCA debilitar, saltear ni volver condicional-por-flag el gate `confirm_requires_kyc_passed`
  (`remittance.ts`, invariante de compliance).
- NUNCA remover o condicionar `authority.authorize()` en `confirm-and-send.ts` (autoridad
  server-side de payout, WKH-180).
- NUNCA tocar `wasiai-a2a`, `wasiai-v2`, ni el demo (`yarvis`/`agentshop-*`) desde este repo —
  Chaski v2 es standalone, corre en paralelo.
- NUNCA persistir PII cruda sin la reduccion ya establecida (`toPersistedIdentity`,
  `maskIdentity`/`maskDecision` en `decision.ts`).
- NUNCA hardcodear secrets — las keys de Didit/Upstash viven server-side via env vars.

---

## Variables de Entorno

```
NEXT_PUBLIC_KYC_MODE           — "didit" | fallback (simulacion) segun disponibilidad de key
NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER — "fallback" | "a2a" (WKH-186)
DIDIT_API_KEY (server-only)    — key real de Didit KYC
UPSTASH_REDIS_* / UPSTASH_RATELIMIT_* — rate-limit de /api/kyc/* (WKH-179)
```

---

## Contexto de Negocio

- **Usuarios objetivo**: personas cripto-nativas en EEUU/etc. que mandan remesas USDC a familia
  en Peru (reciben en Yape/Plin/cuenta bancaria).
- **Flujo principal (post WKH-187)**: enviar monto → conectar wallet → ver el quote (cuanto
  recibe la familia) → continuar → verificar identidad (Didit, redirect) → confirmar y enviar →
  seguimiento → recibo.
- **Integraciones externas**: Didit (KYC hospedado, redirect same-tab), agentes `remit-*` del
  ecosistema WasiAI A2A (FX + payout, via `wasiai-remittance-agents`), Upstash (rate-limit).

---

## Auto-Blindaje

| Fecha | Error | Fix | Aplicar en |
|-------|-------|-----|-----------|
| 2026-07-12 | El resume-loop tras volver de un KYC de Didit abandonado (usuario dio "atras") poletea ~100s (40×2500ms) sin ninguna accion de escape visible antes del timeout completo — percibido como "colgado" (WKH-188). | En definicion (F1→F2): boton de escape visible a los ~6-8s + timeout acortado a ~25-30s. | Cualquier resume-loop/polling futuro en `flow.tsx`: SIEMPRE exponer una via de escape antes del timeout completo, no solo al agotarlo. |

---

*Generado por NexusAgil F0 Bootstrap — actualizar con cada cambio significativo al stack*
