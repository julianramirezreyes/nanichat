'use client';

import { type ReactNode, createContext, useContext } from 'react';
import { createPortal } from 'react-dom';

/**
 * Presentational portals: a view keeps its own state and handlers but renders some controls in a region owned by
 * the shell (the topbar actions) or by a sibling pane (the moderation AI row). Nothing here touches data.
 */
export type SlotTargets = { topbar: HTMLElement | null; aiRow: HTMLElement | null };

export const SlotContext = createContext<SlotTargets>({ topbar: null, aiRow: null });

function Portal({ target, children }: { target: HTMLElement | null; children: ReactNode }) {
  return target ? createPortal(children, target) : null;
}

/** Primary actions of the current page, rendered on the right of the sticky topbar. */
export function PageActions({ children }: { children: ReactNode }) {
  return <Portal target={useContext(SlotContext).topbar}>{children}</Portal>;
}

/** Controls rendered in the moderation list header row (AI review run + progress). */
export function AiRowSlot({ children }: { children: ReactNode }) {
  return <Portal target={useContext(SlotContext).aiRow}>{children}</Portal>;
}
