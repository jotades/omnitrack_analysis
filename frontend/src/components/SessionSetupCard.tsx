import { useState, type ReactNode } from 'react';
import { saveActivationDistance } from '../api';
import type { SessionPayload, SessionRow } from '../types';

/** Activation distance is shown as plain text everywhere except while this
 * row is being edited — saving writes straight into the session's raw JSON
 * file (see save_activation_distance on the backend) and reports the new
 * values back via onSaved so the card updates without a full refetch. */
function ActivationDistanceEditor({
  sessionId, distanceCfg, onSaved,
}: {
  sessionId: number;
  distanceCfg: Record<string, any> | undefined;
  onSaved: (min: number, max: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [minStr, setMinStr] = useState('');
  const [maxStr, setMaxStr] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const display = distanceCfg
    ? `${distanceCfg.min_activation_distance ?? '?'}–${distanceCfg.max_activation_distance ?? '?'} m`
    : '—';

  if (!editing) {
    return (
      <button
        type="button"
        className="linkButton"
        onClick={() => {
          setMinStr(String(distanceCfg?.min_activation_distance ?? ''));
          setMaxStr(String(distanceCfg?.max_activation_distance ?? ''));
          setError(null);
          setEditing(true);
        }}
      >
        {display}
      </button>
    );
  }

  async function persist() {
    const min = Number(minStr);
    const max = Number(maxStr);
    if (!Number.isFinite(min) || !Number.isFinite(max)) return;
    setSaving(true);
    setError(null);
    try {
      await saveActivationDistance({ sessionId, minActivationDistance: min, maxActivationDistance: max });
      onSaved(min, max);
      setEditing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <span className="activationDistanceEditor">
      <input type="number" step="0.01" value={minStr} onChange={(e) => setMinStr(e.target.value)} />
      <input type="number" step="0.01" value={maxStr} onChange={(e) => setMaxStr(e.target.value)} />
      <button type="button" onClick={persist} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
      <button type="button" onClick={() => setEditing(false)} disabled={saving}>Cancel</button>
      {error ? <span className="miniSavingHint miniSavingError">{error}</span> : null}
    </span>
  );
}

function roomDims(anchors: Array<Record<string, any>> | undefined): string | null {
  if (!anchors?.length) return null;
  const xs: number[] = [];
  const ys: number[] = [];
  for (const a of anchors) {
    const coords = a?.coords;
    if (Array.isArray(coords) && typeof coords[0] === 'number' && typeof coords[1] === 'number') {
      xs.push(coords[0]);
      ys.push(coords[1]);
    }
  }
  if (!xs.length || !ys.length) return null;
  const w = Math.max(...xs) - Math.min(...xs);
  const h = Math.max(...ys) - Math.min(...ys);
  return `${w.toFixed(0)} m × ${h.toFixed(0)} m`;
}

/** What this one session's setup actually was — condition/path/phase plus
 * the feedback-delivery configuration — shown once per selected session, not
 * per patient (that combined view now lives in General statistics). */
export function SessionSetupCard({ session, payload }: { session: SessionRow | null; payload: SessionPayload | null }) {
  // Overrides what's shown right after a save, without waiting on a full
  // session refetch — cleared whenever the selected session changes.
  const [override, setOverride] = useState<{ sessionId: number; min: number; max: number } | null>(null);
  if (!session) return null;
  const summary = payload?.summary ?? {};
  const config = payload?.config;
  const baseDistanceCfg = summary.distance_cfg as Record<string, any> | undefined;
  const distanceCfg = override && override.sessionId === session.session_id
    ? { ...baseDistanceCfg, min_activation_distance: override.min, max_activation_distance: override.max }
    : baseDistanceCfg;
  const targets: string[] | undefined = config?.target_ids ?? summary.target_ids;

  const items: Array<[string, ReactNode]> = [
    ['Patient', session.patient],
    ['Condition', session.condition_label || session.condition],
    ['Path', session.path_id],
    ['Phase', session.phase],
    ['Seeker', config?.seeker_id ?? summary.seeker_id ?? '—'],
    ['Targets', targets?.length ? targets.join(', ') : '—'],
    ['Room size', roomDims(config?.anchors) ?? '—'],
    ['Feedback delivery', summary.delivery_target ?? '—'],
    ['Selection mode', summary.selection_mode ?? '—'],
    [
      'Activation distance',
      <ActivationDistanceEditor
        sessionId={session.session_id}
        distanceCfg={distanceCfg}
        onSaved={(min, max) => setOverride({ sessionId: session.session_id, min, max })}
      />,
    ],
    ['Start time', session.start_time ?? '—'],
    ['Status', session.warning || session.status],
  ];

  return (
    <section className="card">
      <div className="cardHeader">
        <div>
          <h2>Session setup</h2>
          <p>Configuration of the currently selected session.</p>
        </div>
      </div>
      <div className="sessionSetupBody">
        <div className="patientHeaderStats">
          {items.map(([label, value]) => (
            <div key={label} className="patientHeaderStat"><span>{label}</span><strong>{value}</strong></div>
          ))}
        </div>
      </div>
    </section>
  );
}
