/** Stable API error code returned when selecting an account that belongs to a disconnected or deleted connection. */
export const ADOPTION_REQUIRED_CODE = 'account_adoption_required';

export const ADOPTION_PROMPT = 'Esta cuenta pertenecía a una conexión eliminada o desconectada. Al adoptarla se conservan su historial, cola y automatizaciones.';

export const ORPHAN_ADOPT_STEPS = 'Para adoptarla: cree una conexión nueva, pulse «Probar y descubrir», elija «Seleccionar» en la cuenta y confirme con «Adoptar».';

export const ORPHAN_EMPTY_TEXT = 'No hay cuentas de conexiones eliminadas o desconectadas.';

export function isAdoptionRequired(code: unknown): boolean {
  return code === ADOPTION_REQUIRED_CODE;
}

export function orphanOrigin(account: { connectionDeleted: boolean }): string {
  return account.connectionDeleted ? 'Conexión eliminada' : 'Conexión desconectada';
}
