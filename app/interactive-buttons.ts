/**
 * The experimental interactive buttons (follow gate phase 0) were RETIRED: their buttons did nothing when tapped.
 * Only the read-only «Inspeccionar conversación» helper and the Spanish label of the API rejection remain here.
 */

export const INTERACTIVE_RETIRED_LABEL = 'Los botones interactivos experimentales fueron retirados; use «Pedir primero que me sigan».';

export function directionLabel(direction: string): string {
  return direction === 'account' ? 'Cuenta' : direction === 'user' ? 'Usuario' : 'Desconocido';
}
