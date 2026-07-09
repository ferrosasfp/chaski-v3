# Chaski v2 — Arquitectura (DApp mobile + Clean Architecture)

DApp **mobile-first** (PWA Web3) con **Clean Architecture**. Producción, no hackathon.
En paralelo al demo (yarvis) — NO lo toca.

## Es una DApp mobile (la tecnología que lo hace real)
- **PWA** (instalable, mobile-first) — como el demo, pero producto completo.
- **Wallet Web3:** el sender es cripto-nativo → conecta su wallet (con USDC). Firma la **autorización EIP-3009**
  del principal (el USDC de la remesa) — el operador NO fondea. Stack: **wagmi + viem** + un connector (Reown/
  RainbowKit — a confirmar matcheando el demo). Multichain testnet (la chain que acepte TransFi: Base/Avalanche).
- **On-chain real:** el movimiento del principal es on-chain (a la wallet del partner/beneficiario, NO self-transfer);
  la UI muestra los refs on-chain (opt-in, cripto-invisible por default).
- Next.js (app router) + Tailwind (matchear el demo para reusar patrones + la identidad Chaski).

## Clean Architecture — la regla de dependencia apunta HACIA adentro
```
Presentation (UI)  →  Application (use-cases + ports)  →  Domain (entities)
Infrastructure (adapters)  →  implementa los ports (inyectados en el composition root)
```
Nada del dominio conoce React, viem, ni el gateway a2a. Los adapters son reemplazables (fallback → real) sin tocar
use-cases ni UI — mismo principio que el provider-pattern del backend.

### Capas y contenido
- **`src/domain/`** — entidades + value objects PUROS (sin deps): `Remittance`, `Quote`, `Beneficiary`,
  `KycVerification`, `Money` (USD/PEN con precisión), `RemittanceStatus` (la máquina de estados:
  CREATED→KYC→QUOTED→PRINCIPAL_IN→PAYOUT→SETTLED/REFUNDED). Invariantes de negocio acá (ej. "no PRINCIPAL_IN sin KYC+quote válido").
- **`src/application/`** — **use-cases** (orquestan el dominio): `RequestQuote`, `VerifyIdentity`, `ConfirmAndSend`,
  `TrackRemittance`, `ListHistory`. Y los **ports** (interfaces que los use-cases requieren): `QuoteGateway`,
  `KycGateway`, `PayoutGateway`, `WalletPort` (conectar/firmar), `RemittanceRepository`, `Clock`. Los use-cases
  dependen SOLO de estos ports.
- **`src/infrastructure/`** — **adapters** que implementan los ports:
  - `A2aQuoteGateway` / `A2aKycGateway` / `A2aPayoutGateway` → llaman a los agentes `remit-*` vía el gateway a2a
    (reusa el patrón `/api/plan` + `/api/execute` del demo, key server-side, apuntando a `remit-*` NO `agentshop-*`).
  - `ViemWalletAdapter` → wagmi/viem: conectar wallet + firmar EIP-3009 del principal.
  - `RemittanceRepository` → persistencia del historial/estado (IndexedDB local o el backend; aislado del demo).
  - `SystemClock`.
- **`src/presentation/`** — React/Next (screens + componentes) que consumen los use-cases vía un **composition root**
  (`src/composition/container.ts`) que inyecta los adapters. La UI no instancia infra directo.
- **`app/`** — rutas Next (PWA shell) + `app/api/*` (los server routes que hablan con el gateway con la key server-side,
  patrón del demo).

### Regla clave (dependency inversion)
El fallback vs real de cada gateway se resuelve en el **composition root** (igual que las factories del backend):
en dev, adapters fallback; con sandbox, adapters reales — **cero cambio en use-cases ni UI**. Esto hace la DApp
demostrable HOY end-to-end (fallback) y lista para real apenas llegue Fase A.

## Testabilidad
Dominio + use-cases testeables sin red/wallet/UI (se inyectan ports fake). Es la razón de Clean Architecture acá:
un money-path se prueba en la capa de use-cases con dobles, no en el navegador.

## Flujo (mapeado a las capas)
Screens (Presentation) → use-cases (Application) → ports → adapters (Infra: agentes a2a `remit-*` + wallet + repo).
El detalle de screens/estados está en `ux-design.md`.
