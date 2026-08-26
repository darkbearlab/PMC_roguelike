/** 極小的 DOM 工具。UI 層唯讀 GameState，一律透過 Command 改狀態。 */
export function $<T extends HTMLElement>(sel: string): T {
  const el = document.querySelector(sel);
  if (!el) throw new Error('找不到元素 ' + sel);
  return el as T;
}

export function $$<T extends HTMLElement>(sel: string): T[] {
  return Array.from(document.querySelectorAll(sel)) as T[];
}

export function setText(sel: string, text: string): void {
  $(sel).textContent = text;
}

export function show(el: HTMLElement, visible: boolean): void {
  el.classList.toggle('hidden', !visible);
}

export function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;');
}
