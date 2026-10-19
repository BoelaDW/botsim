// Gallery page: the robots in public/robots (listed in robots/index.json at build time).
import { busy, done } from './busy';
import { BRANCH, REPO, ROBOT_DIR } from './config';
import { loadBot } from './robotfile';
import type { RobotDef } from './types';

export interface GalleryEntry {
  file: string; name: string; author: string; description: string; weapon: string;
  mass: number; volts: number; parts: number; bytes: number; added: string | null;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
export const isGalleryFile = (f: string) => /^[\w.-]+\.bot$/i.test(f);
export const shareLink = (file: string) => `${location.origin}${location.pathname}?bot=${encodeURIComponent(file)}`;

/** Download a gallery robot with a progress bar. */
export async function fetchBot(file: string, label = `Downloading ${file}`): Promise<RobotDef> {
  if (!isGalleryFile(file)) throw new Error(`"${file}" is not a gallery robot file name`);
  busy(label, 0);
  try {
    const res = await fetch('robots/' + encodeURIComponent(file));
    if (!res.ok) throw new Error(`${file}: ${res.status === 404 ? 'not in the gallery' : 'HTTP ' + res.status}`);
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
      this.entries = res.ok ? await res.json() : [];
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
    list.innerHTML = shown.map((e) => `<div class="card" data-file="${esc(e.file)}">
      <h4>${esc(e.name)}</h4>
      <div class="by">${e.author ? 'by ' + esc(e.author) : 'unknown builder'}${e.added ? ' · ' + new Date(e.added).toLocaleDateString() : ''}</div>
      <div class="facts"><span>${esc(e.weapon)}</span><span>${e.mass.toFixed(2)} kg</span><span>${e.volts} V</span>
        <span>${e.parts} parts</span><span>${(e.bytes / 1e6).toFixed(1)} MB</span></div>
      <div class="desc">${esc(e.description)}</div>
      <div class="acts"><button class="primary" data-act="fight">Fight with it</button>
        <button data-act="add" title="add to the arena's robot lists">Add</button>
        <button data-act="link" title="copy a link that opens the arena with this robot">Link</button></div>
    </div>`).join('');
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
