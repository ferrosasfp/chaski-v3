# Work Item — [WKH-178] Chaski v2: recibo S/0.00 + banner "Modo demo" + KYC timeout/reset

## Resumen
Tras la auditoría adversarial del 2026-07-10, Chaski v2 tiene 2 bugs bloqueantes y 1 alto que
comprometen la credibilidad del demo money-path: (1) el recibo de éxito muestra "recibió S/0.00"
por un `null → Money.zero` mal coalescido; (2) el flujo simulado (payout mock, firma `signMessage`,
identidad hardcodeada) se presenta sin ningún indicador de que es una demo, no dinero real; (3) un
KYC abandonado deja al usuario bloqueado ~100s y el bloqueo se repite en cada reload porque el
pending nunca se limpia. Esta HU corrige los 3, solo en capa de presentación + un ajuste puntual
en el use-case `track-remittance`.

## Sizing
- Modo de proceso: QUALITY (WasiAI/Chaski es siempre QUALITY por convención de proyecto)
- SDD_MODE: mini (fix contenido, sin cambios de arquitectura ni nuevos ports/adapters)
- Estimación: S
- Branch sugerido: `fix/178-demo-safe-receipt-banner-kyc-timeout`

## Acceptance Criteria (EARS)

### B2 — Recibo S/0.00 (BLOQUEANTE)
- **AC-1**: WHEN `PayoutGateway.status()` devuelve `deliveredPen: null` con `status: "settled"`,
  the system SHALL mantener `deliveredPen` como `null` en el snapshot de `Remittance` — `TrackRemittance`
  (`src/application/use-cases/track-remittance.ts:21`) SHALL dejar de coalescer
  `rec.deliveredPen ?? Money.zero("PEN")` a un `Money` de cero.
- **AC-2**: WHEN la pantalla de Recibo (`Receipt` en `src/presentation/flow.tsx:576-577`) renderiza
  y `rem.deliveredPen` es `null`, the system SHALL mostrar `rem.quote.receive` como monto entregado
  (el fallback ya está escrito en el código — `rem.deliveredPen ?? rem.quote?.receive` — pero hoy
  nunca se activa porque `deliveredPen` nunca llega `null` a la UI; con AC-1 corregido, este fallback
  pasa a dispararse de verdad).
- **AC-3**: IF tanto `deliveredPen` como `quote` son `null` en el Recibo (estado inconsistente),
  THEN the system SHALL mostrar un placeholder no-monetario (`"—"`) en vez de `"S/0.00"` o un
  string vacío.

### B3 — Simulado sin indicador (BLOQUEANTE)
- **AC-4**: WHILE `rem.quote?.provenance === "local-fallback"` OR `rem.kyc?.provenance === "local-fallback"`,
  the system SHALL mostrar un indicador visible "Modo demo — sin dinero real" en los steps `review`,
  `track` y `done` de `RemittanceFlow` (`src/presentation/flow.tsx`).
- **AC-5**: WHEN el usuario llega a la pantalla de Recibo (`done`) en modo demo, the system SHALL
  mostrar el mismo indicador junto al monto entregado, de forma que no se pueda confundir con una
  transacción real de dinero.
- **AC-6**: the system SHALL derivar el indicador exclusivamente del campo `provenance` que YA existe
  en `Quote` (`src/domain/remittance.ts:23`) y `KycVerification` (`src/domain/remittance.ts:42`) —
  SHALL NOT introducir una env var o flag nuevo para esto (ver DT-2 / CD-3).

### A4 — KYC timeout no limpia pending (ALTO)
- **AC-7**: WHEN el polling de `resumeKyc` en `RemittanceFlow` (`src/presentation/flow.tsx:85-128`)
  agota los 40 intentos (~100s) sin recibir una decisión terminal de Didit, the system SHALL limpiar
  el KYC pendiente (equivalente a `kycPendingStore.clear()`, hoy invocado solo dentro de
  `ResumeKyc.execute()` cuando `dec.terminal === true` — `src/application/use-cases/resume-kyc.ts:50`)
  para que el siguiente reload NO repita el mismo bloqueo de ~100s.
