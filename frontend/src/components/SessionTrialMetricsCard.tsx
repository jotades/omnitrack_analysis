import { useEffect, useState } from 'react';
import type { SessionPayload, SessionRow, TrialRow } from '../types';
import { ChartCard } from './ChartCard';
import { TrialMiniStats } from './ConditionTrajectoriesGrid';
import { type Phase, PhaseToggle, phaseOf, payloadForPhase } from './PhaseToggle';

function sessionIdForPayload(p: SessionPayload, sessions: SessionRow[]): number | null {
  const file = p.summary?.file;
  if (!file) return null;
  return sessions.find((s) => s.file_name === file)?.session_id ?? null;
}

// Multiple exploration attempts can share the same learning reference — pick
// the most recent match, matching the convention used elsewhere in the app.
function matchTrialRow(rows: TrialRow[], phase: Phase, sessionId: number | null): TrialRow | null {
  if (sessionId === null) return null;
  const matches = rows.filter((r) => (phase === 'exploration' ? r.exploration_session_id === sessionId : r.learning_session_id === sessionId));
  return matches.length ? matches[matches.length - 1] : null;
}

interface Props {
  payload: SessionPayload;
  phaseOverlayPayloads: SessionPayload[];
  trialRows: TrialRow[];
  sessions: SessionRow[];
}

/** Trial metrics (overlap, turns, stops, border...) plus this session's own
 * stats (duration, feedback, intensity, speed, closest distance), with its
 * own learning/exploration toggle — independent of whichever session happens
 * to be selected in the main controls. */
export function SessionTrialMetricsCard({ payload, phaseOverlayPayloads, trialRows, sessions }: Props) {
  const currentPhase = phaseOf(payload);
  const availability = {
    learning: !!payloadForPhase('learning', payload, phaseOverlayPayloads),
    exploration: !!payloadForPhase('exploration', payload, phaseOverlayPayloads),
  };
  const preferredPhase: Phase | null = availability.exploration ? 'exploration' : availability.learning ? 'learning' : currentPhase;

  const [manualPhase, setManualPhase] = useState<Phase | null>(null);
  useEffect(() => { setManualPhase(null); }, [payload.summary?.file]);

  const selectedPhase = manualPhase ?? preferredPhase;
  const effectivePayload = (selectedPhase && payloadForPhase(selectedPhase, payload, phaseOverlayPayloads)) ?? payload;
  const effectivePhase = phaseOf(effectivePayload);

  const effectiveSessionId = sessionIdForPayload(effectivePayload, sessions);
  const trialRow = effectivePhase ? matchTrialRow(trialRows, effectivePhase, effectiveSessionId) : null;

  return (
    <ChartCard title="Session & trial metrics" subtitle={effectivePhase ? `Showing ${effectivePhase}` : undefined}>
      <PhaseToggle selected={effectivePhase} available={availability} onSelect={setManualPhase} />
      <TrialMiniStats row={trialRow} metrics={effectivePayload.metrics} />
    </ChartCard>
  );
}
