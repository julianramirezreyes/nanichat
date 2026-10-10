'use client';

import { useEffect, useRef } from 'react';
import { type NaniState, naniLabel } from '../nani-labels';

/**
 * Nani, the nanichat mascot: an inline SVG speech bubble (no <use>, so document CSS can style every part).
 * The state comes from real data (see app/nani-labels.ts). `follow` makes the pupils track the pointer with a
 * smoothed (lerp) motion; it is decorative, only meant for the big hero Nani, and off for touch or reduced motion.
 */
export function Nani({ state, size = 120, follow = false, decorative = false, className }: { state: NaniState; size?: number; follow?: boolean; decorative?: boolean; className?: string }) {
  const svgRef = useRef<SVGSVGElement>(null);
  const pupilsRef = useRef<SVGGElement>(null);
  const tracking = follow && state !== 'sleep';

  useEffect(() => {
    const pupils = pupilsRef.current;
    if (!tracking || !pupils) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches || !window.matchMedia('(hover: hover) and (pointer: fine)').matches) return;
    const target = { x: 0, y: 0 }; const current = { x: 0, y: 0 };
    let frame = 0;
    function onMove(event: PointerEvent) {
      const box = svgRef.current?.getBoundingClientRect();
      if (!box) return;
      const dx = event.clientX - (box.left + box.width / 2); const dy = event.clientY - (box.top + box.height / 2);
      const distance = Math.hypot(dx, dy) || 1;
      target.x = (dx / distance) * Math.min(4, distance / 60);
      target.y = (dy / distance) * Math.min(3, distance / 80);
      if (!frame) frame = requestAnimationFrame(step);
    }
    function step() {
      current.x += (target.x - current.x) * 0.12; current.y += (target.y - current.y) * 0.12;
      pupils!.style.transform = `translate(${current.x.toFixed(2)}px, ${current.y.toFixed(2)}px)`;
      frame = Math.abs(target.x - current.x) + Math.abs(target.y - current.y) > 0.02 ? requestAnimationFrame(step) : 0;
    }
    window.addEventListener('pointermove', onMove, { passive: true });
    return () => { window.removeEventListener('pointermove', onMove); cancelAnimationFrame(frame); pupils.style.transform = ''; };
  }, [tracking]);

  return <svg ref={svgRef} className={`nani ${state}${className ? ` ${className}` : ''}`} viewBox="0 0 120 120" width={size} height={size}
    {...(decorative ? { 'aria-hidden': true } : { role: 'img', 'aria-label': naniLabel(state) })}>
    <g className="nani-bob">
      <path className="nani-body" d="M60 10c28 0 50 19 50 44s-22 44-50 44c-6 0-12-1-17-2.6L22 106c-3 1.5-6-1.5-4.6-4.5l6-14C16 79.6 10 67.6 10 54 10 29 32 10 60 10z" />
      <ellipse className="nani-cheek" cx="36" cy="66" rx="7" ry="4" /><ellipse className="nani-cheek" cx="84" cy="66" rx="7" ry="4" />
      <g ref={pupilsRef} className="nani-pupils"><ellipse className="nani-eye" cx="45" cy="50" rx="6" ry="8" /><ellipse className="nani-eye" cx="75" cy="50" rx="6" ry="8" /></g>
      <path className="nani-lid" d="M38 52q7 6 14 0M68 52q7 6 14 0" />
      <path className="nani-mouth" d={state === 'alert' ? 'M52 72q8 -4 16 0' : 'M50 68q10 8 20 0'} />
    </g>
    <text className="nani-z" x="92" y="22" fontSize="16">z</text><text className="nani-z nani-z2" x="100" y="12" fontSize="12">z</text>
  </svg>;
}
