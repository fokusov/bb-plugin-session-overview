import type { ReactNode } from "react";

export function SessionRow({ label, children }: { label: ReactNode; children: ReactNode }) {
  return <div className="session-row"><span>{label}</span><span className="session-value">{children}</span></div>;
}

export function SessionMeter({ label, percent }: { label: string; percent: number }) {
  return <progress className="session-meter" aria-label={label} max={100} value={Math.min(100, Math.max(0, percent))} />;
}

export function percentLabel(value: number) {
  return `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })}%`;
}

export function moneyLabel(amount: number, currency: string) {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency, maximumFractionDigits: 4 }).format(amount);
  } catch {
    return `${amount.toLocaleString()} ${currency}`;
  }
}
