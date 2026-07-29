import type { SessionPayload, SessionRow } from '../types';

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
  if (!session) return null;
  const summary = payload?.summary ?? {};
  const config = payload?.config;
  const distanceCfg = summary.distance_cfg as Record<string, any> | undefined;
  const targets: string[] | undefined = config?.target_ids ?? summary.target_ids;

  const items: Array<[string, string]> = [
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
      distanceCfg ? `${distanceCfg.min_activation_distance ?? '?'}–${distanceCfg.max_activation_distance ?? '?'} m` : '—',
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
