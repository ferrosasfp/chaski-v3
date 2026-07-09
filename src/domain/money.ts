// Domain — Money value object. Money-path: cero floats sueltos; se guarda en unidades MENORES
// (enteros) por moneda. Puro, sin deps. Los montos de remesa caben holgados en Number safe-int.

export type Currency = "USDC" | "PEN";

const DECIMALS: Record<Currency, number> = { USDC: 6, PEN: 2 };
const LOCALE: Record<Currency, string> = { USDC: "en-US", PEN: "es-PE" };
const SYMBOL: Record<Currency, string> = { USDC: "$", PEN: "S/" };

export class Money {
  private constructor(
    readonly minor: number, // unidades menores (micro-USDC / centavos PEN), entero
    readonly currency: Currency,
  ) {}

  static of(major: number, currency: Currency): Money {
    if (!Number.isFinite(major) || major < 0) {
      throw new Error(`invalid_money_amount:${major}`);
    }
    const factor = 10 ** DECIMALS[currency];
    return new Money(Math.round(major * factor), currency);
  }

  static fromMinor(minor: number, currency: Currency): Money {
    if (!Number.isInteger(minor) || minor < 0) {
      throw new Error(`invalid_money_minor:${minor}`);
    }
    return new Money(minor, currency);
  }

  static zero(currency: Currency): Money {
    return new Money(0, currency);
  }

  get major(): number {
    return this.minor / 10 ** DECIMALS[this.currency];
  }

  isZero(): boolean {
    return this.minor === 0;
  }

  minus(other: Money): Money {
    this.assertSameCurrency(other);
    const r = this.minor - other.minor;
    if (r < 0) throw new Error("money_negative_result");
    return new Money(r, this.currency);
  }

  /** Formato humano localizado (para la UI, cripto-invisible). */
  format(): string {
    return `${SYMBOL[this.currency]}${this.major.toLocaleString(LOCALE[this.currency], {
      minimumFractionDigits: this.currency === "PEN" ? 2 : 2,
      maximumFractionDigits: DECIMALS[this.currency],
    })}`;
  }

  private assertSameCurrency(other: Money): void {
    if (other.currency !== this.currency) {
      throw new Error(`money_currency_mismatch:${this.currency}!=${other.currency}`);
    }
  }
}
