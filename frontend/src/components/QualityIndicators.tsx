import { AlertTriangle, Compass, ShieldCheck } from 'lucide-react';
import type { SessionPayload } from '../types';

function fmtSeconds(t: number | null) {
  return t === null ? '?' : `${t.toFixed(1)} s`;
}

/**
 * Data-quality banner shown above the metric cards:
 * - IMU impacts: a stationary target sensor (O1–O3) with an acceleration spike
 *   was probably hit or kicked during the session.
 * - Orientation consistency: how well the IMU yaw matches the walking
 *   direction derived from the 2D trajectory.
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

  const consistency = orientation?.consistency ?? 'unknown';
  const orientationTone = consistency === 'good' ? 'ok' : consistency === 'fair' ? 'warn' : consistency === 'poor' ? 'bad' : 'muted';
  const offset = orientation?.median_offset_deg;
  const spread = orientation?.circular_std_deg;

  return (
    <div className="qualityRow">
      <div className={`qualityCard ${hasImpacts ? 'bad' : 'ok'}`}>
        {hasImpacts ? <AlertTriangle size={18} /> : <ShieldCheck size={18} />}
        <div>
          <strong>{hasImpacts ? `${events.length} sensor impact${events.length > 1 ? 's' : ''} detected` : 'No sensor impacts'}</strong>
          <span>
            {hasImpacts
              ? `Sudden acceleration on stationary target sensors — likely hit or kicked: ${impactSummary}.`
              : 'Acceleration on target sensors O1–O3 stayed near baseline for the whole session.'}
          </span>
        </div>
      </div>

      <div className={`qualityCard ${orientationTone}`}>
        <Compass size={18} />
        <div>
          <strong>
            IMU orientation vs trajectory: {consistency}
            {typeof offset === 'number' ? ` · mounting offset ${offset.toFixed(0)}°` : ''}
            {typeof spread === 'number' ? ` · spread ±${spread.toFixed(0)}°` : ''}
          </strong>
          <span>{orientation?.note ?? 'No orientation data available.'}</span>
        </div>
      </div>
    </div>
  );
}
