import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, Play, RefreshCw } from 'lucide-react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { fetchTrialRows } from '../api';
import type { SessionRow, TrialRow } from '../types';
import { ChartCard } from './ChartCard';
import { ChartFrame } from './ChartFrame';
import { ConditionTrajectoriesGrid } from './ConditionTrajectoriesGrid';

const accent = '#3b5bfd';

const METRICS: Array<{ key: keyof TrialRow; label: string; unit: string; digits: number }> = [
  { key: 'overlap_pct', label: 'Route overlap with learning', unit: '%', digits: 1 },
  { key: 'mean_deviation_m', label: 'Mean deviation from learned route', unit: 'm', digits: 2 },
  { key: 'mean_turn_deviation_deg', label: 'Mean turn deviation', unit: '°', digits: 1 },
  { key: 'wrong_turns_count', label: 'Wrong turns', unit: '', digits: 0 },
  { key: 'stop_position_distance_m', label: 'Stop-position distance', unit: 'm', digits: 2 },
  { key: 'start_position_distance_m', label: 'Start-position distance', unit: 'm', digits: 2 },
  { key: 'stop_count', label: 'Times stopped walking', unit: '', digits: 0 },
  { key: 'border_reached_count', label: 'Times reached border', unit: '', digits: 0 },
];

interface Props {
  sessions: SessionRow[];
}

function uniq(values: string[]) {
  return Array.from(new Set(values.filter(Boolean))).sort();
}

