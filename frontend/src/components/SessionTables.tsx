import type { SessionPayload, SessionRow } from '../types';

export function SessionStatusTable({ sessions }: { sessions: SessionRow[] }) {
  const problematic = sessions.filter((s) => s.is_interrupt || s.is_suspicious_short);
  if (!problematic.length) return null;
  return (
    <section className="card tableCard span2">
      <div className="cardHeader">
        <div>
          <h2>Sessioni interrotte o sospette</h2>
          <p>Flag calcolati da last_state, durata e numero campioni.</p>
        </div>
      </div>
      <div className="tableWrap compact">
        <table>
          <thead><tr><th>Patient</th><th>Condition</th><th>Phase</th><th>Path</th><th>Duration</th><th>Samples</th><th>Warning</th></tr></thead>
          <tbody>
            {problematic.map((s) => (
              <tr key={s.session_id}>
                <td>{s.patient}</td><td>{s.condition_label}</td><td>{s.phase}</td><td>{s.path_id}</td>
                <td>{s.duration_s?.toFixed(1) ?? '—'}</td><td>{s.n_raw ?? '—'}</td><td>{s.warning}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function ProfilesTable({ payload }: { payload: SessionPayload }) {
  if (!payload.profiles.length) return null;
  return (
    <section className="card tableCard span2">
      <div className="cardHeader">
        <div>
          <h2>Config feedback / proximity profiles</h2>
          <p>Range intensità/frequenza collegati alla condition selezionata.</p>
        </div>
      </div>
      <div className="tableWrap compact">
        <table>
          <thead><tr>{Object.keys(payload.profiles[0]).map((k) => <th key={k}>{k}</th>)}</tr></thead>
          <tbody>
            {payload.profiles.map((row, idx) => (
              <tr key={idx}>{Object.keys(payload.profiles[0]).map((k) => <td key={k}>{String(row[k] ?? '—')}</td>)}</tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
