export function redactSecrets(value: string, secrets: readonly string[] = []): string {
  let safe = value;
  for (const secret of secrets) {
    if (secret) safe = safe.split(secret).join('[REDACTED]');
  }
  return safe.replace(/Bearer\s+[^\s"']+/giu, 'Bearer [REDACTED]');
}
