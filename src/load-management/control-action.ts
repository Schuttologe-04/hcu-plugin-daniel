/** Intent only. There is deliberately no device command executor in phase 2. */
export type ControlAction =
  | { readonly type: 'SET_TEMPORARY_CURRENT_LIMIT'; readonly chargerId: string; readonly amps: number }
  | { readonly type: 'PAUSE'; readonly chargerId: string }
  | { readonly type: 'RESUME'; readonly chargerId: string }
  | { readonly type: 'CLEAR_TEMPORARY_CURRENT_LIMIT'; readonly chargerId: string };
