import type { SessionPayload } from '../types';

export type Phase = 'learning' | 'exploration';

export function phaseOf(payload: SessionPayload): Phase | null {
  const phase = payload.summary?.phase ?? payload.summary?.task;
  return phase === 'learning' || phase === 'exploration' ? phase : null;
}

/** Find the SessionPayload for a given phase among the currently displayed
 * payload and any preloaded sibling-phase payloads (or null if not loaded). */
export function payloadForPhase(
  phase: Phase,
  current: SessionPayload,
  overlayPayloads: SessionPayload[],
): SessionPayload | null {
  if (phaseOf(current) === phase) return current;
  return overlayPayloads.find((p) => phaseOf(p) === phase) ?? null;
}

/** Small segmented control to switch a card between showing learning vs.
 * exploration data; a phase is disabled when its payload isn't loaded yet. */
export function PhaseToggle({
  selected,
  available,
  onSelect,
}: {
  selected: Phase | null;
  available: Record<Phase, boolean>;
  onSelect: (phase: Phase) => void;
}) {
  const phases: Phase[] = ['learning', 'exploration'];
  return (
    <div className="phaseToggle" role="group" aria-label="Show learning or exploration">
      {phases.map((phase) => (
        <button
          key={phase}
          type="button"
          className={`phaseToggleBtn ${selected === phase ? 'active' : ''}`}
          disabled={!available[phase]}
          title={available[phase] ? `Show ${phase}` : `${phase} session not loaded — enable the Learning/Exploration overlay on the 2D room trajectory`}
          onClick={() => onSelect(phase)}
        >
          {phase}
        </button>
      ))}
    </div>
  );
}