function metricValue(row: TrialRow, key: keyof TrialRow): number | null {
  const v = row[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function rowKey(r: TrialRow): string {
  return `${r.patient}|${r.condition}|${r.path_id}|${r.exploration_session_id ?? 'none'}|${r.attempt_number ?? 0}`;
}

function trialKey(r: TrialRow): string {
  return `${r.patient}|${r.condition}|${r.path_id}`;
}

function CustomLegend({ items }: { items: Array<{ name: string; color: string }> }) {
  if (!items.length) return null;
  return (
    <div className="customLegend">
      {items.map((item) => <span key={item.name}><i style={{ background: item.color }} />{item.name}</span>)}
    </div>
  );
}

export function TrialsPanel({ sessions }: Props) {
  // ---------------------------------------------------------------------
  // Trial overview: pick one patient, see every condition × path they ran
  // (learning-vs-exploration mini charts + the aggregated trial metrics for
  // each) at once. No condition/path filter here — every trial is shown, so
  // filtering would just hide things; each mini chart has its own dropdown
  // to pick which recorded attempt to display when there's more than one.
  // ---------------------------------------------------------------------
  const patients = useMemo(() => uniq(sessions.map((s) => s.patient)), [sessions]);
  const [selectedPatient, setSelectedPatient] = useState('');

  const conditionLabel = (c: string) => sessions.find((s) => s.condition === c)?.condition_label ?? c;

  useEffect(() => {
    if (!selectedPatient && patients.length) setSelectedPatient(patients[0]);
  }, [patients, selectedPatient]);

  const [patientTrialRows, setPatientTrialRows] = useState<TrialRow[]>([]);
  const [patientTrialRowsLoading, setPatientTrialRowsLoading] = useState(false);
  const [patientTrialRowsError, setPatientTrialRowsError] = useState<string | null>(null);

  useEffect(() => {
    if (!selectedPatient) { setPatientTrialRows([]); return; }
    const controller = new AbortController();
    setPatientTrialRowsLoading(true);
    setPatientTrialRowsError(null);
    fetchTrialRows({ patients: [selectedPatient], includeSuspicious: true, signal: controller.signal })
      .then((result) => setPatientTrialRows(result))
      .catch((e) => {
        if (e instanceof DOMException && e.name === 'AbortError') return;
        setPatientTrialRowsError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => { if (!controller.signal.aborted) setPatientTrialRowsLoading(false); });
    return () => controller.abort();
  }, [selectedPatient]);

  // ---------------------------------------------------------------------
  // Cross-trial comparison (many patients/trials at once) — collapsed by
  // default; the primary view above is the single-trial detail.
  // ---------------------------------------------------------------------
  const conditions = useMemo(() => uniq(sessions.map((s) => s.condition)), [sessions]);
  const paths = useMemo(() => uniq(sessions.map((s) => s.path_id)), [sessions]);

  const [compareOpen, setCompareOpen] = useState(false);
  const [comparePatients, setComparePatients] = useState<string[]>(() => patients.slice(0, Math.min(3, patients.length)));
  const [compareCondition, setCompareCondition] = useState('all');
  const [comparePath, setComparePath] = useState('all');
  const [includeSuspicious, setIncludeSuspicious] = useState(true);
  const [metricKey, setMetricKey] = useState<keyof TrialRow>('overlap_pct');

  const [rows, setRows] = useState<TrialRow[]>([]);
  const [activeKeys, setActiveKeys] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasRun, setHasRun] = useState(false);
  const [runContext, setRunContext] = useState('');

  const metric = METRICS.find((m) => m.key === metricKey) ?? METRICS[0];

  const toggleComparePatient = (p: string) => {
    setComparePatients((old) => old.includes(p) ? old.filter((x) => x !== p) : [...old, p]);
  };

  async function runComparison() {
    if (!comparePatients.length) return;
    setLoading(true);
    setError(null);
    try {
      const result = await fetchTrialRows({
        patients: comparePatients,
        condition: compareCondition,
        pathId: comparePath,
        includeSuspicious,
      });
      setRows(result);
      setActiveKeys(result.map(rowKey));
      setHasRun(true);
      setRunContext([
        `${comparePatients.length} patients`,
        compareCondition === 'all' ? 'all conditions' : conditionLabel(compareCondition),
        comparePath === 'all' ? 'all paths' : comparePath,
      ].join(' · '));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  const activeRows = useMemo(
    () => rows.filter((r) => activeKeys.includes(rowKey(r))),
    [rows, activeKeys],
  );

  const toggleRow = (key: string) => {
    setActiveKeys((old) => old.includes(key) ? old.filter((x) => x !== key) : [...old, key]);
  };

  const chart = useMemo(() => {
    const byPatient = new Map<string, TrialRow[]>();
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

  const lostSummary = useMemo(() => {
    const byPatient = new Map<string, { total: Set<string>; lost: Set<string> }>();
    for (const r of rows) {
      const entry = byPatient.get(r.patient) ?? { total: new Set(), lost: new Set() };
      const key = trialKey(r);
      entry.total.add(key);
      if (r.got_lost) entry.lost.add(key);
      byPatient.set(r.patient, entry);
    }
    return Array.from(byPatient.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([patient, { total, lost }]) => ({ patient, total: total.size, lost: lost.size }));
  }, [rows]);

  return (
    <>
      <section className="card comparisonControls">
        <div className="cardHeader">
          <div>
            <h2>Trial overview: exploration vs. learning</h2>
            <p>Pick a patient to see every condition × path they ran, each with the learning/exploration trajectory overlay and the aggregated trial metrics.</p>
          </div>
          {patientTrialRowsLoading ? <RefreshCw size={16} className="spin" /> : null}
        </div>
        <div className="comparisonControlsBody">
          <div className="comparisonFilterGrid">
            <label>
              Patient
              <select value={selectedPatient} onChange={(e) => setSelectedPatient(e.target.value)}>
                {patients.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </label>
          </div>
          {patientTrialRowsError ? <div className="errorBox">{patientTrialRowsError}</div> : null}
        </div>
      </section>

      {selectedPatient ? (
        <ConditionTrajectoriesGrid
          sessions={sessions}
          patient={selectedPatient}
          alpha={0.2}
          smoothTrajectory
          smoothOnlySeeker
          trialRows={patientTrialRows}
        />
      ) : null}

      <section className="card">
        <button type="button" className="collapseHeader" onClick={() => setCompareOpen(!compareOpen)} aria-expanded={compareOpen}>
          <ChevronDown size={18} className={`collapseChevron ${compareOpen ? 'open' : ''}`} />
          <span className="collapseTitle">
            <strong>Compare across trials</strong>
            <small>Aggregate the metrics above over many patients/trials at once — bar chart + table</small>
          </span>
        </button>

        {compareOpen ? (
          <div className="conditionGridBody">
            <div className="patientChips" aria-label="Patients to compare">
              {patients.map((p) => (
                <button
                  key={p}
                  type="button"
                  className={`chip ${comparePatients.includes(p) ? 'active' : ''}`}
                  onClick={() => toggleComparePatient(p)}
                >
                  {p}
                </button>
              ))}
              <button type="button" className="chip" onClick={() => setComparePatients(comparePatients.length === patients.length ? [] : patients)}>
                {comparePatients.length === patients.length ? 'Clear all' : 'Select all'}
              </button>
            </div>

            <div className="comparisonFilterGrid">
              <label>
                Condition
                <select value={compareCondition} onChange={(e) => setCompareCondition(e.target.value)}>
                  <option value="all">all conditions</option>
                  {conditions.map((c) => <option key={c} value={c}>{conditionLabel(c)}</option>)}
                </select>
              </label>
              <label>
                Path
                <select value={comparePath} onChange={(e) => setComparePath(e.target.value)}>
                  <option value="all">all paths</option>
                  {paths.map((p) => <option key={p} value={p}>{p}</option>)}
                </select>
              </label>
              <label>
                Metric
                <select value={String(metricKey)} onChange={(e) => setMetricKey(e.target.value as keyof TrialRow)}>
                  {METRICS.map((m) => <option key={String(m.key)} value={String(m.key)}>{m.label}{m.unit ? ` (${m.unit})` : ''}</option>)}
                </select>
              </label>
            </div>

            <div className="comparisonOptionsRow">
              <label className="inlineCheck">
                <input type="checkbox" checked={includeSuspicious} onChange={(e) => setIncludeSuspicious(e.target.checked)} />
                Include disrupted/retry attempts
              </label>
              <button
                type="button"
                className="generateButton"
                onClick={runComparison}
                disabled={loading || !comparePatients.length}
              >
                {loading ? <RefreshCw size={16} className="spin" /> : <Play size={16} />}
                {loading ? 'Computing…' : 'Generate trial comparison'}
              </button>
              {!comparePatients.length
                ? <span className="miniHint">Select at least one patient.</span>
                : <span className="miniHint">First run over many patients can take a while; results are cached after that.</span>}
            </div>

            {error ? <div className="errorBox">{error}</div> : null}

            {hasRun && lostSummary.length ? (
              <div className="patientChips">
                {lostSummary.map(({ patient, total, lost }) => (
                  <span key={patient} className={`chip ${lost > 0 ? 'active' : ''}`} style={{ cursor: 'default' }}>
                    {patient}: {lost}/{total} lost
                  </span>
                ))}
              </div>
            ) : null}

            <ChartCard
              title="Patient comparison"
              subtitle={hasRun ? `${metric.label} — mean per patient over ${activeRows.length}/${rows.length} checked trials · ${runContext} · bar label shows (trial count)` : 'Nothing generated yet.'}
            >
              {!hasRun ? (
                <div className="emptyState">Pick patients above and press “Generate trial comparison”.</div>
              ) : !rows.length ? (
                <div className="emptyState">No trials match these filters. Broaden the condition or path.</div>
              ) : !chart.length ? (
                <div className="emptyState">All trials are unchecked. Tick at least one row in the table below.</div>
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
              <section className="card tableCard">
                <div className="cardHeader">
                  <div>
                    <h2>Choose the trials to compare ({activeRows.length}/{rows.length} checked)</h2>
                    <p>Only checked trials feed the chart above. Each row is one exploration attempt paired with its trial's learning session.</p>
                  </div>
                </div>
                <div className="tableWrap">
                  <table>
                    <thead>
                      <tr>
                        <th>
                          <input
                            type="checkbox"
                            aria-label="Toggle all trials"
                            checked={activeKeys.length === rows.length}
                            onChange={(e) => setActiveKeys(e.target.checked ? rows.map(rowKey) : [])}
                          />
                        </th>
                        <th>Patient</th><th>Condition</th><th>Path</th><th>Attempt</th>
                        <th>Overlap</th><th>Turn dev.</th><th>Wrong turns</th>
                        <th>Stop dist.</th><th>Start dist.</th><th>Stops</th><th>Border</th><th>Got lost</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[...rows].sort((a, b) => `${a.patient}-${a.path_id}-${a.condition}-${a.attempt_number}`.localeCompare(`${b.patient}-${b.path_id}-${b.condition}-${b.attempt_number}`)).map((r) => {
                        const key = rowKey(r);
                        const active = activeKeys.includes(key);
                        return (
                          <tr key={key} className={active ? '' : 'rowExcluded'}>
                            <td>
                              <input
                                type="checkbox"
                                aria-label={`Include ${r.patient} ${r.condition} ${r.path_id} attempt ${r.attempt_number ?? '-'}`}
                                checked={active}
                                onChange={() => toggleRow(key)}
                              />
                            </td>
                            <td>{r.patient}</td>
                            <td>{r.condition_label}</td>
                            <td>{r.path_id}</td>
                            <td>{r.attempt_number ? `${r.attempt_number}/${r.total_attempts}` : '—'}</td>
                            <td>{r.overlap_pct?.toFixed(1) ?? '—'}{r.overlap_pct != null ? '%' : ''}</td>
                            <td>{r.mean_turn_deviation_deg?.toFixed(1) ?? '—'}{r.mean_turn_deviation_deg != null ? '°' : ''}</td>
                            <td>{r.wrong_turns_count ?? '—'}</td>
                            <td>{r.stop_position_distance_m?.toFixed(2) ?? '—'}</td>
                            <td>{r.start_position_distance_m?.toFixed(2) ?? '—'}</td>
                            <td>{r.stop_count ?? '—'}</td>
                            <td>{r.border_reached_count ?? '—'}</td>
                            <td>{r.got_lost ? <span className="warningBadge">lost</span> : '—'}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </section>
            ) : null}
          </div>
        ) : null}
      </section>
    </>
  );
}
