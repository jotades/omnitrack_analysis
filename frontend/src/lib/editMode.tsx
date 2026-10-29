import { createContext, useContext } from 'react';

/** Edit mode: while off (the default), every control that saves a correction
 * (point E, phase swap, exclusions, landmark flags and positions, activation
 * distance, inclusion) is disabled, so reading the dashboard can never change
 * the data. Every save made while it is on is logged and can be undone from
 * the "Changes" menu. */
export const EditModeContext = createContext<boolean>(false);

export function useEditMode(): boolean {
  return useContext(EditModeContext);
}
