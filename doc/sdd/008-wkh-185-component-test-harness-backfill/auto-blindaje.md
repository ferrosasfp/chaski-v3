# Auto-Blindaje — WKH-185 (harness jsdom+RTL + backfill)

### [2026-07-11 18:32] Wave 1 — T3: `window.location.reload` no redefinible en jsdom
- **Error**: `TypeError: Cannot redefine property: reload` al hacer `Object.defineProperty(window.location, "reload", ...)` para espiar el reload en T3.
- **Causa raíz**: en jsdom, la property `reload` del objeto `Location` es non-configurable, así que no se puede redefinir/espiar directamente (ni con `Object.defineProperty` sobre `window.location`, ni con `vi.spyOn(window.location, "reload")`).
- **Fix**: reemplazar el objeto `location` completo vía `Object.defineProperty(window, "location", { configurable: true, value: { ...originalLocation, reload: reloadSpy } })` y restaurarlo en un `finally`. Seguro acá porque el path de T3 (resume-loop → timeout → `onRetryKyc`) no lee `window.location.origin/href`, y T3 corre aislado y último en el archivo.
- **Aplicar en**: cualquier test de componente que necesite espiar `window.location.reload/assign/replace` bajo jsdom → reemplazar el objeto `location` entero y restaurarlo, no `defineProperty` sobre la property individual.
