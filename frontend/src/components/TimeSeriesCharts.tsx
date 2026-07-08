import { useMemo, useState } from 'react';
import {
  CartesianGrid,
  ComposedChart,
  Line,
  LineChart,
  ReferenceLine,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { ClosestPoint, DistancePoint, FeedbackPoint, SessionPayload } from '../types';
import { ChartCard } from './ChartCard';
import { ChartFrame } from './ChartFrame';
import { ChartScaleControls, ScaleMode, yDomain } from './ChartScaleControls';

const colors = ['#3b5bfd', '#17b26a', '#f79009', '#7a5af8', '#06aed4', '#d92d20'];

interface TimedChartProps {
  payload: SessionPayload;
  playbackTime?: number | null;
  duration?: number;
  onCursorTime?: (time: number) => void;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function EmptyChart({ message = 'No data available for this chart.' }: { message?: string }) {
  return <div className="emptyState chartEmpty">{message}</div>;
}

function clampTime(value: number | null | undefined, duration: number) {
  if (!isFiniteNumber(value)) return duration;
  return Math.max(0, Math.min(duration, value));
}

function chartDuration(payload: SessionPayload, fallbackRows: Array<{ t_s?: number }>) {
  const fromMetrics = payload.metrics.duration_s;
  if (isFiniteNumber(fromMetrics) && fromMetrics > 0) return fromMetrics;
  const max = Math.max(0, ...fallbackRows.map((r) => r.t_s).filter(isFiniteNumber));
  return Number.isFinite(max) ? max : 0;
}

function pivotDistances(rows: DistancePoint[]) {
  const cleanRows = rows.filter((r) => isFiniteNumber(r.t_s) && isFiniteNumber(r.distance) && Boolean(r.target_id));
  const map = new Map<number, Record<string, number | string>>();
  const targets = Array.from(new Set(cleanRows.map((r) => r.target_id))).sort();
  for (const r of cleanRows) {
    const key = Number(r.t_s.toFixed(3));
    const obj = map.get(key) ?? { t_s: key };
    obj[r.target_id] = r.distance;
    map.set(key, obj);
  }
  return { data: Array.from(map.values()).sort((a, b) => Number(a.t_s) - Number(b.t_s)), targets };
}

function thresholds(cfg: Record<string, any>) {
  return [
    ['threshold', Number(cfg?.threshold)],
    ['min activation', Number(cfg?.min_activation_distance)],
    ['max activation', Number(cfg?.max_activation_distance)],
  ].filter(([, value]) => Number.isFinite(value)) as [string, number][];
}

function fmt(n: unknown): string {
  return typeof n === 'number' && Number.isFinite(n) ? n.toFixed(3) : String(n ?? '—');
}

function CustomLegend({ items }: { items: Array<{ name: string; color: string }> }) {
  if (!items.length) return null;
  return (
    <div className="customLegend">
      {items.map((item) => <span key={item.name}><i style={{ background: item.color }} />{item.name}</span>)}
    </div>
  );
}

function TimeBadge({ time, duration }: { time: number; duration: number }) {
  return <span className="timeBadge">t = {time.toFixed(2)} s / {duration.toFixed(2)} s</span>;
}

function chartMouseMove(onCursorTime?: (time: number) => void) {
  if (!onCursorTime) return undefined;
  return (state: { isTooltipActive?: boolean; activeLabel?: unknown } | null) => {
    const label = Number(state?.activeLabel);
    if (state?.isTooltipActive && Number.isFinite(label)) onCursorTime(label);
  };
}

// Each series is duplicated into a `<key>__past` key that only has values up to
// the current time: the full ghost line stays hoverable across the whole X axis
// while the solid line fills up to t.
function withPastSeries<T extends { t_s?: number | string }>(rows: T[], keys: string[], t: number) {
  return rows.map((row) => {
    const out: Record<string, unknown> = { ...row };
    const rowT = Number(row.t_s);
    for (const key of keys) out[`${key}__past`] = rowT <= t ? (out[key] ?? null) : null;
    return out;
  });
}

const ghostStroke = { strokeOpacity: 0.18, strokeWidth: 1.5 } as const;

function xDomain(duration: number): [number, number] {
  return [0, Math.max(0.01, duration)];
}

const chartMargin = { top: 12, right: 22, bottom: 24, left: 4 };
const tooltipProps = {
  animationDuration: 0,
  isAnimationActive: false,
  wrapperStyle: { outline: 'none', zIndex: 3 },
} as const;

export function DistanceChart({ payload, playbackTime, duration, onCursorTime }: TimedChartProps) {
  const [scaleMode, setScaleMode] = useState<ScaleMode>('tight');
  const { data, targets } = useMemo(() => pivotDistances(payload.distances), [payload.distances]);
  const d = duration ?? chartDuration(payload, payload.distances);
  const t = clampTime(playbackTime, d);
  const chartData = useMemo(() => withPastSeries(data, targets, t), [data, targets, t]);
  const thresholdLines = thresholds(payload.config.distance_cfg);
  const yValues = data.flatMap((row) => targets.map((target) => row[target])).concat(thresholdLines.map(([, value]) => value));
  const legendItems = targets.map((target, idx) => ({ name: `P1-${target}`, color: colors[idx % colors.length] }));

  return (
    <ChartCard title="P1–target distances" subtitle="Hover the chart to move the time cursor: the solid part fills up to the hovered point, in sync with every chart.">
      {!data.length ? <EmptyChart /> : (
        <>
          <ChartScaleControls value={scaleMode} onChange={setScaleMode} />
          <ChartFrame height={330}>{(width, height) => (
            <LineChart width={width} height={height} data={chartData} margin={chartMargin} onMouseMove={chartMouseMove(onCursorTime)}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="t_s" unit="s" type="number" domain={xDomain(d)} allowDataOverflow />
              <YAxis domain={yDomain(yValues, scaleMode)} />
              <Tooltip {...tooltipProps} formatter={fmt} cursor={{ stroke: '#98a2b3', strokeWidth: 1 }} />
              <ReferenceLine x={t} stroke="#d92d20" strokeWidth={1.5} strokeDasharray="5 4" label="now" />
              {thresholdLines.map(([label, value]) => (
                <ReferenceLine key={label} y={value} label={label} strokeDasharray="4 4" />
              ))}
              {targets.map((target, idx) => (
                <Line
                  key={`${target}-ghost`}
                  type="linear"
                  dataKey={target}
                  dot={false}
                  activeDot={{ r: 4 }}
                  stroke={colors[idx % colors.length]}
                  {...ghostStroke}
                  name={`P1-${target}`}
                  isAnimationActive={false}
                  connectNulls
                />
              ))}
              {targets.map((target, idx) => (
                <Line
                  key={target}
                  type="linear"
                  dataKey={`${target}__past`}
                  dot={false}
                  activeDot={false}
                  stroke={colors[idx % colors.length]}
                  strokeWidth={2}
                  tooltipType="none"
                  isAnimationActive={false}
                  connectNulls
                />
              ))}
            </LineChart>
          )}</ChartFrame>
          <div className="chartFooterRow"><CustomLegend items={legendItems} /><TimeBadge time={t} duration={d} /></div>
        </>
      )}
    </ChartCard>
  );
}

export function ClosestAndFeedbackChart({ payload, playbackTime, duration, onCursorTime }: TimedChartProps) {
  const [scaleMode, setScaleMode] = useState<ScaleMode>('tight');
  const lineData = payload.closest
    .filter((p: ClosestPoint) => isFiniteNumber(p.t_s) && isFiniteNumber(p.closest_distance))
    .map((p: ClosestPoint) => ({ t_s: p.t_s, closest_distance: p.closest_distance, closest_target_id: p.closest_target_id }));
  const feedbackData = payload.feedback
    .filter((f: FeedbackPoint) => isFiniteNumber(f.t_s) && isFiniteNumber(f.distance))
    .map((f) => ({ t_s: f.t_s, feedback_distance: f.distance, target_id: f.target_id }));
  const d = duration ?? chartDuration(payload, [...lineData, ...feedbackData]);
  const t = clampTime(playbackTime, d);
  const chartData = withPastSeries(lineData, ['closest_distance'], t);
  const visibleFeedbackData = feedbackData.filter((row) => row.t_s <= t);
  const thresholdLines = thresholds(payload.config.distance_cfg);
  const yValues = lineData.map((row) => row.closest_distance).concat(feedbackData.map((row) => row.feedback_distance as number), thresholdLines.map(([, value]) => value));

  return (
    <ChartCard title="Closest target + feedback event distance" subtitle="Closest-target line; feedback_changed event markers up to the current time.">
      {!lineData.length && !feedbackData.length ? <EmptyChart /> : (
        <>
          <ChartScaleControls value={scaleMode} onChange={setScaleMode} />
          <ChartFrame height={330}>{(width, height) => (
            <ComposedChart width={width} height={height} data={chartData} margin={chartMargin} onMouseMove={chartMouseMove(onCursorTime)}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="t_s" unit="s" type="number" domain={xDomain(d)} allowDataOverflow />
              <YAxis domain={yDomain(yValues, scaleMode)} />
              <Tooltip {...tooltipProps} formatter={fmt} cursor={{ stroke: '#98a2b3', strokeWidth: 1 }} />
              <ReferenceLine x={t} stroke="#d92d20" strokeWidth={1.5} strokeDasharray="5 4" label="now" />
              {thresholdLines.map(([label, value]) => (
                <ReferenceLine key={label} y={value} label={label} strokeDasharray="4 4" />
              ))}
              {lineData.length ? (
                <Line type="linear" dataKey="closest_distance" dot={false} activeDot={{ r: 4 }} name="closest distance" stroke={colors[0]} {...ghostStroke} isAnimationActive={false} />
              ) : null}
              {lineData.length ? (
                <Line type="linear" dataKey="closest_distance__past" dot={false} activeDot={false} tooltipType="none" stroke={colors[0]} strokeWidth={2} isAnimationActive={false} />
              ) : null}
              {feedbackData.length ? (
                <Scatter name="feedback distance (full)" data={feedbackData} dataKey="feedback_distance" fill={colors[1]} fillOpacity={0.2} tooltipType="none" isAnimationActive={false} />
              ) : null}
              {feedbackData.length ? (
                <Scatter name="feedback distance" data={visibleFeedbackData} dataKey="feedback_distance" fill={colors[1]} isAnimationActive={false} />
              ) : null}
            </ComposedChart>
          )}</ChartFrame>
          <div className="chartFooterRow"><CustomLegend items={[{ name: 'closest distance', color: colors[0] }, { name: 'feedback distance', color: colors[1] }]} /><TimeBadge time={t} duration={d} /></div>
        </>
      )}
    </ChartCard>
  );
}

export function FeedbackIntensityChart({ payload, playbackTime, duration, onCursorTime }: TimedChartProps) {
  const [scaleMode, setScaleMode] = useState<ScaleMode>('tight');
  const data = payload.feedback.filter((f) => isFiniteNumber(f.t_s) && isFiniteNumber(f.intensity));
  const d = duration ?? chartDuration(payload, data);
  const t = clampTime(playbackTime, d);
  const chartData = withPastSeries(data, ['intensity'], t);
  const yValues = data.map((row) => row.intensity);
  return (
    <ChartCard title="Feedback intensity over time" subtitle="Step chart of feedback_changed events, filled by the time cursor.">
      {!data.length ? <EmptyChart message="No feedback_changed event with intensity for this session." /> : (
        <>
          <ChartScaleControls value={scaleMode} onChange={setScaleMode} />
          <ChartFrame height={300}>{(width, height) => (
            <LineChart width={width} height={height} data={chartData} margin={chartMargin} onMouseMove={chartMouseMove(onCursorTime)}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="t_s" unit="s" type="number" domain={xDomain(d)} allowDataOverflow />
              <YAxis domain={yDomain(yValues, scaleMode)} />
              <Tooltip {...tooltipProps} formatter={fmt} cursor={{ stroke: '#98a2b3', strokeWidth: 1 }} />
              <ReferenceLine x={t} stroke="#d92d20" strokeWidth={1.5} strokeDasharray="5 4" label="now" />
              <Line type="stepAfter" dataKey="intensity" name="intensity" dot={false} activeDot={{ r: 4 }} stroke={colors[0]} {...ghostStroke} isAnimationActive={false} />
              <Line type="stepAfter" dataKey="intensity__past" dot={false} activeDot={false} tooltipType="none" stroke={colors[0]} strokeWidth={2} isAnimationActive={false} />
            </LineChart>
          )}</ChartFrame>
          <div className="chartFooterRow"><CustomLegend items={[{ name: 'intensity', color: colors[0] }]} /><TimeBadge time={t} duration={d} /></div>
        </>
      )}
    </ChartCard>
  );
}

export function IntensityDistanceChart({ payload, playbackTime, duration }: TimedChartProps) {
  const [scaleMode, setScaleMode] = useState<ScaleMode>('tight');
  const data = payload.feedback.filter((f) => isFiniteNumber(f.intensity) && isFiniteNumber(f.distance) && isFiniteNumber(f.t_s));
  const d = duration ?? chartDuration(payload, data);
  const t = clampTime(playbackTime, d);
  const visibleData = data.filter((row) => row.t_s <= t);
  const yValues = data.map((row) => row.intensity);
  const xValues = data.map((row) => row.distance).filter(isFiniteNumber);
  const xDom = xValues.length ? yDomain(xValues, scaleMode) : ['auto', 'auto'];
  return (
    <ChartCard title="Intensity vs distance" subtitle="Feedback points generated up to the current cursor time.">
      {!data.length ? <EmptyChart message="No feedback event with distance + intensity." /> : (
        <>
          <ChartScaleControls value={scaleMode} onChange={setScaleMode} label="X/Y scale" />
          <ChartFrame height={300}>{(width, height) => (
            <ScatterChart width={width} height={height} margin={chartMargin}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis type="number" dataKey="distance" name="distance" unit=" m" domain={xDom} />
              <YAxis type="number" dataKey="intensity" name="intensity" domain={yDomain(yValues, scaleMode)} />
              <Tooltip {...tooltipProps} cursor={{ strokeDasharray: '3 3' }} formatter={fmt} />
              <Scatter name="feedback events" data={visibleData} fill={colors[0]} isAnimationActive={false} />
            </ScatterChart>
          )}</ChartFrame>
          <div className="chartFooterRow"><CustomLegend items={[{ name: 'feedback events', color: colors[0] }]} /><TimeBadge time={t} duration={d} /></div>
        </>
      )}
    </ChartCard>
  );
}

const angleColors: Record<string, string> = {
  roll_deg: '#d92d20', pitch_deg: '#17b26a', yaw_deg: '#3b5bfd',
  qx: '#d92d20', qy: '#17b26a', qz: '#3b5bfd', qw: '#7a5af8',
};

function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

type OrientationChartMode = 'angles' | 'quaternion';

export function OrientationAnglesChart({ payload, playbackTime, duration, onCursorTime }: TimedChartProps) {
  const [scaleMode, setScaleMode] = useState<ScaleMode>('tight');
  const [mode, setMode] = useState<OrientationChartMode>('angles');
  const [showYaw, setShowYaw] = useState(true);
  const seekerId = payload.config.seeker_id;
  const data = useMemo(
    () => payload.tracking
      .filter((p) => p.tag_id === seekerId && isFiniteNumber(p.t_s)
        && (isFiniteNumber(p.roll_deg) || isFiniteNumber(p.pitch_deg) || isFiniteNumber(p.yaw_deg)))
      .map((p) => ({
        t_s: p.t_s,
        roll_deg: p.roll_deg, pitch_deg: p.pitch_deg, yaw_deg: p.yaw_deg,
        qx: p.qx, qy: p.qy, qz: p.qz, qw: p.qw,
      }))
      .sort((a, b) => a.t_s - b.t_s),
    [payload.tracking, seekerId],
  );
  const d = duration ?? chartDuration(payload, data);
  const t = clampTime(playbackTime, d);
  const keys = mode === 'quaternion'
    ? ['qx', 'qy', 'qz', 'qw']
    : (showYaw ? ['roll_deg', 'pitch_deg', 'yaw_deg'] : ['roll_deg', 'pitch_deg']);
  const chartData = useMemo(() => withPastSeries(data, keys, t), [data, keys, t]);
  const yValues = data.flatMap((row) => keys.map((k) => row[k as keyof typeof row])).filter(isFiniteNumber);

  const medRoll = median(data.map((r) => r.roll_deg).filter(isFiniteNumber));
  const medPitch = median(data.map((r) => r.pitch_deg).filter(isFiniteNumber));
  const names: Record<string, string> = {
    roll_deg: 'roll (X)', pitch_deg: 'pitch (Y)', yaw_deg: 'yaw (Z)',
    qx: 'qx', qy: 'qy', qz: 'qz', qw: 'qw',
  };

  return (
    <ChartCard
      title="IMU orientation over time"
      subtitle="Roll/pitch near 0° and flat = device held level; a constant offset = held tilted at that angle; noisy lines = unstable grip. Yaw is the heading (it turns with the walk)."
    >
      {!data.length ? <EmptyChart message="No IMU orientation data for the seeker." /> : (
        <>
          <div className="chartOptionsRow">
            <ChartScaleControls value={scaleMode} onChange={setScaleMode} />
            <div className="chartModeSwitch" role="tablist" aria-label="Orientation representation">
              <button type="button" className={mode === 'angles' ? 'active' : ''} onClick={() => setMode('angles')}>x, y, z angles</button>
              <button type="button" className={mode === 'quaternion' ? 'active' : ''} onClick={() => setMode('quaternion')}>quaternion</button>
            </div>
            {mode === 'angles' ? (
              <label className="chartInlineToggle">
                <input type="checkbox" checked={showYaw} onChange={(e) => setShowYaw(e.target.checked)} />
                show yaw
              </label>
            ) : null}
          </div>
          <ChartFrame height={300}>{(width, height) => (
            <LineChart width={width} height={height} data={chartData} margin={chartMargin} onMouseMove={chartMouseMove(onCursorTime)}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="t_s" unit="s" type="number" domain={xDomain(d)} allowDataOverflow />
              <YAxis domain={yDomain(yValues, scaleMode)} unit={mode === 'angles' ? '°' : undefined} />
              <Tooltip {...tooltipProps} formatter={fmt} cursor={{ stroke: '#98a2b3', strokeWidth: 1 }} />
              <ReferenceLine y={0} stroke="#98a2b3" strokeDasharray="4 4" />
              <ReferenceLine x={t} stroke="#d92d20" strokeWidth={1.5} strokeDasharray="5 4" label="now" />
              {keys.map((key) => (
                <Line key={`${key}-ghost`} type="linear" dataKey={key} name={names[key]} dot={false} activeDot={{ r: 4 }}
                  stroke={angleColors[key]} {...ghostStroke} isAnimationActive={false} />
              ))}
              {keys.map((key) => (
                <Line key={key} type="linear" dataKey={`${key}__past`} dot={false} activeDot={false} tooltipType="none"
                  stroke={angleColors[key]} strokeWidth={2} isAnimationActive={false} />
              ))}
            </LineChart>
          )}</ChartFrame>
          <div className="chartFooterRow">
            <CustomLegend items={keys.map((key) => ({ name: names[key], color: angleColors[key] }))} />
            {mode === 'angles' ? (
              <span className="timeBadge">
                median roll {medRoll !== null ? `${medRoll.toFixed(0)}°` : '—'} · median pitch {medPitch !== null ? `${medPitch.toFixed(0)}°` : '—'}
              </span>
            ) : null}
            <TimeBadge time={t} duration={d} />
          </div>
        </>
      )}
    </ChartCard>
  );
}

export function SpeedChart({ payload, playbackTime, duration, onCursorTime }: TimedChartProps) {
  const [scaleMode, setScaleMode] = useState<ScaleMode>('tight');
  const data = payload.speed.filter((p) => isFiniteNumber(p.t_s) && (isFiniteNumber(p.speed_m_s) || isFiniteNumber(p.speed_m_s_smooth)));
  const d = duration ?? chartDuration(payload, data);
  const t = clampTime(playbackTime, d);
  const chartData = withPastSeries(data, ['speed_m_s', 'speed_m_s_smooth'], t);
  const yValues = data.flatMap((row) => [row.speed_m_s, row.speed_m_s_smooth]);
  return (
    <ChartCard title="P1 speed" subtitle="Raw speed and rolling median, filled over time by the cursor.">
      {!data.length ? <EmptyChart message="No valid speed data for P1." /> : (
        <>
          <ChartScaleControls value={scaleMode} onChange={setScaleMode} />
          <ChartFrame height={300}>{(width, height) => (
            <LineChart width={width} height={height} data={chartData} margin={chartMargin} onMouseMove={chartMouseMove(onCursorTime)}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="t_s" unit="s" type="number" domain={xDomain(d)} allowDataOverflow />
              <YAxis domain={yDomain(yValues, scaleMode)} />
              <Tooltip {...tooltipProps} formatter={fmt} cursor={{ stroke: '#98a2b3', strokeWidth: 1 }} />
              <ReferenceLine x={t} stroke="#d92d20" strokeWidth={1.5} strokeDasharray="5 4" label="now" />
              <Line type="linear" dataKey="speed_m_s" name="raw speed" dot={false} activeDot={false} stroke={colors[0]} strokeOpacity={0.12} isAnimationActive={false} connectNulls />
              <Line type="linear" dataKey="speed_m_s_smooth" name="smooth median" dot={false} activeDot={{ r: 4 }} stroke={colors[1]} {...ghostStroke} isAnimationActive={false} connectNulls />
              <Line type="linear" dataKey="speed_m_s__past" dot={false} activeDot={false} tooltipType="none" stroke={colors[0]} strokeOpacity={0.35} isAnimationActive={false} connectNulls />
              <Line type="linear" dataKey="speed_m_s_smooth__past" dot={false} activeDot={false} tooltipType="none" stroke={colors[1]} strokeWidth={2} isAnimationActive={false} connectNulls />
            </LineChart>
          )}</ChartFrame>
          <div className="chartFooterRow"><CustomLegend items={[{ name: 'raw speed', color: colors[0] }, { name: 'smooth median', color: colors[1] }]} /><TimeBadge time={t} duration={d} /></div>
        </>
      )}
    </ChartCard>
  );
}
