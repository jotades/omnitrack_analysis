import { useEffect, useMemo, useState } from 'react';
import { Footprints, Gauge, ListChecks, Radio, Timer, Zap } from 'lucide-react';
import { fetchCompareRows } from '../api';
import type { CompareRow } from '../types';

function fmt(value: number | null | undefined, digits = 2, suffix = '') {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return `${value.toFixed(digits)}${suffix}`;
}

function sum(rows: CompareRow[], key: keyof CompareRow): number {
  return rows.reduce((total, r) => {
    const v = r[key];
    return total + (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  }, 0);
}

function avg(rows: CompareRow[], key: keyof CompareRow): number | null {
  const values = rows.map((r) => r[key]).filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

function max(rows: CompareRow[], key: keyof CompareRow): number | null {
  const values = rows.map((r) => r[key]).filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  return values.length ? Math.max(...values) : null;
}

/** Patient-wide totals across every recorded session (both phases), as an
 * overview strip above the single-session charts — which stay scoped to
 * whichever one session is currently selected. */
export function PatientSummaryCards({ patient }: { patient: string }) {
  const [rows, setRows] = useState<CompareRow[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!patient) { setRows([]); return; }
    setLoading(true);
    fetchCompareRows({ patients: [patient], phase: 'all', includeSuspicious: true })
      .then(setRows)
      .catch(() => setRows([]))
      .finally(() => setLoading(false));
  }, [patient]);

  const items = useMemo(() => {
    if (!rows.length) return [];
    return [
      { label: 'Sessions recorded', value: String(rows.length), icon: ListChecks },
      { label: 'Total duration', value: fmt(sum(rows, 'duration_s') / 60, 1, ' min'), icon: Timer },
      { label: 'Total feedback events', value: String(sum(rows, 'feedback_events')), icon: Radio },
      { label: 'Total distance walked', value: fmt(sum(rows, 'total_distance_m'), 1, ' m'), icon: Footprints },
      { label: 'Mean speed', value: fmt(avg(rows, 'mean_speed_m_s'), 2, ' m/s'), icon: Gauge },
      { label: 'Max acceleration', value: fmt(max(rows, 'max_accel_norm'), 2), icon: Zap },
    ];
  }, [rows]);

  if (!patient) return null;

  return (
    <div className="metricGrid patientSummaryGrid">
      {loading && !items.length ? (
        <div className="emptyState">Loading patient summary…</div>
      ) : (
        items.map((item) => {
          const Icon = item.icon;
          return (
            <div className="metricCard" key={item.label}>
              <div className="metricIcon"><Icon size={18} /></div>
              <span>{item.label}</span>
              <strong>{item.value}</strong>
            </div>
          );
        })
      )}
    </div>
  );
}
