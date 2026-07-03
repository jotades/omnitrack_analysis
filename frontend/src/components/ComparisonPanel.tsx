import { useMemo, useState } from 'react';
import { Play, RefreshCw } from 'lucide-react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { fetchCompareRows } from '../api';
import type { CompareRow, SessionRow } from '../types';
import { ChartCard } from './ChartCard';
import { ChartFrame } from './ChartFrame';

const accent = '#3b5bfd';
const phaseColors: Record<string, string> = {
  learning: '#3b5bfd',
  exploration: '#f79009',
};

const METRICS: Array<{ key: keyof CompareRow; label: string; unit: string; digits: number }> = [
  { key: 'duration_s', label: 'Duration', unit: 's', digits: 1 },
  { key: 'feedback_events', label: 'Feedback events', unit: '', digits: 0 },
  { key: 'feedback_events_per_min', label: 'Feedback events / min', unit: '/min', digits: 2 },
  { key: 'mean_intensity', label: 'Mean feedback intensity', unit: '', digits: 2 },
  { key: 'mean_speed_m_s', label: 'Mean speed', unit: 'm/s', digits: 2 },
  { key: 'max_speed_m_s', label: 'Max speed', unit: 'm/s', digits: 2 },
  { key: 'mean_closest_distance', label: 'Mean closest distance', unit: 'm', digits: 2 },
  { key: 'min_closest_distance', label: 'Min closest distance', unit: 'm', digits: 2 },
];

interface Props {
  sessions: SessionRow[];
}

function uniq(values: string[]) {
  return Array.from(new Set(values.filter(Boolean))).sort();
}

