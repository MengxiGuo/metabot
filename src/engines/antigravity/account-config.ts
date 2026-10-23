import type { AntigravityBotConfig } from '../../config.js';

export interface ResolvedAntigravityAccount {
  alias: string;
  runner: string;
}

export function listAntigravityAccounts(config?: AntigravityBotConfig): string[] {
  return Object.keys(config?.accounts ?? {});
}

/**
 * Resolve only an explicitly selected account or the configured default.
 * This function deliberately contains no quota/error based fallback logic.
 */
export function resolveAntigravityAccount(
  config: AntigravityBotConfig | undefined,
  selectedAccount?: string,
): ResolvedAntigravityAccount | undefined {
  const accounts = config?.accounts;
  if (!accounts || Object.keys(accounts).length === 0) {
    if (selectedAccount) {
      throw new Error('The selected Antigravity account is no longer configured. Use /account to choose again.');
    }
    return undefined;
  }

  const alias = selectedAccount ?? config?.defaultAccount;
  const account = alias ? accounts[alias] : undefined;
  if (!alias || !account) {
    throw new Error('The selected Antigravity account is no longer configured. Use /account to choose again.');
  }
  return { alias, runner: account.runner };
}
