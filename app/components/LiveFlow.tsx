'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Activity, MessageCircle, Moon, Send } from 'lucide-react';
import { Nani } from './Nani';
import type { FlowEntry, NaniState } from '../nani-labels';

const EASE_IN_OUT = 'cubic-bezier(0.77, 0, 0.175, 1)';
type Phase = 'in' | 'matched' | 'replied';

/**
 * "Lo que está pasando": real recent queue items. Comments on the left, Nani's private replies on the right.
 * Items present on the first render show as they are; items that arrive with a later refresh play the sequence
 * comment enters → keyword lights up and flies to Nani → the DM bubble enters (then `onReply` lets Nani hop).
 */
export function LiveFlow({ entries, nani, sleeping, stateLabel, onReply, partial = false }: { entries: FlowEntry[]; nani: NaniState; sleeping: boolean; stateLabel(state: string): string; onReply(): void; partial?: boolean }) {
  const seen = useRef<Set<string> | null>(null);
  const [phases, setPhases] = useState<Record<string, Phase>>({});
  const timers = useRef<Array<ReturnType<typeof setTimeout>>>([]);
  const bridgeRef = useRef<HTMLDivElement>(null);
  const laneRef = useRef<HTMLDivElement>(null);
  const onReplyRef = useRef(onReply); onReplyRef.current = onReply;

  useLayoutEffect(() => {
    if (!seen.current) { seen.current = new Set(entries.map((entry) => entry.id)); return; }
    const fresh = entries.filter((entry) => !seen.current!.has(entry.id));
    fresh.forEach((entry) => seen.current!.add(entry.id));
    // A full replacement (another account, another page or filter) is a new view, not new activity: no burst.
    if (!fresh.length || fresh.length === entries.length) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    setPhases((previous) => ({ ...previous, ...Object.fromEntries(fresh.map((entry) => [entry.id, 'in' as Phase])) }));
    fresh.forEach((entry, index) => {
      const base = index * 400;
      timers.current.push(setTimeout(() => {
        setPhases((previous) => ({ ...previous, [entry.id]: 'matched' }));
        const mark = laneRef.current?.querySelector<HTMLElement>(`[data-flow-id="${CSS.escape(entry.id)}"] mark`);
        const to = bridgeRef.current?.getBoundingClientRect();
        if (!reduce && mark && to && to.width && entry.match) {
          const from = mark.getBoundingClientRect();
          const chip = document.createElement('span');
          chip.className = 'flow-fly'; chip.textContent = entry.match.keyword; document.body.append(chip);
          chip.animate([
            { transform: `translate(${from.left}px, ${from.top}px)`, opacity: 1 },
            { transform: `translate(${to.left + to.width / 2 - 20}px, ${to.top + to.height / 2 - 30}px) scale(.8)`, opacity: 0.2 },
          ], { duration: 520, easing: EASE_IN_OUT, fill: 'forwards' }).onfinish = () => chip.remove();
        }
      }, base + (reduce ? 0 : 650)));
      timers.current.push(setTimeout(() => {
        setPhases((previous) => ({ ...previous, [entry.id]: 'replied' }));
        // Nani only celebrates replies that were actually sent or simulated.
        if (entry.reply && (entry.state === 'SENT' || entry.state === 'SIMULATED')) onReplyRef.current();
      }, base + (reduce ? 0 : 1170)));
    });
  }, [entries]);

  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  const replies = entries.filter((entry) => entry.reply && (phases[entry.id] ?? 'replied') === 'replied');
  return <section aria-labelledby="flow-title" className="flow-section">
    <div className="section-h"><h3 id="flow-title" className="sec-title"><Activity size={18} aria-hidden="true" /> Lo que está pasando</h3><p className="muted">Comentarios a la izquierda; lo que Nani responde, a la derecha.{partial && <> <span className="flow-hint">Mostrando la página actual de la cola.</span></>}</p></div>
    <div className="flow">
      <div className="lane" ref={laneRef}>
        <h4><MessageCircle size={14} aria-hidden="true" /> Comentarios recientes</h4>
        {entries.length ? entries.map((entry) => {
          const phase = phases[entry.id];
          return <div key={entry.id} data-flow-id={entry.id} className={`cmt${phase === 'in' ? ' enter' : ''}${phase === 'matched' || phase === 'replied' ? ' matched' : ''}`}>
            <span className="ring-avatar sm" aria-hidden="true"><span className="ring-avatar-inner">{entry.username ? entry.username[0]!.toUpperCase() : '?'}</span></span>
            <div className="cmt-body"><b>{entry.username ? `@${entry.username}` : 'Comentario'}</b>
              <p>{entry.match ? <>{entry.match.before}<mark>{entry.match.match}</mark>{entry.match.after}</> : (entry.text || 'Sin texto guardado')}</p></div>
          </div>;
        }) : <div className="empty-lane">{sleeping ? <><Moon size={18} aria-hidden="true" /> Estoy dormida: no leo comentarios.</> : <>Todavía no llegan comentarios. Estoy atenta.</>}</div>}
      </div>
      <div className="bridge" ref={bridgeRef}><Nani state={nani} size={64} decorative /></div>
      <div className="lane">
        <h4><Send size={14} aria-hidden="true" /> Mensajes privados</h4>
        {replies.length ? replies.map((entry) => <div key={entry.id} className={phases[entry.id] === 'replied' ? 'flow-dm enter' : 'flow-dm'}>
          <small>para {entry.username ? `@${entry.username}` : 'el autor'} · <span className={`flow-dm-state ${entry.state.toLowerCase()}`}>{stateLabel(entry.state)}</span></small>{entry.reply}
        </div>) : <div className="empty-lane">Todavía no respondí a nadie.</div>}
      </div>
    </div>
  </section>;
}
