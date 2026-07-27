import { AlertTriangle, Compass, ShieldCheck } from 'lucide-react';
import type { SessionPayload } from '../types';

function fmtSeconds(t: number | null) {
  return t === null ? '?' : `${t.toFixed(1)} s`;
}

/**
 * Compact data-quality notification pills shown above the metric cards:
 * - IMU impacts: a stationary target sensor (O1–O3) with an acceleration spike
 *   was probably hit or kicked during the session.
 * - Orientation consistency: how well the IMU yaw matches the walking
 *   direction derived from the 2D trajectory.
 * Full detail is in the title tooltip rather than always-visible wrapped text,
 * so this stays a thin strip instead of a tall two-box banner.
 */
export function QualityIndicators({ payload }: { payload: SessionPayload }) {
  const imu = payload.imu_quality;
  const orientation = payload.orientation;
  if (!imu && !orientation) return null;

  const events = imu?.events ?? [];
  const hasImpacts = events.length > 0;
  const impactSummary = events
    .map((e) => `${e.tag_id} at ${fmtSeconds(e.t_s)} (peak ${e.peak_accel.toFixed(1)})`)
    .join(', ');
  const impactTitle = hasImpacts
    ? `Sudden acceleration on stationary target sensors — likely hit or kicked: ${impactSummary}.`
    : 'Acceleration on target sensors O1–O3 stayed near baseline for the whole session.';

  const consistency = orientation?.consistency ?? 'unknown';
  const orientationTone = consistency === 'good' ? 'ok' : consistency === 'fair' ? 'warn' : consistency === 'poor' ? 'bad' : 'muted';
  const offset = orientation?.median_offset_deg;
  const spread = orientation?.circular_std_deg;
  const orientationTitle = orientation?.note ?? 'No orientation data available.';

  return (
    <div className="qualityRow">
      <div className={`qualityPill ${hasImpacts ? 'bad' : 'ok'}`} title={impactTitle}>
        {hasImpacts ? <AlertTriangle size={15} /> : <ShieldCheck size={15} />}
        <span>{hasImpacts ? `${events.length} sensor impact${events.length > 1 ? 's' : ''} detected` : 'No sensor impacts'}</span>
      </div>

      <div className={`qualityPill ${orientationTone}`} title={orientationTitle}>
        <Compass size={15} />
        <span>
          IMU orientation: {consistency}
          {typeof offset === 'number' ? ` · offset ${offset.toFixed(0)}°` : ''}
          {typeof spread === 'number' ? ` · ±${spread.toFixed(0)}°` : ''}
        </span>
      </div>
    </div>
  );
}
