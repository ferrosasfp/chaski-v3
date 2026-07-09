# Chaski v2 — Design spec (UI/UX pro)

Frontend NUEVO de la remesa real (v2), **en paralelo** al demo (yarvis) que ven los jurados Team1.
Mucho más elaborado que el demo: flujo guiado completo, no una sola pantalla de chat.

## Producto (una frase)
**"Mandá plata a tu familia en Perú con solo pedirlo."** El resultado primero (soles que llegan a la
Yape de mamá), la cripto invisible. El sender llega con USDC; el receptor recibe **PEN real** en su Yape.

## Identidad — Chaski andino
El **chaski** era el mensajero del Tahuantinsuyo que llevaba valor a través de los Andes, rápido y confiable.
- **Paleta:** cochinilla (rojo profundo andino, ~`#C0264E`) como acento; verde andino (`#1F6F5C`) para éxito/dinero;
  neutros cálidos (piedra/arena, no gris frío); tinta casi-negra. Fondo claro, aire.
- **Tipografía:** Hanken Grotesk (body + UI) + un display con carácter para los montos grandes (tabular-nums en cifras).
- **Motivos:** el **khipu** (cuerdas anudadas = el ledger/registro de la remesa) como elemento gráfico del recibo/tracking;
  la silueta del chaski en movimiento para el estado "en camino".
- **Tono:** cálido, claro, confiable. LATAM, no cripto-bro. Cero jerga (nada de "settle"/"x402"/"chain" al usuario).

## Flujo completo (screens + estados reales)
1. **Enviar (home):** monto en USD → **preview en vivo** de PEN que recibe el receptor (via el agente FX real),
   con tasa + fee + ETA visibles y honestos. CTA grande. Cripto-invisible: se habla de $ y S/, no de USDC.
2. **Destinatario:** nombre + país (PE) + método (Yape / Plin / CCI banco) + destino (celular/CCI). Validación.
3. **Verificación (KYC):** verificación de identidad del sender (flujo Didit). Estados: idle → verificando →
   aprobado / rechazado. Copy humano ("Necesitamos verificar tu identidad una vez, por seguridad y ley").
4. **Revisar y confirmar:** el **quote fijado** (rate, fee, neto en S/, ETA), el destinatario, el estado KYC.
   Confirmar → autorizar el USDC (firma). Aviso claro del monto exacto que sale y el que llega.
5. **Seguimiento (tracking):** la máquina de estados en vivo — *cotización fijada → fondos en camino →
   pagando al receptor → entregado*. Con la silueta del chaski avanzando + refs on-chain (colapsables, opt-in).
   Estado final: "Tu familia recibió **S/ Y**" + confirmación.
6. **Recibo:** recibo compartible con motivo khipu — desglose completo, tx refs, timestamp, estado. Descargable.
7. **Historial:** remesas pasadas con estado (entregada / en curso / reembolsada), montos, fechas. Repetir envío 1-tap.

## Manejo de estados (lo que el demo NO tiene)
- **Loading** por paso (skeletons, no spinners genéricos). **Empty states** (sin historial → onboarding cálido).
- **Errores humanos + accionables:** quote vencido → "la tasa cambió, revisá el nuevo monto"; KYC rechazado →
  qué hacer; payout fallido → "no se pudo entregar; te reembolsamos $X" (el refund del value-delivery, WKH-168).
- **QUOTE_STALE** (409 del gateway) → re-cotizar suave, sin perder el contexto.
- **Mobile-first** (la remesa es mobile), responsive, accesible (focus visible, contraste, prefers-reduced-motion).

## Arquitectura (reusa, no rebuildea)
- Reusa el **wiring a2a** del demo (patrón `/api/plan` + `/api/execute` + cliente server-side con la key),
  pero apuntando a los agentes **`remit-*`** (v2) — NO a los `agentshop-*` del demo.
- El flujo v2 tiene su propio orquestador de remesa (la máquina de estados = WKH-168, value-delivery), que en
  esta etapa corre en **fallback** (KYC/FX reales-en-fallback, payout mock) — la UI muestra el flujo completo
  end-to-end aunque el payout real esté gated al sandbox TransFi.
- Stack: matchear el del demo (Next.js app router + Tailwind, a confirmar con el mapeo de yarvis) para reusar patrones.

## vs el demo actual
El demo = una pantalla de chat NL → plan → execute → resultado. La v2 = **producto guiado**: monto con preview en
vivo, KYC, quote-lock, confirmación explícita, tracking con máquina de estados, recibo y historial. Diseño-forward,
estados reales, cripto-invisible. Es la cara "producto real" — el demo sigue siendo la cara "proof-of-concept" del jurado.
