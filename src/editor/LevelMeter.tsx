import { useEffect, useRef } from 'react';
import { meterFraction, toDb } from './audioFx';
import { readLevels } from './previewAudio';

const FLOOR = -60;
/** How fast the bars fall back, in dB per second (they jump up at once). */
const FALL = 36;
/** How long the peak tick and the "over" light stay after the moment that caused them. */
const HOLD_MS = 1500;
/** Above this the mix would clip in an export. */
const OVER_DB = -0.1;

/**
 * Stereo level meter for the preview's mix (before the volume slider, so it is
 * the level an export gets). Green to -12 dB, amber to -3, red above; a tick
 * holds the recent peak and a red light stays lit for a moment after an over.
 * Drawn straight onto a canvas from an animation frame, so it never re-renders
 * the editor.
 */
export function LevelMeter({ active }: { active: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const cnv = ref.current;
    const ctx = cnv?.getContext('2d');
    if (!cnv || !ctx) return;
    const W = cnv.width;
    const H = cnv.height;
    const shown = [FLOOR, FLOOR];
    const held = [FLOOR, FLOOR];
    const heldAt = [0, 0];
    let overAt = -Infinity;
    let last = performance.now();
    let raf = 0;
    let idle = 0;

    const draw = (): void => {
      const now = performance.now();
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const levels = readLevels();
      ctx.clearRect(0, 0, W, H);
      const barH = Math.floor((H - 2) / 2);
      const barW = W - 8;
      let moving = false;
      for (let ch = 0; ch < 2; ch++) {
        const db = Math.max(FLOOR, toDb(levels[ch]));
        shown[ch] = db > shown[ch] ? db : Math.max(db, shown[ch] - FALL * dt);
        if (db >= held[ch] || now - heldAt[ch] > HOLD_MS) {
          held[ch] = db;
          heldAt[ch] = now;
        }
        if (db > OVER_DB) overAt = now;
        if (shown[ch] > FLOOR + 0.5) moving = true;
        const y = ch * (barH + 2);
        ctx.fillStyle = 'rgba(255,255,255,0.08)';
        ctx.fillRect(0, y, barW, barH);
        const w = Math.round(meterFraction(shown[ch], FLOOR) * barW);
        const amber = Math.round(meterFraction(-12, FLOOR) * barW);
        const red = Math.round(meterFraction(-3, FLOOR) * barW);
        ctx.fillStyle = '#34d399';
        ctx.fillRect(0, y, Math.min(w, amber), barH);
        if (w > amber) {
          ctx.fillStyle = '#fbbf24';
          ctx.fillRect(amber, y, Math.min(w, red) - amber, barH);
        }
        if (w > red) {
          ctx.fillStyle = '#f87171';
          ctx.fillRect(red, y, w - red, barH);
        }
        if (held[ch] > FLOOR + 0.5) {
          ctx.fillStyle = 'rgba(255,255,255,0.85)';
          ctx.fillRect(Math.min(barW - 1, Math.round(meterFraction(held[ch], FLOOR) * barW)), y, 1, barH);
        }
      }
      const over = now - overAt < HOLD_MS;
      ctx.fillStyle = over ? '#ef4444' : 'rgba(255,255,255,0.08)';
      ctx.fillRect(W - 6, 0, 6, H);
      // Keep drawing while playing, and afterwards until the bars have fallen back.
      idle = moving || over ? 0 : idle + 1;
      if (active || idle < 30) raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [active]);

  return (
    <canvas
      ref={ref}
      width={84}
      height={12}
      className="h-3 w-[84px] flex-shrink-0 rounded-sm"
      title="Level of the mix (left over right), as an export gets it: green up to -12 dB, amber to -3 dB, red above. The block at the end lights when the mix would clip."
    />
  );
}
