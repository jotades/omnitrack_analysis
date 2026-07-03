import { useState } from 'react';
import type { SessionRow } from '../types';
import type { AnalysisMode } from '../App';

interface Props {
  sessions: SessionRow[];
  mode: AnalysisMode;
  selectedPatient: string;
  selectedCondition: string;
  selectedPhase: string;
  selectedPath: string;
  selectedSessionId: number | null;
  alpha: number;
  smoothTrajectory: boolean;
  showCookedOverlay: boolean;
  smoothOnlySeeker: boolean;
  showPhaseOverlay: boolean;
  onPatient: (value: string) => void;
  onCondition: (value: string) => void;
  onPhase: (value: string) => void;
  onPath: (value: string) => void;
  onSession: (value: number) => void;
  onAlpha: (value: number) => void;
  onSmoothTrajectory: (value: boolean) => void;
  onShowCookedOverlay: (value: boolean) => void;
  onSmoothOnlySeeker: (value: boolean) => void;
  onShowPhaseOverlay: (value: boolean) => void;
  onRefresh: () => void;
}

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values.filter(Boolean)));
}

export function Controls(props: Props) {
  const [open, setOpen] = useState(false);
  const patients = unique(props.sessions.map((s) => s.patient)).sort();
  const conditions = unique(
    props.sessions
      .filter((s) => !props.selectedPatient || s.patient === props.selectedPatient)
      .map((s) => s.condition)
  ).sort();
  const phases = unique(
    props.sessions
      .filter((s) => !props.selectedPatient || s.patient === props.selectedPatient)
      .filter((s) => !props.selectedCondition || s.condition === props.selectedCondition)
      .map((s) => s.phase)
  ).sort();
  const paths = unique(
    props.sessions
      .filter((s) => !props.selectedPatient || s.patient === props.selectedPatient)
      .filter((s) => !props.selectedCondition || s.condition === props.selectedCondition)
      .filter((s) => s.phase === props.selectedPhase)
      .map((s) => s.path_id)
  ).sort();

  const sessionOptions = props.sessions
    .filter((s) => !props.selectedPatient || s.patient === props.selectedPatient)
    .filter((s) => !props.selectedCondition || s.condition === props.selectedCondition)
    .filter((s) => s.phase === props.selectedPhase)
    .filter((s) => !props.selectedPath || s.path_id === props.selectedPath)
    .sort((a, b) => `${a.path_id}-${a.phase}-${a.start_time}`.localeCompare(`${b.path_id}-${b.phase}-${b.start_time}`));

  const current = props.sessions.find((s) => s.session_id === props.selectedSessionId);
  const isCompare = props.mode === 'compare';

  return (
    <>
      <button type="button" className="drawerToggle" onClick={() => setOpen(true)}>
        ⚙ Filters &amp; settings
      </button>
      {open ? <button type="button" className="drawerBackdrop" aria-label="Close settings" onClick={() => setOpen(false)} /> : null}

      <aside className={`controlsDrawer ${open ? 'open' : ''}`} aria-hidden={!open}>
        <section className="controls card">
          <div className="drawerHeader">
            <div>
              <strong>Dashboard settings</strong>
              <p>{current ? `${current.patient} / ${current.phase} / ${current.path_id}` : 'Select a session'}</p>
            </div>
            <button type="button" className="closeButton" onClick={() => setOpen(false)}>×</button>
          </div>

          <div className="controlGrid">
            <label>
              Patient
              <select value={props.selectedPatient} onChange={(e) => props.onPatient(e.target.value)}>
                {patients.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </label>

            <label>
              Task / condition
              <select value={props.selectedCondition} onChange={(e) => props.onCondition(e.target.value)}>
                {conditions.map((c) => {
                  const label = props.sessions.find((s) => s.condition === c)?.condition_label ?? c;
                  return <option key={c} value={c}>{label}</option>;
                })}
              </select>
            </label>

            <label>
              Phase{isCompare ? ' (ignored when comparing phases)' : ''}
              <select value={props.selectedPhase} onChange={(e) => props.onPhase(e.target.value)}>
                {phases.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </label>

            <label>
              Path
              <select value={props.selectedPath} onChange={(e) => props.onPath(e.target.value)}>
                {paths.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </label>

            {!isCompare ? (
              <label className="wide">
                Session
                <select
                  value={props.selectedSessionId ?? ''}
                  onChange={(e) => props.onSession(Number(e.target.value))}
                >
                  {sessionOptions.map((s) => (
                    <option key={s.session_id} value={s.session_id}>
                      {s.phase} | {s.path_id} | {s.start_time ?? 'no time'} | {s.n_raw ?? '?'} samples | {s.warning}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}

            {!isCompare ? (
              <label>
                Plot smoothing α: {props.alpha.toFixed(2)}
                <input
                  type="range"
                  min="0.05"
                  max="1"
                  step="0.05"
                  value={props.alpha}
                  onChange={(e) => props.onAlpha(Number(e.target.value))}
                />
              </label>
            ) : null}
          </div>

          {!isCompare ? (
            <div className="toggleColumn">
              <label><input type="checkbox" checked={props.smoothTrajectory} onChange={(e) => props.onSmoothTrajectory(e.target.checked)} /> Smooth 2D offline</label>
              <label><input type="checkbox" checked={props.showCookedOverlay} onChange={(e) => props.onShowCookedOverlay(e.target.checked)} /> Cooked overlay α=0.4</label>
              <label><input type="checkbox" checked={props.smoothOnlySeeker} onChange={(e) => props.onSmoothOnlySeeker(e.target.checked)} /> Smooth seeker P1 only</label>
              <label><input type="checkbox" checked={props.showPhaseOverlay} onChange={(e) => props.onShowPhaseOverlay(e.target.checked)} /> Preload 2D learning/exploration overlay</label>
              <button type="button" onClick={props.onRefresh}>Refresh index</button>
            </div>
          ) : (
            <div className="toggleColumn">
              <button type="button" onClick={props.onRefresh}>Refresh index</button>
            </div>
          )}
        </section>
      </aside>
    </>
  );
}