- **AC-8**: WHEN ocurre el timeout de KYC (línea 124-127 de `flow.tsx`), the system SHALL mostrar,
  junto al mensaje de error existente, un botón "Reintentar" que reinicie el flujo de verificación
  (vuelve a un estado accionable — step `verify` o `connect` — en vez de dejar solo un mensaje de
  error sin acción posible).
- **AC-9**: IF el usuario dispara "Reintentar" tras un timeout de KYC, THEN the system SHALL permitir
  arrancar una verificación nueva sin requerir refrescar la página manualmente.

## Scope IN
- `src/application/use-cases/track-remittance.ts` — quitar el coalesce `null → Money.zero` (AC-1).
- `src/presentation/flow.tsx` — fallback del Recibo (AC-2/3), banner "Modo demo" (AC-4/5), timeout
  + limpieza de pending + botón Reintentar en el efecto de resume KYC (AC-7/8/9).
- `src/presentation/ui.tsx` — si se necesita un componente/variante de `Pill`/banner reutilizable
  para "Modo demo" (reusar el patrón `Pill` existente, `tone` nuevo si hace falta).
- `src/composition/container.ts` — SOLO si el Architect decide que limpiar el pending KYC requiere
  exponer un método nuevo en `Container` (hoy `kycPending` es una variable local no exportada,
  ver DT-3 / Missing Inputs).

## Scope OUT
- Rutas API (`src/app/api/**`) y el gate server-side de Didit (`DiditKycGateway`,
  `src/infrastructure/didit/kyc-gateway.ts`) — no se tocan.
- `FallbackPayoutGateway` / `FallbackKycGateway` (`src/infrastructure/fallback/gateways.ts`) —
  su comportamiento simulado (identidad "María Elena" hardcodeada, `deliveredPen: null`, monto fijo)
  es harness de demo intencional; esta HU solo lo VISIBILIZA, no lo cambia.
- `src/infrastructure/wallet.ts` (firma `signMessage` vs EIP-3009 real) — fuera de scope, ya
  comentado en código como decisión de demo pendiente de Fase A (sandbox real).
- Payout real / integración con partner real — es un backlog distinto (Fase A).
- Menores del ticket (pantalla en blanco si `lockQuote` falla al retomar — `flow.tsx:110-116` —, y
  la ventana de doble-submit — `flow.tsx:134-144`) — quedan explícitamente FUERA de esta HU
  (ver Missing Inputs); candidatos a un follow-up ticket separado dado que el foco P0 declarado
  es demo-safe (recibo + banner + KYC timeout).
- **CD-1 (repetido acá para claridad de scope): el demo live (`yarvis` + `agentshop-*`) NO se toca.**
  Todo el trabajo de esta HU vive en `chaski-v2/`.

## Decisiones técnicas (DT-N)
- **DT-1**: `TrackRemittance` deja de inventar un `Money.zero` cuando el gateway no reporta monto
  entregado; retorna `deliveredPen: null` tal cual. La UI (`Receipt`) es responsable de decidir el
  fallback de presentación (`quote.receive`). Separación de responsabilidades: el dominio/use-case
  no "adivina" un valor de negocio, la capa de presentación decide qué mostrar cuando falta un dato.
- **DT-2**: El indicador "Modo demo" se deriva 100% del campo `provenance` ya existente en
  `Quote`/`KycVerification` (`"local-fallback"` vs cualquier otro valor real futuro, ej. `"didit"` /
  `"partner-x"`). No se agrega infraestructura de flags nueva — el dato de verdad ya vive en el
  dominio.
