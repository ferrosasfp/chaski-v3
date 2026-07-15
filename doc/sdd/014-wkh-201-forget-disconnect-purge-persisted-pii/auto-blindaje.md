# Auto-Blindaje — WKH-201 (clearByOwner purga PII persistida en el reset)

### [2026-07-14 21:20] Wave 2 — Consumidor del constructor `ForgetKyc` fuera del Scope IN
- **Error**: Al agregar el 3er arg `repo` al constructor de `ForgetKyc`, `tsc` falló en
  `src/test-support/test-container.ts:81` (`Expected 3 arguments, but got 2`), un archivo NO
  listado en la tabla "Files to Modify/Create" del Story File.
- **Causa raíz**: El Story File enumeró solo `container.ts` como wiring del constructor, pero existe
  un segundo composition root de tests — `test-container.ts` (harness RTL de WKH-185, posterior al
  survey del SDD) — que también instancia `ForgetKyc`. Cambiar la firma del constructor rompe TODO
  consumidor, no solo el listado. El propio gate CD-6 anticipa esto: "cualquier consumidor roto sale acá".
- **Fix**: Cambio mecánico byte-idéntico al wiring in-scope de `container.ts:89`:
  `new ForgetKyc(kycStore, pending, repo)`, reusando el `repo` (`InMemoryRepo`) ya presente en L60.
  Cero cambio de comportamiento. Documentado como desviación al orquestador.
- **Aplicar en**: Cualquier HU que cambie la firma de un constructor de use-case en chaski-v2 debe
  grep de AMBOS composition roots — `src/composition/container.ts` Y `src/test-support/test-container.ts` —
  antes de cerrar el scope. El survey de F2 debe incluir `test-container.ts` como consumidor implícito
  de todo constructor de use-case.
