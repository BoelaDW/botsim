// Gallery page: the robots in public/robots (listed in robots/index.json at build time).
import { busy, done } from './busy';
import { BRANCH, REPO, ROBOT_DIR } from './config';
import { loadBot } from './robotfile';
import type { RobotDef } from './types';
import { esc } from './util';

export interface GalleryEntry {
  file: string; name: string; author: string; description: string; weapon: string;
  mass: number; volts: number; parts: number; bytes: number; added: string | null;
}

export const isGalleryFile = (f: string) => /^[\w.-]+\.bot$/i.test(f);
export const shareLink = (file: string) => `${location.origin}${location.pathname}?bot=${encodeURIComponent(file)}`;

/** Download a gallery robot with a progress bar. */
export async function fetchBot(file: string, label = `Downloading ${file.slice(0, 60)}`): Promise<RobotDef> {
  if (!isGalleryFile(file) || file.length > 120) throw new Error(`"${file.slice(0, 60)}" is not a gallery robot file name`);
  busy(label, 0);
  try {
    const res = await fetch('robots/' + encodeURIComponent(file));
    // (some servers answer a missing file with the app's own page instead of a 404)
    if (res.status === 404 || res.headers.get('content-type')?.includes('text/html')) throw new Error(`${file} is not in the gallery`);
    if (!res.ok) throw new Error(`${file}: the server said ${res.status}`);
    const total = +(res.headers.get('content-length') ?? 0);
    const reader = res.body!.getReader(), chunks: Uint8Array[] = [];
    let got = 0;
    for (;;) {
      const { done: end, value } = await reader.read();
      if (end) break;
      chunks.push(value);
      got += value.length;
      busy(label, total ? got / total : undefined, `${(got / 1e6).toFixed(1)}${total ? ' / ' + (total / 1e6).toFixed(1) : ''} MB`);
    }
    const buf = new Uint8Array(got);
    let o = 0;
    for (const c of chunks) { buf.set(c, o); o += c.length; }
    busy(`Unpacking ${file}`);
    return await loadBot(buf.buffer);
  } finally {
    done();
  }
}

export class Gallery {
  entries: GalleryEntry[] | null = null;

  constructor(private root: HTMLElement, private onAdd: (def: RobotDef, fight: boolean) => void) {
    const q = (s: string) => root.querySelector(s) as HTMLElement;
    (q('#gal-upload') as HTMLAnchorElement).href = `https://github.com/${REPO}/upload/${BRANCH}/${ROBOT_DIR}`;
    q('#gal-search').addEventListener('input', () => this.render());
    q('#gal-weapon').addEventListener('change', () => this.render());
    q('#gal-list').addEventListener('click', (e) => this.click(e));
  }

  /** Fetch the list the first time the page is opened. */
  async open() {
    if (this.entries) return;
    try {
      const res = await fetch('robots/index.json', { cache: 'no-cache' });
      const raw = res.ok ? await res.json() : [];
      // the list is built from submitted files: keep only well-formed entries, coerce every field
      const str = (v: unknown, max = 500) => (typeof v === 'string' ? v.slice(0, max) : '');
      const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
      this.entries = (Array.isArray(raw) ? raw : []).filter((e) => e && typeof e === 'object' && isGalleryFile(str(e.file)) && str(e.name)).slice(0, 2000)
        .map((e) => ({ file: str(e.file), name: str(e.name, 80), author: str(e.author, 80), description: str(e.description, 600), weapon: str(e.weapon, 20),
          mass: n(e.mass), volts: n(e.volts), parts: n(e.parts), bytes: n(e.bytes), added: str(e.added, 40) || null }));
    } catch {
      this.entries = [];
    }
    this.render();
  }

  render() {
    const list = this.root.querySelector('#gal-list')!;
    const term = (this.root.querySelector('#gal-search') as HTMLInputElement).value.toLowerCase();
    const weapon = (this.root.querySelector('#gal-weapon') as HTMLSelectElement).value;
    const shown = (this.entries ?? []).filter((e) => (!weapon || e.weapon === weapon) &&
      (!term || `${e.name} ${e.author} ${e.description}`.toLowerCase().includes(term)));
    if (!this.entries?.length) { list.innerHTML = '<div class="hint">No robots in the gallery yet: be the first (see below).</div>'; return; }
    if (!shown.length) { list.innerHTML = '<div class="hint">No robots match.</div>'; return; }
    const MAX = 300;
    const more = shown.length > MAX ? `<div class="hint">…and ${shown.length - MAX} more: search to narrow it down.</div>` : '';
    list.innerHTML = shown.slice(0, MAX).map((e) => `<div class="card" data-file="${esc(e.file)}">
      <h4>${esc(e.name)}</h4>
      <div class="by">${e.author ? 'by ' + esc(e.author) : 'unknown builder'}${e.added && !isNaN(Date.parse(e.added)) ? ' · ' + new Date(e.added).toLocaleDateString() : ''}</div>
      <div class="facts"><span>${esc(e.weapon)}</span><span>${e.mass.toFixed(2)} kg</span><span>${e.volts} V</span>
        <span>${e.parts} parts</span><span>${(e.bytes / 1e6).toFixed(1)} MB</span></div>
      <div class="desc">${esc(e.description)}</div>
      <div class="acts"><button class="primary" data-act="fight">Fight with it</button>
        <button data-act="add" title="add to the arena's robot lists">Add</button>
        <button data-act="link" title="copy a link that opens the arena with this robot">Link</button></div>
    </div>`).join('') + more;
  }

  private async click(e: Event) {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-act]');
    const file = btn?.closest<HTMLElement>('.card')?.dataset.file;
    if (!btn || !file) return;
    if (btn.dataset.act === 'link') {
      const url = shareLink(file);
      try { await navigator.clipboard.writeText(url); btn.textContent = 'Copied'; }
      catch { prompt('Copy this link:', url); }
      setTimeout(() => (btn.textContent = 'Link'), 1500);
      return;
    }
    try {
      this.onAdd(await fetchBot(file), btn.dataset.act === 'fight');
      if (btn.dataset.act === 'add') btn.textContent = 'Added';
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    }
  }
}
