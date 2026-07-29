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

export function fmtNum(value: number | null | undefined, digits = 2, suffix = '') {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return `${value.toFixed(digits)}${suffix}`;
}
