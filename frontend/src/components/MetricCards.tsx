import { Activity, Gauge, Radio, Route, Timer } from 'lucide-react';
import type { MetricSummary } from '../types';

function fmt(value: number | null | undefined, digits = 2, suffix = '') {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return `${value.toFixed(digits)}${suffix}`;
}

export function MetricCards({ metrics }: { metrics?: MetricSummary }) {
  const items = [
    { label: 'Durata', value: fmt(metrics?.duration_s, 1, ' s'), icon: Timer },
    { label: 'Feedback events', value: metrics?.feedback_events ?? '—', icon: Radio },
    { label: 'Mean intensity', value: fmt(metrics?.mean_intensity, 2), icon: Activity },
    { label: 'Mean speed', value: fmt(metrics?.mean_speed_m_s, 2, ' m/s'), icon: Gauge },
    { label: 'Min closest distance', value: fmt(metrics?.min_closest_distance, 2, ' m'), icon: Route },
  ];

  return (
    <div className="metricGrid">
      {items.map((item) => {
        const Icon = item.icon;
        return (
          <div className="metricCard" key={item.label}>
            <div className="metricIcon"><Icon size={18} /></div>
            <span>{item.label}</span>
            <strong>{item.value}</strong>
          </div>
        );
      })}
    </div>
  );
}
