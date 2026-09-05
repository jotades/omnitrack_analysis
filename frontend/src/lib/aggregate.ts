function numericValues<T>(rows: T[], key: keyof T): number[] {
  return rows
    .map((r) => r[key] as unknown)
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
}

export function sumBy<T>(rows: T[], key: keyof T): number {
  return numericValues(rows, key).reduce((a, b) => a + b, 0);
}

export function avgBy<T>(rows: T[], key: keyof T): number | null {
  const values = numericValues(rows, key);
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

export function maxBy<T>(rows: T[], key: keyof T): number | null {
  const values = numericValues(rows, key);
  return values.length ? Math.max(...values) : null;
}

/** Sample standard deviation (ddof=1) — null below 2 points, where "spread" isn't meaningful. */
export function stdDevBy<T>(rows: T[], key: keyof T): number | null {
  const values = numericValues(rows, key);
  if (values.length < 2) return null;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

export function fmtNum(value: number | null | undefined, digits = 2, suffix = '') {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return `${value.toFixed(digits)}${suffix}`;
}
