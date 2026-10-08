export type OnboardingStepId = 'connect' | 'account' | 'automation' | 'monitor';
export type OnboardingState = 'done' | 'current' | 'pending';
export type OnboardingStep = { id: OnboardingStepId; label: string; detail: string; actionLabel: string; target: string; state: OnboardingState };
export type OnboardingInput = {
  connections: Array<{ status: string }>;
  accounts: Array<unknown>;
  automations: Array<{ status: string }>;
  monitoringEnabled: boolean;
};

const STEPS: Array<Omit<OnboardingStep, 'state'>> = [
  { id: 'connect', label: 'Conectar Meta', detail: 'Guarde un token y valídelo con "Probar y descubrir".', actionLabel: 'Ir a Conexiones', target: 'connections' },
  { id: 'account', label: 'Elegir cuenta', detail: 'Seleccione la cuenta de Instagram que desea administrar.', actionLabel: 'Elegir cuenta', target: 'connections' },
  { id: 'automation', label: 'Crear automatización', detail: 'Asocie palabras clave y una respuesta a una publicación.', actionLabel: 'Crear automatización', target: 'automations' },
  { id: 'monitor', label: 'Iniciar monitoreo', detail: 'Empiece a vigilar comentarios nuevos (en modo prueba no se envía nada).', actionLabel: 'Ir a Monitoreo', target: 'monitor' },
];

export function deriveOnboarding(input: OnboardingInput): { steps: OnboardingStep[]; allDone: boolean } {
  const accountDone = input.accounts.length > 0;
  const done: Record<OnboardingStepId, boolean> = {
    // An existing selected account implies a connection was validated at some point.
    connect: accountDone || input.connections.some((connection) => connection.status === 'valid'),
    account: accountDone,
    automation: input.automations.some((automation) => automation.status !== 'archived'),
    monitor: input.monitoringEnabled,
  };
  let currentAssigned = false;
  const steps = STEPS.map((step): OnboardingStep => {
    if (done[step.id]) return { ...step, state: 'done' };
    if (!currentAssigned) { currentAssigned = true; return { ...step, state: 'current' }; }
    return { ...step, state: 'pending' };
  });
  return { steps, allDone: !currentAssigned };
}

/**
 * The checklist hides while the user deliberately narrowed the view to one of several accounts.
 * A filter pointing at the only existing account (auto-selected) must not hide it.
 */
export function showOnboarding(input: { allDone: boolean; filter: string; accountCount: number }): boolean {
  return !input.allDone && (input.filter === 'all' || input.accountCount <= 1);
}
