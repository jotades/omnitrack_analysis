/** Labels shown in the dashboard, following the thesis glossary (chapter 4,
 * table of measures): conditions AP / AE / HP / HE, participants as PP_xx,
 * routes, learning / exploration phase, first / second task. Data keys
 * (condition ids, path_id, patient ids) are never changed — only how they read. */

export const CONDITION_SHORT: Record<string, string> = {
  auditory_on_person_intes: 'AP',
  auditory_on_object_intes: 'AE',
  haptic_on_person_intes: 'HP',
  haptic_on_object_intes: 'HE',
};

export const CONDITION_NAME: Record<string, string> = {
  auditory_on_person_intes: 'Auditory on person',
  auditory_on_object_intes: 'Auditory external',
  haptic_on_person_intes: 'Haptic on person',
  haptic_on_object_intes: 'Haptic external',
};

/** "AP" — the short label used in tables and charts. */
export function conditionShort(condition: string | null | undefined): string {
  if (!condition) return '—';
  return CONDITION_SHORT[condition] ?? condition;
}

/** "Auditory on person (AP)" — the full label. */
export function conditionLabel(condition: string | null | undefined): string {
  if (!condition) return '—';
  const name = CONDITION_NAME[condition];
  return name ? `${name} (${CONDITION_SHORT[condition]})` : condition;
}

/** "PP_05" — participant code as written in the thesis. */
export function participantLabel(patient: string | null | undefined): string {
  return patient ? patient.toUpperCase() : '—';
}

/** "Learning phase" / "Exploration phase". */
export function phaseLabel(phase: string | null | undefined, withWord = true): string {
  if (phase === 'learning') return withWord ? 'Learning phase' : 'Learning';
  if (phase === 'exploration') return withWord ? 'Exploration phase' : 'Exploration';
  return phase ?? '—';
}