function metricValue(row: CompareRow, key: keyof CompareRow): number | null {
  const v = row[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function CustomLegend({ items }: { items: Array<{ name: string; color: string }> }) {
  if (!items.length) return null;
  return (
    <div className="customLegend">
      {items.map((item) => <span key={item.name}><i style={{ background: item.color }} />{item.name}</span>)}
    </div>
  );
}

export function ComparisonPanel({ sessions }: Props) {
  const patients = useMemo(() => uniq(sessions.map((s) => s.patient)), [sessions]);
  const conditions = useMemo(() => uniq(sessions.map((s) => s.condition)), [sessions]);
  const paths = useMemo(() => uniq(sessions.map((s) => s.path_id)), [sessions]);
  const conditionLabel = (c: string) => sessions.find((s) => s.condition === c)?.condition_label ?? c;

  const [selectedPatients, setSelectedPatients] = useState<string[]>(() => patients.slice(0, Math.min(3, patients.length)));
  const [condition, setCondition] = useState('all');
  const [phase, setPhase] = useState('all');
  const [path, setPath] = useState('all');
  const [includeSuspicious, setIncludeSuspicious] = useState(true);
  const [metricKey, setMetricKey] = useState<keyof CompareRow>('duration_s');

  const [rows, setRows] = useState<CompareRow[]>([]);
  // Which fetched sessions actually feed the chart: every row starts checked and
  // can be excluded from the table below, e.g. to keep one session per path.
  const [activeSessionIds, setActiveSessionIds] = useState<number[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasRun, setHasRun] = useState(false);
  // Snapshot of the filters used for the last generated comparison, shown as chart subtitle.
  const [runContext, setRunContext] = useState('');

  const metric = METRICS.find((m) => m.key === metricKey) ?? METRICS[0];

  const togglePatient = (p: string) => {
    setSelectedPatients((old) => old.includes(p) ? old.filter((x) => x !== p) : [...old, p]);
  };

  async function runComparison() {
    if (!selectedPatients.length) return;
    setLoading(true);
    setError(null);
    try {
      const result = await fetchCompareRows({
        patients: selectedPatients,
        condition,
        pathId: path,
        phase,
        includeSuspicious,
      });
      setRows(result);
      setActiveSessionIds(result.map((r) => r.session_id));
      setHasRun(true);
      setRunContext([
        `${selectedPatients.length} patients`,
        condition === 'all' ? 'all conditions' : conditionLabel(condition),
        phase === 'all' ? 'both phases' : phase,
        path === 'all' ? 'all paths' : path,
      ].join(' · '));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  const activeRows = useMemo(
    () => rows.filter((r) => activeSessionIds.includes(r.session_id)),
    [rows, activeSessionIds],
  );

  const toggleSession = (id: number) => {
    setActiveSessionIds((old) => old.includes(id) ? old.filter((x) => x !== id) : [...old, id]);
  };

  const chart = useMemo(() => {
    // One bar per patient: mean of the selected metric across the checked sessions.
    const byPatient = new Map<string, CompareRow[]>();
    for (const r of activeRows) {
      const arr = byPatient.get(r.patient) ?? [];
      arr.push(r);
      byPatient.set(r.patient, arr);
    }
    return Array.from(byPatient.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([patient, mine]) => {
        const values = mine.map((r) => metricValue(r, metric.key)).filter((v): v is number => v !== null);
        const mean = values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
        return { label: `${patient} (${mine.length})`, value: mean, color: accent };
      });
  }, [activeRows, metric.key]);

  return (
    <>
      <section className="card comparisonControls">
        <div className="cardHeader">
          <div>
            <h2>Compare patients</h2>
            <p>These filters are independent from the single-session analysis. Pick patients, narrow the scope if you want, then generate the graph.</p>
          </div>
        </div>
        <div className="comparisonControlsBody">
          <div className="patientChips" aria-label="Patients to compare">
            {patients.map((p) => (
              <button
                key={p}
                type="button"
                className={`chip ${selectedPatients.includes(p) ? 'active' : ''}`}
                onClick={() => togglePatient(p)}
              >
                {p}
              </button>
            ))}
            <button type="button" className="chip" onClick={() => setSelectedPatients(selectedPatients.length === patients.length ? [] : patients)}>
              {selectedPatients.length === patients.length ? 'Clear all' : 'Select all'}
            </button>
          </div>

          <div className="comparisonFilterGrid">
            <label>
              Condition
              <select value={condition} onChange={(e) => setCondition(e.target.value)}>
                <option value="all">all conditions</option>
                {conditions.map((c) => <option key={c} value={c}>{conditionLabel(c)}</option>)}
              </select>
            </label>
            <label>
              Phase
              <select value={phase} onChange={(e) => setPhase(e.target.value)}>
                <option value="all">both phases</option>
                <option value="learning">learning</option>
                <option value="exploration">exploration</option>
              </select>
            </label>
            <label>
              Path
              <select value={path} onChange={(e) => setPath(e.target.value)}>
                <option value="all">all paths</option>
                {paths.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </label>
            <label>
              Metric
              <select value={String(metricKey)} onChange={(e) => setMetricKey(e.target.value as keyof CompareRow)}>
                {METRICS.map((m) => <option key={String(m.key)} value={String(m.key)}>{m.label}{m.unit ? ` (${m.unit})` : ''}</option>)}
              </select>
            </label>
          </div>

          <div className="comparisonOptionsRow">
            <label className="inlineCheck">
              <input type="checkbox" checked={includeSuspicious} onChange={(e) => setIncludeSuspicious(e.target.checked)} />
              Include interrupted/suspicious sessions
            </label>
            <button
              type="button"
              className="generateButton"
              onClick={runComparison}
              disabled={loading || !selectedPatients.length}
            >
              {loading ? <RefreshCw size={16} className="spin" /> : <Play size={16} />}
              {loading ? 'Computing…' : 'Generate comparison'}
            </button>
            {!selectedPatients.length
              ? <span className="miniHint">Select at least one patient.</span>
              : <span className="miniHint">First run over many sessions can take a while; results are cached after that.</span>}
          </div>
        </div>
      </section>

      {error ? <div className="errorBox">{error}</div> : null}

      <section className="dashboardGrid">
        <ChartCard
          title="Patient comparison"
          subtitle={hasRun ? `${metric.label} — mean per patient over ${activeRows.length}/${rows.length} checked sessions · ${runContext} · bar label shows (session count)` : 'Nothing generated yet.'}
          className="span2"
        >
          {!hasRun ? (
            <div className="emptyState">Pick patients above and press “Generate comparison”.</div>
          ) : !rows.length ? (
            <div className="emptyState">No sessions match these filters. Broaden the condition, phase or path.</div>
          ) : !chart.length ? (
            <div className="emptyState">All sessions are unchecked. Tick at least one session in the table below.</div>
          ) : (
            <>
              <ChartFrame height={360}>{(width, height) => (
                <BarChart width={width} height={height} data={chart} margin={{ top: 16, right: 20, bottom: 40, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="label" angle={-20} textAnchor="end" interval={0} height={58} />
                  <YAxis unit={metric.unit ? ` ${metric.unit}` : ''} />
                  <Tooltip
                    animationDuration={0}
                    isAnimationActive={false}
                    wrapperStyle={{ outline: 'none', zIndex: 3 }}
                    formatter={(v: unknown) => typeof v === 'number' ? `${v.toFixed(metric.digits)}${metric.unit ? ` ${metric.unit}` : ''}` : '—'}
                  />
                  <Bar dataKey="value" name={metric.label} isAnimationActive={false} radius={[6, 6, 0, 0]}>
                    {chart.map((d) => <Cell key={d.label} fill={d.color} />)}
                  </Bar>
                </BarChart>
              )}</ChartFrame>
              <CustomLegend items={[{ name: `mean ${metric.label.toLowerCase()} per patient`, color: accent }]} />
            </>
          )}
        </ChartCard>

        {hasRun && rows.length ? (
          <section className="card span2 tableCard">
            <div className="cardHeader">
              <div>
                <h2>Choose the sessions to compare ({activeRows.length}/{rows.length} checked)</h2>
                <p>Only checked sessions feed the chart above — e.g. keep a single session per path to compare like with like.</p>
              </div>
            </div>
            <div className="tableWrap">
              <table>
                <thead>
                  <tr>
                    <th>
                      <input
                        type="checkbox"
                        aria-label="Toggle all sessions"
                        checked={activeSessionIds.length === rows.length}
                        onChange={(e) => setActiveSessionIds(e.target.checked ? rows.map((r) => r.session_id) : [])}
                      />
                    </th>
                    <th>Patient</th><th>Phase</th><th>Path</th><th>Start</th><th>Duration</th><th>Feedback</th><th>Mean speed</th><th>Mean intensity</th><th>Warning</th>
                  </tr>
                </thead>
                <tbody>
                  {[...rows].sort((a, b) => `${a.patient}-${a.path_id}-${a.phase}-${a.start_time}`.localeCompare(`${b.patient}-${b.path_id}-${b.phase}-${b.start_time}`)).map((r) => {
                    const active = activeSessionIds.includes(r.session_id);
                    return (
                      <tr key={r.session_id} className={active ? '' : 'rowExcluded'}>
                        <td>
                          <input
                            type="checkbox"
                            aria-label={`Include ${r.patient} ${r.phase} ${r.path_id}`}
                            checked={active}
                            onChange={() => toggleSession(r.session_id)}
                          />
                        </td>
                        <td>{r.patient}</td>
                        <td><span style={{ color: phaseColors[r.phase] ?? 'inherit', fontWeight: 700 }}>{r.phase}</span></td>
                        <td>{r.path_id}</td>
                        <td>{r.start_time ?? '—'}</td>
                        <td>{r.duration_s?.toFixed(1) ?? '—'}</td>
                        <td>{r.feedback_events}</td>
                        <td>{r.mean_speed_m_s?.toFixed(2) ?? '—'}</td>
                        <td>{r.mean_intensity?.toFixed(2) ?? '—'}</td>
                        <td>{r.warning}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        ) : null}
      </section>
    </>
  );
}
