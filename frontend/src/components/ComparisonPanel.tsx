import {
  Bar,
  BarChart,
  CartesianGrid,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { CompareRow } from '../types';
import { ChartCard } from './ChartCard';
import { ChartFrame } from './ChartFrame';

const colors = ['#3b5bfd', '#17b26a', '#f79009', '#7a5af8'];

function label(row: CompareRow) {
  return `${row.patient} ${row.phase} ${row.path_id}`;
}

function aggregate(rows: CompareRow[]) {
  return rows.map((r) => ({
    ...r,
    label: label(r),
    duration_s: r.duration_s ?? 0,
    feedback_events: r.feedback_events ?? 0,
    mean_intensity: r.mean_intensity ?? 0,
    mean_speed_m_s: r.mean_speed_m_s ?? 0,
    min_closest_distance: r.min_closest_distance ?? 0,
  }));
}

function CustomLegend({ items }: { items: Array<{ name: string; color: string }> }) {
  return (
    <div className="customLegend">
      {items.map((item) => <span key={item.name}><i style={{ background: item.color }} />{item.name}</span>)}
    </div>
  );
}

function SafeBarChart({
  data,
  bars,
  height = 340,
}: {
  data: ReturnType<typeof aggregate>;
  bars: Array<{ key: string; name: string; color: string }>;
  height?: number;
}) {
  return (
    <>
      <ChartFrame height={height}>{(width, chartHeight) => (
      <BarChart width={width} height={chartHeight} data={data} margin={{ top: 16, right: 20, bottom: 86, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" />
        <XAxis dataKey="label" angle={-30} textAnchor="end" interval={0} height={92} />
        <YAxis />
        <Tooltip animationDuration={0} isAnimationActive={false} wrapperStyle={{ outline: 'none', zIndex: 3 }} />
        {bars.map((bar) => <Bar key={bar.key} dataKey={bar.key} name={bar.name} fill={bar.color} isAnimationActive={false} />)}
      </BarChart>
      )}</ChartFrame>
      <CustomLegend items={bars.map((b) => ({ name: b.name, color: b.color }))} />
    </>
  );
}

export function ComparisonPanel({ rows, mode }: { rows: CompareRow[]; mode: string }) {
  const data = aggregate(rows);
  const title = mode === 'users' ? 'Paragone tra utenti' : 'Learning vs exploration';
  const subtitle = mode === 'users'
    ? 'Ogni barra rappresenta una sessione filtrata per utenti, condition, path e fase.'
    : 'Confronto diretto tra fasi per lo stesso filtro selezionato.';

  if (!rows.length) {
    return (
      <ChartCard title={title} subtitle="Nessuna sessione disponibile per il filtro corrente.">
        <div className="emptyState">Seleziona altri utenti, path o condition.</div>
      </ChartCard>
    );
  }

  return (
    <>
      <ChartCard title={title} subtitle={subtitle} className="span2">
        <SafeBarChart
          data={data}
          height={380}
          bars={[
            { key: 'duration_s', name: 'duration (s)', color: colors[0] },
            { key: 'feedback_events', name: 'feedback events', color: colors[1] },
          ]}
        />
      </ChartCard>

      <ChartCard title="Metriche movimento e feedback">
        <SafeBarChart
          data={data}
          bars={[
            { key: 'mean_speed_m_s', name: 'mean speed', color: colors[0] },
            { key: 'min_closest_distance', name: 'min closest distance', color: colors[1] },
          ]}
        />
      </ChartCard>

      <ChartCard title="Intensità media feedback">
        <SafeBarChart
          data={data}
          bars={[{ key: 'mean_intensity', name: 'mean intensity', color: colors[2] }]}
        />
      </ChartCard>

      <section className="card span2 tableCard">
        <div className="cardHeader">
          <div>
            <h2>Tabella confronto</h2>
            <p>Usala per individuare sessioni sospette, path problematici o differenze tra learning/exploration.</p>
          </div>
        </div>
        <div className="tableWrap">
          <table>
            <thead>
              <tr>
                <th>Patient</th><th>Phase</th><th>Path</th><th>Start</th><th>Duration</th><th>Feedback</th><th>Mean speed</th><th>Mean intensity</th><th>Warning</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.session_id}>
                  <td>{r.patient}</td>
                  <td>{r.phase}</td>
                  <td>{r.path_id}</td>
                  <td>{r.start_time ?? '—'}</td>
                  <td>{r.duration_s?.toFixed(1) ?? '—'}</td>
                  <td>{r.feedback_events}</td>
                  <td>{r.mean_speed_m_s?.toFixed(2) ?? '—'}</td>
                  <td>{r.mean_intensity?.toFixed(2) ?? '—'}</td>
                  <td>{r.warning}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
