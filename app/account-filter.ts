/**
 * Decides whether the global account filter should move from "all" to the only existing account.
 * Returns the account id to select, or null to leave the filter untouched (never overrides a user choice).
 */
export function autoSelectAccount(input: { filter: string; userChose: boolean; accountIds: string[] }): string | null {
  if (input.userChose || input.filter !== 'all' || input.accountIds.length !== 1) return null;
  return input.accountIds[0]!;
}
