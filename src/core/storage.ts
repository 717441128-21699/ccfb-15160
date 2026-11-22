import type { FacadeCalibration, ThrowEvent } from './types';

const CAL_KEY = 'pt_calibrations_v1';
const EVENT_KEY = 'pt_events_v1';

function safeParse<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export const calibrationStore = {
  list(): FacadeCalibration[] {
    return safeParse<FacadeCalibration[]>(localStorage.getItem(CAL_KEY), []);
  },
  get(id: string): FacadeCalibration | undefined {
    return this.list().find((c) => c.id === id);
  },
  save(cal: FacadeCalibration): void {
    const all = this.list().filter((c) => c.id !== cal.id);
    all.push(cal);
    localStorage.setItem(CAL_KEY, JSON.stringify(all));
  },
  remove(id: string): void {
    localStorage.setItem(
      CAL_KEY,
      JSON.stringify(this.list().filter((c) => c.id !== id)),
    );
  },
};

export const eventStore = {
  list(): ThrowEvent[] {
    return safeParse<ThrowEvent[]>(localStorage.getItem(EVENT_KEY), []);
  },
  byCalibration(calId: string): ThrowEvent[] {
    return this.list().filter((e) => e.calibrationId === calId);
  },
  save(ev: ThrowEvent): void {
    const all = this.list().filter((e) => e.id !== ev.id);
    all.push(ev);
    try {
      localStorage.setItem(EVENT_KEY, JSON.stringify(all));
    } catch (err) {
      // 缩略图占满配额时，去掉缩略图重试
      console.warn('存储空间不足，事件将不携带缩略图持久化', err);
      const slim = { ...all, [all.length - 1]: { ...ev, thumbnails: [] } };
      localStorage.setItem(EVENT_KEY, JSON.stringify(slim));
    }
  },
  saveMany(events: ThrowEvent[]): void {
    const map = new Map(this.list().map((e) => [e.id, e]));
    for (const e of events) map.set(e.id, e);
    localStorage.setItem(EVENT_KEY, JSON.stringify([...map.values()]));
  },
  remove(id: string): void {
    localStorage.setItem(
      EVENT_KEY,
      JSON.stringify(this.list().filter((e) => e.id !== id)),
    );
  },
  clear(): void {
    localStorage.removeItem(EVENT_KEY);
  },
};
