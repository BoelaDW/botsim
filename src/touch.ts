// On-screen controls for phones and tablets. They appear on the first touch and drive player 1.
// Two sticks like a gamepad (left = throttle, right = steer), or one stick that does both.
export const touch = {
  active: false,
  oneStick: false,
  thr: 0, steer: 0,
  weaponHeld: false,
  weaponTaps: 0,            // spinner toggles not yet picked up by the driver
};

export interface TouchHooks { menu(): void; reset(): void; camera(): void; flip(): void; pause(): void }

const RADIUS = 56;          // px of thumb travel for full throttle / steer

export function setupTouch(arena: HTMLElement, hooks: TouchHooks) {
  const el = document.createElement('div');
  el.id = 'touch';
  el.hidden = true;
  el.innerHTML = `
    <div class="stick" data-side="l"><div class="base"></div><div class="knob"></div><span class="lbl">DRIVE</span></div>
    <div class="stick" data-side="r"><div class="base"></div><div class="knob"></div><span class="lbl">STEER</span></div>
    <button class="tbtn weapon" data-b="weapon">WEAPON</button>
    <button class="tbtn flip" data-b="flip">FLIP</button>
    <div class="tbar">
      <button data-b="menu">Menu</button><button data-b="reset">Reset</button><button data-b="camera">Cam</button>
      <button data-b="pause">Pause</button><button data-b="full">Full screen</button>
    </div>`;
  arena.append(el);
  const full = el.querySelector<HTMLElement>('[data-b=full]')!;
  if (!document.documentElement.requestFullscreen) full.hidden = true;

  const show = () => {
    if (touch.active) return;
    touch.active = true;
    el.hidden = false;
    document.body.classList.add('touch');
  };
  addEventListener('touchstart', show, { passive: true });
  if (matchMedia('(pointer: coarse)').matches && !matchMedia('(pointer: fine)').matches) show();

  // sticks float: they centre wherever the thumb lands inside their half of the screen
  for (const stick of el.querySelectorAll<HTMLElement>('.stick')) {
    const side = stick.dataset.side!, base = stick.querySelector<HTMLElement>('.base')!, knob = stick.querySelector<HTMLElement>('.knob')!;
    let id = -1, ox = 0, oy = 0;
    const set = (dx: number, dy: number) => {
      const len = Math.hypot(dx, dy), k = len > RADIUS ? RADIUS / len : 1;
      dx *= k; dy *= k;
      knob.style.transform = `translate(${dx}px, ${dy}px)`;
      const x = dx / RADIUS, y = -dy / RADIUS;
      if (side === 'l') { touch.thr = dz(y); if (touch.oneStick) touch.steer = dz(x) * 0.8; }
      else if (!touch.oneStick) touch.steer = dz(x) * 0.8;
    };
    stick.addEventListener('pointerdown', (e) => {
      if (id >= 0) return;
      id = e.pointerId;
      stick.setPointerCapture(id);
      const r = stick.getBoundingClientRect();
      ox = e.clientX; oy = e.clientY;
      for (const n of [base, knob]) { n.style.left = `${ox - r.left}px`; n.style.top = `${oy - r.top}px`; }
      stick.classList.add('on');
      set(0, 0);
      e.preventDefault();
    });
    stick.addEventListener('pointermove', (e) => { if (e.pointerId === id) set(e.clientX - ox, e.clientY - oy); });
    const up = (e: PointerEvent) => {
      if (e.pointerId !== id) return;
      id = -1;
      stick.classList.remove('on');
      set(0, 0);
      if (side === 'l') { touch.thr = 0; if (touch.oneStick) touch.steer = 0; } else if (!touch.oneStick) touch.steer = 0;
    };
    stick.addEventListener('pointerup', up);
    stick.addEventListener('pointercancel', up);
  }

  const weapon = el.querySelector<HTMLElement>('[data-b=weapon]')!;
  weapon.addEventListener('pointerdown', (e) => { touch.weaponHeld = true; touch.weaponTaps++; weapon.setPointerCapture(e.pointerId); e.preventDefault(); });
  const release = () => (touch.weaponHeld = false);
  weapon.addEventListener('pointerup', release);
  weapon.addEventListener('pointercancel', release);

  el.querySelector('.tbar')!.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-b]')?.dataset.b;
    if (b === 'full') { if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen().catch(() => {}); }
    else if (b && b in hooks) hooks[b as keyof TouchHooks]();
  });
  el.querySelector('[data-b=flip]')!.addEventListener('pointerdown', (e) => { hooks.flip(); e.preventDefault(); });
}

/** Light up the weapon button while a spinner is switched on. */
export function setWeaponLit(on: boolean) {
  document.querySelector('#touch .weapon')?.classList.toggle('lit', on);
}

const dz = (v: number) => (Math.abs(v) < 0.06 ? 0 : v);
