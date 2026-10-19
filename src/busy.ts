// Full-window "working…" overlay with a progress bar (indeterminate when the fraction is unknown).
const el = document.createElement('div');
el.id = 'busy';
el.hidden = true;
el.innerHTML = `<div class="busy-box"><div class="spinner"></div><div class="busy-title"></div>
  <div class="bar"><div class="fill"></div></div><div class="busy-sub hint"></div></div>`;
document.body.append(el);
const title = el.querySelector<HTMLElement>('.busy-title')!, sub = el.querySelector<HTMLElement>('.busy-sub')!;
const bar = el.querySelector<HTMLElement>('.bar')!, fill = el.querySelector<HTMLElement>('.fill')!;
let t0 = 0, depth = 0, timer = 0, note = '';

const tick = () => { sub.textContent = `${note}${note ? ' · ' : ''}${((performance.now() - t0) / 1000).toFixed(0)} s`; };

/** Show or update the overlay. frac in 0..1, or undefined for "no idea how long". */
export function busy(text: string, frac?: number, detail = '') {
  if (el.hidden) { t0 = performance.now(); el.hidden = false; timer = window.setInterval(tick, 250); }
  title.textContent = text;
  note = detail;
  bar.classList.toggle('indeterminate', frac === undefined);
  fill.style.width = frac === undefined ? '' : `${Math.round(Math.max(0, Math.min(1, frac)) * 100)}%`;
  tick();
}

export function done() {
  el.hidden = true;
  clearInterval(timer);
}

/** Let the browser paint the overlay before a long synchronous job. */
export const paint = () => new Promise<void>((ok) => requestAnimationFrame(() => requestAnimationFrame(() => ok())));

/** Run a job with the overlay up; nested calls share one overlay. */
export async function withBusy<T>(text: string, job: () => Promise<T> | T): Promise<T> {
  depth++;
  busy(text);
  try {
    await paint();
    return await job();
  } finally {
    if (--depth === 0) done();
  }
}

/** Read a file with a determinate progress bar. */
export function readFile(f: File, as: 'text' | 'buffer', label: string): Promise<string | ArrayBuffer> {
  return new Promise((ok, fail) => {
    const r = new FileReader();
    r.onprogress = (e) => e.lengthComputable && busy(label, e.loaded / e.total, `${(e.loaded / 1e6).toFixed(1)} / ${(e.total / 1e6).toFixed(1)} MB`);
    r.onload = () => ok(r.result as string | ArrayBuffer);
    r.onerror = () => fail(r.error);
    if (as === 'text') r.readAsText(f); else r.readAsArrayBuffer(f);
  });
}
