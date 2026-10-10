'use client';

import { type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from 'react';
import { Check, EyeOff, Image as ImageIcon, List, Trash2 } from 'lucide-react';
import { Nani } from './Nani';
import { availableActions, shouldHandleShortcut } from '../moderation-labels';

export type DeckFlag = {
  flagId: string; state: string; category: string; source: string; reasons: unknown; createdAt: string;
  comment?: { text?: string | null; username?: string | null; createdAt?: string | null } | null;
  media?: { thumbnailUrl?: string | null; caption?: string | null; permalink?: string | null } | null;
};

const HOLD_MS = 1200;
const SWIPE_DISTANCE = 120;
const SWIPE_VELOCITY = 0.5; // px per ms: a quick flick is enough

/**
 * "Mesa de revisión": PENDING flags one at a time. Drag left / Ocultar → hide, drag right / "Está bien" → dismiss,
 * hold "Borrar" for 1.2 s → delete (the hold is the explicit confirmation). ← / → act instantly, without animation,
 * only while the deck has focus or the pointer (see shouldHandleShortcut). All actions call the existing handlers.
 */
export function ModerationDeck({ flags, total, loaded, accountFilter, busyId, mode, onHide, onDismiss, onDelete, onShowList, onCleared, setAiRow, ago, category, reasons, complaintHint }: {
  flags: DeckFlag[]; total: number; loaded: boolean; accountFilter: string; busyId: string; mode: string;
  onHide(id: string): Promise<void>; onDismiss(id: string): Promise<void>; onDelete(id: string): Promise<void>;
  onShowList(): void; onCleared(): void; setAiRow(node: HTMLDivElement | null): void;
  ago(value?: string | null): string; category(value: string): string; reasons(value: unknown): string; complaintHint: string;
}) {
  const [leaving, setLeaving] = useState<{ id: string; dir: -1 | 0 | 1; instant: boolean } | null>(null);
  const [decided, setDecided] = useState(0);
  const [active, setActive] = useState(false);
  const [holding, setHolding] = useState(false);
  const deckRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLElement>(null);
  const drag = useRef<{ x: number; t: number; dx: number; pointer: number } | null>(null);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hadCards = useRef(false);

  const stack = flags.filter((flag) => flag.flagId !== leaving?.id);
  const top = stack[0];
  const allowed = top ? availableActions(top.state) : null;
  const busy = Boolean(busyId) || Boolean(leaving);
  // Current values for timers and listeners that outlive the render that created them.
  const live = useRef({ topId: '', canDelete: false, busy: false });
  live.current = { topId: top?.flagId ?? '', canDelete: Boolean(allowed?.delete), busy };

  // The deck went from cards to empty after a decision: Nani celebrates.
  useEffect(() => {
    if (!loaded) return;
    if (flags.length) { hadCards.current = true; return; }
    if (hadCards.current && decided > 0) onCleared();
    hadCards.current = false;
  }, [flags.length, loaded, decided, onCleared]);

  async function decide(kind: 'hide' | 'dismiss' | 'delete', instant: boolean) {
    if (!top || busy) return;
    const id = top.flagId;
    setLeaving({ id, dir: kind === 'hide' ? -1 : kind === 'dismiss' ? 1 : 0, instant });
    setDecided((value) => value + 1);
    try { await (kind === 'hide' ? onHide(id) : kind === 'dismiss' ? onDismiss(id) : onDelete(id)); }
    finally { setLeaving(null); } // on failure the reloaded list still has the flag, so the card simply comes back
  }

  /** Focus or pointer over the deck, read at key time (the state alone can go stale when the focused card unmounts). */
  function isDeckActive() {
    const deck = deckRef.current;
    if (!deck) return false;
    return deck.contains(document.activeElement) || deck.matches(':hover');
  }
  // When the focused card leaves, hand focus to the next top card so the keyboard flow continues; otherwise reset.
  const topId = top?.flagId;
  useEffect(() => {
    if (!active) return;
    const focusLost = !document.activeElement || document.activeElement === document.body;
    if (!focusLost) return;
    if (topId && cardRef.current) cardRef.current.focus(); else setActive(false);
  }, [topId, active]);

  // Keyboard: ← hides, → dismisses; same guards as the list shortcuts.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const action = shouldHandleShortcut({
        key: event.key, repeat: event.repeat, modifier: event.metaKey || event.ctrlKey || event.altKey || event.shiftKey,
        typing: Boolean(target && (target.closest('input, textarea, select, [contenteditable="true"]') || target.isContentEditable)),
        dialogOpen: Boolean(document.querySelector('.modal')), accountFilter, selectedId: top?.flagId ?? '',
        visibleIds: stack.map((flag) => flag.flagId), state: top?.state ?? '', busy, narrow: false, sheetOpen: false,
        mode: 'deck', deckActive: isDeckActive(),
      });
      if (!action) return;
      event.preventDefault();
      void decide(action, true);
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  function setStamps(dx: number) {
    const card = cardRef.current; if (!card) return;
    card.style.setProperty('--hide-stamp', String(Math.min(1, Math.max(0, -dx / SWIPE_DISTANCE))));
    card.style.setProperty('--ok-stamp', String(Math.min(1, Math.max(0, dx / SWIPE_DISTANCE))));
  }
  function onPointerDown(event: ReactPointerEvent<HTMLElement>) {
    if (drag.current || busy || event.button !== 0) return; // ignore extra touch points while dragging
    drag.current = { x: event.clientX, t: performance.now(), dx: 0, pointer: event.pointerId };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.classList.add('dragging');
  }
  function onPointerMove(event: ReactPointerEvent<HTMLElement>) {
    const state = drag.current; if (!state || state.pointer !== event.pointerId) return;
    state.dx = event.clientX - state.x;
    event.currentTarget.style.transform = `translateX(${state.dx}px) rotate(${state.dx / 22}deg)`;
    setStamps(state.dx);
  }
  /** The browser took the gesture over (scroll, system UI): put the card back, never act. */
  function onPointerCancel(event: ReactPointerEvent<HTMLElement>) {
    const state = drag.current; if (!state || state.pointer !== event.pointerId) return;
    drag.current = null;
    const card = event.currentTarget;
    card.classList.remove('dragging'); card.classList.add('settling'); card.style.transform = ''; setStamps(0);
    setTimeout(() => card.classList.remove('settling'), 380);
  }
  function onPointerEnd(event: ReactPointerEvent<HTMLElement>) {
    const state = drag.current; if (!state || state.pointer !== event.pointerId) return;
    drag.current = null;
    const card = event.currentTarget;
    card.classList.remove('dragging');
    const velocity = Math.abs(state.dx) / Math.max(1, performance.now() - state.t);
    const kind = state.dx < 0 ? 'hide' : 'dismiss';
    const permitted = kind === 'hide' ? allowed?.hide : allowed?.dismiss;
    if (permitted && (Math.abs(state.dx) > SWIPE_DISTANCE || (velocity > SWIPE_VELOCITY && Math.abs(state.dx) > 30))) {
      card.style.transform = '';
      void decide(kind, false);
    } else {
      card.classList.add('settling'); card.style.transform = ''; setStamps(0);
      setTimeout(() => card.classList.remove('settling'), 380);
    }
  }

  function startHold() {
    if (!allowed?.delete || busy || holdTimer.current) return;
    setHolding(true);
    const heldId = top?.flagId;
    holdTimer.current = setTimeout(() => {
      holdTimer.current = null; setHolding(false);
      // Re-check with current values: same top card, still deletable, nothing in flight. Otherwise cancel silently.
      const now = live.current;
      if (!heldId || now.topId !== heldId || !now.canDelete || now.busy) return;
      void decide('delete', false);
    }, HOLD_MS);
  }
  function endHold() {
    if (holdTimer.current) { clearTimeout(holdTimer.current); holdTimer.current = null; }
    setHolding(false);
  }
  function holdKey(event: ReactKeyboardEvent<HTMLButtonElement>, down: boolean) {
    if (event.key !== ' ' && event.key !== 'Enter') return;
    event.preventDefault();
    if (down && !event.repeat) startHold(); else if (!down) endHold();
  }

  const doneDots = Math.min(decided, 6);
  const restDots = Math.min(Math.max(stack.length, 0), 12 - doneDots);
  return <section className="deck-col" aria-labelledby="deck-title">
    <div className="deck-head">
      <div><h2 className="sec-title big" id="deck-title">Mesa de revisión</h2><p className="muted">Nani apartó estos comentarios. Uno a la vez: tú decides.{total > 0 && <> · <span className="count-badge">{total} por revisar</span></>}</p></div>
      <button className="btn" onClick={onShowList}><List size={16} aria-hidden="true" /> Ver en lista</button>
    </div>
    <div className="ai-row" ref={setAiRow} />
    {mode === 'dry' && <p className="deck-dry-note" role="note">Modo prueba: las acciones se simulan, no se ocultan ni borran comentarios reales.</p>}
    {loaded && <div className="dots" aria-hidden="true">{Array.from({ length: doneDots }, (_, index) => <i key={`d${index}`} className="done" />)}{Array.from({ length: restDots }, (_, index) => <i key={`r${index}`} className={index === 0 ? 'cur' : ''} />)}</div>}
    <div ref={deckRef} className="deck" onPointerEnter={() => setActive(true)} onPointerLeave={() => setActive(false)} onFocus={() => setActive(true)} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setActive(false); }}>
      {flags.slice(0, 4).map((flag) => {
        const isLeaving = leaving?.id === flag.flagId;
        const depth = isLeaving ? 0 : stack.indexOf(flag);
        const isTop = depth === 0 && !isLeaving;
        const leaveClass = isLeaving ? (leaving!.instant ? ' gone' : leaving!.dir < 0 ? ' leave-left' : leaving!.dir > 0 ? ' leave-right' : ' leave-down') : '';
        const why = reasons(flag.reasons);
        return <article key={flag.flagId} ref={isTop ? cardRef : undefined} className={`card${isTop ? ' top' : ''}${leaveClass}`} style={{ ['--depth' as string]: Math.min(depth, 3) }}
          tabIndex={isTop ? 0 : -1} aria-hidden={isTop ? undefined : true} aria-label={isTop ? `Comentario de @${flag.comment?.username || 'usuario'}. Flecha izquierda oculta, flecha derecha lo deja.` : undefined}
          onPointerDown={isTop ? onPointerDown : undefined} onPointerMove={isTop ? onPointerMove : undefined} onPointerUp={isTop ? onPointerEnd : undefined} onPointerCancel={isTop ? onPointerCancel : undefined}>
          <span className="stamp hide" aria-hidden="true">OCULTAR</span><span className="stamp ok" aria-hidden="true">ESTÁ BIEN</span>
          <div className="card-top">
            {flag.media?.thumbnailUrl ? <img src={flag.media.thumbnailUrl} alt="" draggable={false} /> : <span className="card-thumb-ph"><ImageIcon size={20} aria-hidden="true" /></span>}
            <div><b>@{flag.comment?.username || 'usuario'}</b><small>hace {ago(flag.comment?.createdAt ?? flag.createdAt)}{flag.media?.caption ? <> · en «{flag.media.caption.slice(0, 48)}{flag.media.caption.length > 48 ? '…' : ''}»</> : ' · en tu publicación'}</small></div>
          </div>
          <p className="quote">“{flag.comment?.text || 'Sin texto guardado'}”</p>
          <div className="reason">
            <span className={flag.category === 'ai_complaint' ? 'chip warn' : 'chip bad'}>{category(flag.category)}</span>
            {flag.source === 'ai' && <span className="chip ai">IA</span>}
            {why && <span className="muted reason-text">{why}</span>}
            {flag.category === 'ai_complaint' && <span className="reason-hint">{complaintHint}</span>}
          </div>
        </article>;
      })}
      {loaded && !stack.length && !leaving && <div className="done-state"><Nani state="happy" size={120} /><h3>¡Mesa limpia!</h3><p className="muted">No queda nada por revisar.</p></div>}
      {!loaded && <div className="done-state"><p className="muted">Cargando comentarios marcados…</p></div>}
    </div>
    {(!loaded || stack.length > 0 || leaving) && <>
    {mode === 'real' && <p className="deck-real-note" role="note">Modo real: ocultar y borrar afectan Instagram.</p>}
    <div className="deck-actions" aria-label="Decidir sobre el comentario de arriba" role="group">
      <button className="round hide" aria-label="Ocultar" disabled={!allowed?.hide || busy} onClick={() => void decide('hide', false)}><EyeOff size={24} aria-hidden="true" /><span className="round-label">Ocultar</span></button>
      <button className={holding ? 'round del holding' : 'round del'} aria-label="Mantén presionado para borrar" disabled={!allowed?.delete || busy}
        onPointerDown={startHold} onPointerUp={endHold} onPointerLeave={endHold} onPointerCancel={endHold} onKeyDown={(event) => holdKey(event, true)} onKeyUp={(event) => holdKey(event, false)} onBlur={endHold}>
        <span className="fill" aria-hidden="true" /><Trash2 size={20} aria-hidden="true" /><span className="round-label">Mantén para borrar</span></button>
      <button className="round ok" aria-label="Está bien" disabled={!allowed?.dismiss || busy} onClick={() => void decide('dismiss', false)}><Check size={24} aria-hidden="true" /><span className="round-label">Está bien</span></button>
    </div>
    <div className="actions-legend"><span><kbd>←</kbd> ocultar</span><span><kbd>→</kbd> está bien</span><span>o arrastra la tarjeta</span></div>
    </>}
  </section>;
}
