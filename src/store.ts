// 本地持久化 (localStorage)
import type { Calibration, ThrowEvent } from './types';

const K_CALIB = 'hp_calibrations';
const K_EVENTS = 'hp_events';

function read<T>(key: string): T[] {
  try { return JSON.parse(localStorage.getItem(key) || '[]') as T[]; }
  catch { return []; }
}
function write<T>(key: string, v: T[]) {
  try { localStorage.setItem(key, JSON.stringify(v)); }
  catch (e) { console.warn('存储失败(可能超出配额)', e); }
}

export const store = {
  calibrations(): Calibration[] { return read<Calibration>(K_CALIB); },
  getCalibration(id: string): Calibration | undefined { return read<Calibration>(K_CALIB).find(c => c.id === id); },
  saveCalibration(c: Calibration) {
    const all = read<Calibration>(K_CALIB).filter(x => x.id !== c.id);
    all.push(c); write(K_CALIB, all);
  },
  deleteCalibration(id: string) { write(K_CALIB, read<Calibration>(K_CALIB).filter(c => c.id !== id)); },

  events(): ThrowEvent[] { return read<ThrowEvent>(K_EVENTS); },
  getEvent(id: string): ThrowEvent | undefined { return read<ThrowEvent>(K_EVENTS).find(e => e.id === id); },
  saveEvents(evs: ThrowEvent[]) { write(K_EVENTS, read<ThrowEvent>(K_EVENTS).concat(evs)); },
  deleteEvent(id: string) { write(K_EVENTS, read<ThrowEvent>(K_EVENTS).filter(e => e.id !== id)); },
  clearEvents() { write(K_EVENTS, []); },
};

export function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
