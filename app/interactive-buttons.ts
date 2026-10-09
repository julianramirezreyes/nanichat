/** Experimental interactive buttons (follow gate phase 0): presentation helpers without side effects. */
export type InteractiveMode = 'none' | 'quick_reply' | 'postback';

export const INTERACTIVE_MODES: ReadonlyArray<{ value: InteractiveMode; label: string }> = [
  { value: 'none', label: 'Ninguno (comportamiento normal)' },
  { value: 'quick_reply', label: 'Respuestas rápidas (quick replies)' },
  { value: 'postback', label: 'Botones postback (dentro de la plantilla)' },
];

export const INTERACTIVE_WARNING = 'Experimental: Meta aún no confirma si acepta estos botones en la respuesta a un comentario. No se procesa el toque todavía; solo sirve para probar.';

/** Request fields for POST/PUT /api/automations: mode 'none' (or unknown) never sends titles; blank titles are dropped. */
export function interactiveRequestFields(mode: string, titles: string[]): { interactiveMode: InteractiveMode; interactiveTitles: string[] } {
  if (mode !== 'quick_reply' && mode !== 'postback') return { interactiveMode: 'none', interactiveTitles: [] };
  return { interactiveMode: mode, interactiveTitles: titles.map((title) => title.trim()).filter(Boolean) };
}

export function interactiveModeLabel(mode: string | undefined): string {
  return INTERACTIVE_MODES.find((entry) => entry.value === mode)?.label ?? 'Ninguno';
}

export function directionLabel(direction: string): string {
  return direction === 'account' ? 'Cuenta' : direction === 'user' ? 'Usuario' : 'Desconocido';
}
