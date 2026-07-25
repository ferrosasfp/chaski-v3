# Chaski v2 — DApp mobile de remesas (USDC → PEN → Yape)

La **versión REAL** de Chaski, **en paralelo** al demo (yarvis) que ven los jurados Team1 — el demo
queda **intacto**. Producto guiado completo (no un chat de una pantalla): monto con preview en vivo →
verificación (KYC) → revisar/confirmar → seguimiento → recibo. DApp mobile (PWA + wallet). **Clean Architecture.**

> Estado: **buildeja para producción** (Next 16.2.10, `next build` ✓), tsc 0, 18/18 tests. Corre en
> **fallback** (KYC/FX reales-en-fallback, payout mock que NO mueve plata) → el flujo se demuestra
> end-to-end HOY. Los adapters reales (Didit/TransFi + wallet EIP-3009) se enchufan en el composition
> root cuando llegue el sandbox (Fase A) — **cero cambio en use-cases ni UI**.

## Correr / buildear
```bash
npm install --legacy-peer-deps
npm run dev        # http://localhost:3000
npm run typecheck  # tsc --noEmit
npm run test       # vitest (dominio + aplicación)
npm run build      # next build (producción)
```
Deploy: Vercel (proyecto NUEVO, testnet) — no comparte nada con el demo.

## Clean Architecture (la regla de dependencia apunta hacia adentro)
```
Presentation (React/Next)  →  Application (use-cases + ports)  →  Domain (entidades)
Infrastructure (adapters)  →  implementan los ports; se inyectan en el composition root
```
- **`src/domain/`** — puro, sin deps. `Money` (unidades menores, cero floats) + `Remittance` (agregado
  con la **máquina de estados** y las **invariantes money-path**: no confirmar sin KYC + quote válido).
- **`src/application/`** — `ports.ts` (QuoteGateway/KycGateway/PayoutGateway/WalletPort/RemittanceRepository/
  Clock/IdGenerator) + `use-cases/` (PreviewQuote, CreateRemittance, RunKyc, LockQuote, ConfirmAndSend,
  TrackRemittance, ListHistory). Dependen SOLO de los ports.
- **`src/infrastructure/`** — adapters fallback (`fallback/gateways.ts`), `wallet.ts`, `persistence.ts`
  (localStorage con serializer de Money — fixea el gap del demo: sin historial), `system.ts` (clock/ids).
- **`src/composition/container.ts`** — composition root: el ÚNICO lugar que conoce adapters concretos.
  Hoy cablea fallback; swap a real acá, sin tocar nada más (dependency inversion).
- **`src/presentation/`** — `ui.tsx` (design system + ChaskiMark), `flow.tsx` (el flujo), `cn.ts`.
- **`app/`** — Next (PWA shell + layout con Hanken Grotesk + la identidad).

Testabilidad: el money-path se prueba en la capa de use-cases con **test doubles** (`src/test-support/fakes.ts`),
sin browser/wallet/red. Ver `src/application/use-cases.test.ts` + `src/domain/*.test.ts`.

## Identidad
Chaski andino (reusada del demo): cochinilla `#CB2A54` + verde `#12805C`, neutros cálidos, Hanken Grotesk,
la marca ChaskiMark (Qhapaq Ñan + nudo de khipu). Mobile-first, cripto-invisible (se habla de $ y S/, no de USDC).

## Integración A2A (mergeado en main — WKH-186)

Chaski corre **sobre los rieles A2A** del gateway neutro. Los adapters A2A ya están en `src/infrastructure/a2a/`:
- `A2aQuoteGateway` / `A2aKycGateway` / `A2aPayoutGateway` (llaman a los agentes `remit-*` vía rutas server-only con key server-side)
- Flag `NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER=a2a` activa el wiring en el composition root; default sigue siendo Fallback (mock).
- Ambos adapters coexisten sin conflicto en el mismo contenedor.

## Qué falta (Fase A+)
- El value-delivery real (movimiento del principal on-chain) — WKH-168, gated al sandbox de TransFi.
- Pantalla de historial (el `ListHistory` ya existe) + íconos PWA + more.
- `WagmiWallet` (EIP-3009 gasless, cuando la identidad se unice con Privy/AgentKit).
- Ver `docs/architecture.md` + `docs/ux-design.md`.
