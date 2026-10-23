import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ANTIGRAVITY_REASONING_EFFORTS, type AntigravityReasoningEffort, type AntigravityBotConfig } from '../../config.js';
import { resolveAntigravityAccount } from './account-config.js';
import { classifyAntigravityFailure, type AntigravityFailureKind } from './executor.js';

const execFileAsync = promisify(execFile);
const ANSI_COLOR_SEQUENCE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

export interface AntigravityModelOption {
  id: string;
  label: string;
}

export class AntigravityModelCatalogError extends Error {
  constructor(readonly kind: AntigravityFailureKind) {
    super(`Unable to load the Antigravity model catalog (${kind}).`);
    this.name = 'AntigravityModelCatalogError';
  }
}

export function parseAntigravityModelList(stdout: string): AntigravityModelOption[] {
  const models: AntigravityModelOption[] = [];
  const seen = new Set<string>();
  for (const line of stdout.split(/\r?\n/)) {
    const cleanLine = line.replace(ANSI_COLOR_SEQUENCE, '').trim();
    const match = cleanLine.match(/^([a-z0-9][a-z0-9._-]{0,127})\s+(.{1,160})$/);
    if (!match || seen.has(match[1])) continue;
    seen.add(match[1]);
    models.push({ id: match[1], label: match[2].trim() });
  }
  return models;
}

/** Load the exact catalog for the explicitly selected account. Never falls back. */
export async function fetchAntigravityModels(
  config: AntigravityBotConfig | undefined,
  selectedAccount?: string,
): Promise<AntigravityModelOption[]> {
  const account = resolveAntigravityAccount(config, selectedAccount);
  const executable = account?.runner || config?.executable || process.env.ANTIGRAVITY_EXECUTABLE_PATH || 'agy';
  try {
    const { stdout } = await execFileAsync(executable, ['models'], {
      encoding: 'utf8',
      timeout: 30_000,
      maxBuffer: 512 * 1024,
      env: { ...process.env, ...(config?.env ?? {}) },
    });
    return parseAntigravityModelList(stdout);
  } catch (error: any) {
    const stderr = typeof error?.stderr === 'string' ? error.stderr : '';
    throw new AntigravityModelCatalogError(classifyAntigravityFailure(stderr));
  }
}

/** Only offer effort variants actually present for this model family/account. */
export function antigravityEffortLevels(
  catalog: AntigravityModelOption[], model: string,
): AntigravityReasoningEffort[] {
  const base = model.replace(/-(low|medium|high|xhigh|max)$/, '');
  return ANTIGRAVITY_REASONING_EFFORTS.filter(level => catalog.some(option => option.id === `${base}-${level}`));
}
