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

function EmptyChart({ message = 'Nessun dato disponibile per questo grafico.' }: { message?: string }) {
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

function chartMouseMove(_onCursorTime?: (time: number) => void) {
  // Non aggiorniamo il playback dal semplice hover sui grafici: con serie filtrate
  // al tempo corrente Recharts non può selezionare punti futuri e può far saltare
  // il cursore all'indietro. Il controllo avanti/indietro avviene dalla timeline globale.
  return undefined;
}

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
  const visibleData = useMemo(() => data.filter((row) => Number(row.t_s) <= t), [data, t]);
  const thresholdLines = thresholds(payload.config.distance_cfg);
  const yValues = data.flatMap((row) => targets.map((target) => row[target])).concat(thresholdLines.map(([, value]) => value));
  const legendItems = targets.map((target, idx) => ({ name: `P1-${target}`, color: colors[idx % colors.length] }));

  return (
    <ChartCard title="Distanze P1–target" subtitle="Il tracciato si riempie fino al tempo selezionato dal playback globale.">
      {!data.length ? <EmptyChart /> : (
        <>
          <ChartScaleControls value={scaleMode} onChange={setScaleMode} />
          <ChartFrame height={330}>{(width, height) => (
            <LineChart width={width} height={height} data={visibleData} margin={chartMargin} onMouseMove={chartMouseMove(onCursorTime)}>
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
                  key={target}
                  type="linear"
                  dataKey={target}
                  dot={false}
                  activeDot={{ r: 4 }}
                  stroke={colors[idx % colors.length]}
                  strokeWidth={2}
                  name={`P1-${target}`}
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
  const visibleLineData = lineData.filter((row) => row.t_s <= t);
  const visibleFeedbackData = feedbackData.filter((row) => row.t_s <= t);
  const thresholdLines = thresholds(payload.config.distance_cfg);
  const yValues = lineData.map((row) => row.closest_distance).concat(feedbackData.map((row) => row.feedback_distance as number), thresholdLines.map(([, value]) => value));

  return (
    <ChartCard title="Closest target + feedback event distance" subtitle="Linea closest target; marker degli eventi feedback_changed fino al tempo corrente.">
      {!lineData.length && !feedbackData.length ? <EmptyChart /> : (
        <>
          <ChartScaleControls value={scaleMode} onChange={setScaleMode} />
          <ChartFrame height={330}>{(width, height) => (
            <ComposedChart width={width} height={height} data={visibleLineData} margin={chartMargin} onMouseMove={chartMouseMove(onCursorTime)}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="t_s" unit="s" type="number" domain={xDomain(d)} allowDataOverflow />
              <YAxis domain={yDomain(yValues, scaleMode)} />
              <Tooltip {...tooltipProps} formatter={fmt} cursor={{ stroke: '#98a2b3', strokeWidth: 1 }} />
              <ReferenceLine x={t} stroke="#d92d20" strokeWidth={1.5} strokeDasharray="5 4" label="now" />
              {thresholdLines.map(([label, value]) => (
                <ReferenceLine key={label} y={value} label={label} strokeDasharray="4 4" />
              ))}
              {lineData.length ? (
                <Line type="linear" dataKey="closest_distance" dot={false} activeDot={{ r: 4 }} name="closest distance" stroke={colors[0]} strokeWidth={2} isAnimationActive={false} />
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
  const visibleData = data.filter((row) => row.t_s <= t);
  const yValues = data.map((row) => row.intensity);
  return (
    <ChartCard title="Feedback intensity over time" subtitle="Step chart degli eventi feedback_changed, riempito dal playback.">
      {!data.length ? <EmptyChart message="Nessun evento feedback_changed con intensity per questa sessione." /> : (
        <>
          <ChartScaleControls value={scaleMode} onChange={setScaleMode} />
          <ChartFrame height={300}>{(width, height) => (
            <LineChart width={width} height={height} data={visibleData} margin={chartMargin} onMouseMove={chartMouseMove(onCursorTime)}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="t_s" unit="s" type="number" domain={xDomain(d)} allowDataOverflow />
              <YAxis domain={yDomain(yValues, scaleMode)} />
              <Tooltip {...tooltipProps} formatter={fmt} cursor={{ stroke: '#98a2b3', strokeWidth: 1 }} />
              <ReferenceLine x={t} stroke="#d92d20" strokeWidth={1.5} strokeDasharray="5 4" label="now" />
              <Line type="stepAfter" dataKey="intensity" name="intensity" dot={false} activeDot={{ r: 4 }} stroke={colors[0]} strokeWidth={2} isAnimationActive={false} />
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
    <ChartCard title="Intensity vs distance" subtitle="Punti feedback generati fino al tempo corrente del playback.">
      {!data.length ? <EmptyChart message="Nessun evento feedback con distance + intensity." /> : (
        <>
          <ChartScaleControls value={scaleMode} onChange={setScaleMode} label="Scala X/Y" />
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

export function SpeedChart({ payload, playbackTime, duration, onCursorTime }: TimedChartProps) {
  const [scaleMode, setScaleMode] = useState<ScaleMode>('tight');
  const data = payload.speed.filter((p) => isFiniteNumber(p.t_s) && (isFiniteNumber(p.speed_m_s) || isFiniteNumber(p.speed_m_s_smooth)));
  const d = duration ?? chartDuration(payload, data);
  const t = clampTime(playbackTime, d);
  const visibleData = data.filter((row) => row.t_s <= t);
  const yValues = data.flatMap((row) => [row.speed_m_s, row.speed_m_s_smooth]);
  return (
    <ChartCard title="P1 speed" subtitle="Velocità raw e mediana rolling, riempite nel tempo dal playback.">
      {!data.length ? <EmptyChart message="Nessun dato di velocità valido per P1." /> : (
        <>
          <ChartScaleControls value={scaleMode} onChange={setScaleMode} />
          <ChartFrame height={300}>{(width, height) => (
            <LineChart width={width} height={height} data={visibleData} margin={chartMargin} onMouseMove={chartMouseMove(onCursorTime)}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="t_s" unit="s" type="number" domain={xDomain(d)} allowDataOverflow />
              <YAxis domain={yDomain(yValues, scaleMode)} />
              <Tooltip {...tooltipProps} formatter={fmt} cursor={{ stroke: '#98a2b3', strokeWidth: 1 }} />
              <ReferenceLine x={t} stroke="#d92d20" strokeWidth={1.5} strokeDasharray="5 4" label="now" />
              <Line type="linear" dataKey="speed_m_s" name="raw speed" dot={false} activeDot={false} stroke={colors[0]} strokeOpacity={0.35} isAnimationActive={false} connectNulls />
              <Line type="linear" dataKey="speed_m_s_smooth" name="smooth median" dot={false} activeDot={{ r: 4 }} stroke={colors[1]} strokeWidth={2} isAnimationActive={false} connectNulls />
            </LineChart>
          )}</ChartFrame>
          <div className="chartFooterRow"><CustomLegend items={[{ name: 'raw speed', color: colors[0] }, { name: 'smooth median', color: colors[1] }]} /><TimeBadge time={t} duration={d} /></div>
        </>
      )}
    </ChartCard>
  );
}
