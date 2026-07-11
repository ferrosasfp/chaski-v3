// Application — errores de negocio compartidos. Viven en application/ para que los importen
// tanto infrastructure/ (persistence) como test-support/ (fakes) sin ciclo (application no
// depende de infra).

/** Lock optimista (CAS) fallido: el estado persistido cambió desde la lectura base (carrera
 * detectada). Fail-loud (CD-4): NUNCA pisar silenciosamente el estado ajeno. */
export class ConcurrentModificationError extends Error {
  readonly reason = "concurrent_modification" as const;
  constructor(
    readonly id: string,
    readonly expected: number,
    readonly actual: number,
  ) {
    super(`concurrent_modification:${id} expected=${expected} actual=${actual}`);
    this.name = "ConcurrentModificationError";
  }
}
