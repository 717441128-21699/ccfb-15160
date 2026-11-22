export type PageId = 'calibration' | 'analysis' | 'events' | 'report' | 'test';

export interface AppState {
  page: PageId;
  /** 当前选中的标定 id */
  calibrationId: string | null;
  /** 事件列表里当前查看的事件 id（报告页用） */
  selectedEventId: string | null;
  /** 全局刷新计数，存储变化后自增触发重渲染 */
  revision: number;
}

const state: AppState = {
  page: 'calibration',
  calibrationId: null,
  selectedEventId: null,
  revision: 0,
};

const listeners = new Set<() => void>();

export function getState(): Readonly<AppState> {
  return state;
}

export function setState(patch: Partial<AppState>): void {
  Object.assign(state, patch);
  listeners.forEach((fn) => fn());
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function bump(): void {
  state.revision++;
  listeners.forEach((fn) => fn());
}

let toastTimer: number | undefined;
export function toast(message: string, kind: 'info' | 'error' | 'ok' = 'info'): void {
  const el = document.createElement('div');
  el.className = `toast ${kind === 'info' ? '' : kind}`;
  el.textContent = message;
  document.body.appendChild(el);
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.remove(), 3200);
}

export function fmtTime(sec: number): string {
  if (!isFinite(sec) || sec < 0) sec = Math.max(0, sec);
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

type ElAttrs = {
  [key: string]: string | number | boolean | EventListener | null | undefined | Record<string, string>;
  style?: Record<string, string> | string;
};

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: ElAttrs = {},
  ...children: Array<Node | string>
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') {
      node.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    } else if (k === 'class') {
      node.className = String(v);
    } else if (k === 'style' && typeof v === 'object') {
      Object.assign(node.style, v as Record<string, string>);
    } else {
      node.setAttribute(k, String(v));
    }
  }
  for (const child of children) {
    node.append(child instanceof Node ? child : document.createTextNode(child));
  }
  return node;
}
