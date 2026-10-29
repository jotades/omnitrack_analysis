/** Route label of a trial or recording. path_id is the letter in the file
 * name; route_id the route actually set up (route_overrides.json on the
 * backend). When they differ: "A (actual path: C)". */
export function routeLabel(pathId: string | null | undefined, routeId?: string | null): string {
  if (!pathId) return '—';
  const recorded = pathId.replace('path_', '');
  const actual = routeId ? routeId.replace('path_', '') : recorded;
  return actual === recorded ? recorded : `${recorded} (actual path: ${actual})`;
}