- **DT-3**: El timeout/reset de KYC se resuelve en la capa de presentación (`flow.tsx`), reutilizando
  `kycPendingStore.clear()`. Hoy `kycPending` es una variable local de `createContainer()`
  (`src/composition/container.ts:43`) que NO está expuesta en la interfaz `Container`. El Architect
  decide en F2 el punto exacto de exposición: (a) agregar un método `clearPendingKyc()` al
  `Container`, o (b) mover la lógica de retry/timeout de 40 intentos a un use-case dedicado que
  internamente llame `pending.clear()` al agotar los reintentos. Ninguna opción requiere tocar
  `ResumeKyc.execute()` en su camino feliz (`dec.terminal === true`).

## Constraint Directives (CD-N)
- **CD-1 (OBLIGATORIA)**: PROHIBIDO tocar el demo live (`yarvis` + `agentshop-*`, otros repos/apps)
  — todo el trabajo de esta HU se limita a archivos dentro de `chaski-v2/`.
- **CD-2**: PROHIBIDO tocar rutas API (`chaski-v2/src/app/api/**`) ni el gate server-side de Didit
  (`DiditKycGateway`) — el fix es 100% presentación + un ajuste puntual de un use-case
  (`track-remittance.ts`), sin tocar infraestructura de KYC real ni el server-truth actual.
- **CD-3**: OBLIGATORIO derivar el indicador "Modo demo" del campo `provenance` ya existente en el
  dominio (`Quote.provenance`, `KycVerification.provenance`) — PROHIBIDO introducir una env var o
  flag de config nuevo para esto.
- **CD-4**: PROHIBIDO modificar `FallbackPayoutGateway` / `FallbackKycGateway`
  (`src/infrastructure/fallback/gateways.ts`) para "simular menos" — no cambiar la identidad
  hardcodeada, el `signMessage` de la wallet demo, ni el monto fijo. Esos comportamientos son
  harness de demo intencional (ver comentarios en el propio archivo); esta HU solo agrega
  visibilidad de que son simulados, no cambia su lógica.

## Missing Inputs
- **[resuelto en F2]** Punto exacto de exposición de la limpieza de pending KYC en el `Container`
  (método nuevo `clearPendingKyc()` vs mover el retry-loop de 40 intentos a un use-case dedicado)
  — decisión de Architect en F2/SDD.
- **[resuelto en F2]** Copy exacto y ubicación visual del banner "Modo demo" (texto, tono de `Pill`,
  si va en el header fijo o por-step) — Architect/Dev con criterio de diseño, reusando la paleta y
  el componente `Pill` ya definidos en `src/presentation/ui.tsx`.
- **[NEEDS CLARIFICATION]** Los 2 hallazgos "Menores" del ticket (pantalla en blanco si `lockQuote`
  falla al retomar KYC, ventana de doble-submit) quedaron marcados Scope OUT de esta HU por ser P1
  declarado como "demo-safe" (B2/B3/A4). Si el humano quiere incluirlos en el mismo wave, avisar
  antes de F2 — si no, quedan como candidatos a un ticket de seguimiento.

## Análisis de paralelismo
- Esta HU NO bloquea otras HUs activas de `wasiai-a2a` (repos distintos, sin dependencia de código).
- Dentro de `chaski-v2` no hay otras HUs en curso conocidas — no bloquea nada existente.
- Los 3 grupos de ACs (B2 / B3 / A4) tocan el MISMO archivo (`flow.tsx`) en secciones distintas
  (`Receipt`, render de steps `review/track/done`, efecto de resume de KYC respectivamente). Se
  recomienda al Architect planificarlos como **waves secuenciales dentro de un mismo Dev run**
  (Wave 1: B2 → Wave 2: B3 → Wave 3: A4) en vez de sub-agentes Dev verdaderamente paralelos, para
  evitar conflictos de merge sobre el mismo archivo. `track-remittance.ts` (AC-1) es independiente
  y puede resolverse en cualquier wave sin conflicto.
- Cambia el contrato de `deliveredPen` (ahora puede llegar `null` hasta la UI en vez de colapsarse
  antes) — el Architect debe verificar que ningún otro consumidor de `TrackRemittance`/`Remittance`
  (ej. `list-history.ts`, historial) asuma implícitamente que `deliveredPen` nunca es `null` en
  estado `settled`.
