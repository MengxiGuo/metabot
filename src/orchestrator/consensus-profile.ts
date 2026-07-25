import type { ConsensusProfileConfig } from '../config.js';
import type { ProblemType, Stakes } from './types.js';

export interface ResolvedConsensusRequest {
  profileName?: string;
  bots?: string[];
  problem?: string;
  type: ProblemType;
  stakes: Stakes;
  costCapUsd?: number;
  maxRounds?: number;
  chatId?: string;
  callerBotName?: string;
  synthesizerBot?: string;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) return undefined;
  return value.map((v) => v.trim()).filter(Boolean);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function resolveConsensusRequest(
  body: Record<string, unknown>,
  profiles: Record<string, ConsensusProfileConfig> = {},
): ResolvedConsensusRequest {
  const profileName = optionalString(body.profile);
  const profile = profileName ? profiles[profileName] : undefined;
  const explicitBots = stringArray(body.bots) ?? stringArray(body.panelists);
  const explicitSynthesizer = optionalString(body.synthesizerBot);

  const resolved: ResolvedConsensusRequest = {
    ...(profileName ? { profileName } : {}),
    bots: explicitBots ?? profile?.panelists,
    problem: optionalString(body.problem),
    type: (optionalString(body.type) ?? profile?.type ?? 'architectural') as ProblemType,
    stakes: (optionalString(body.stakes) ?? profile?.stakes ?? 'medium') as Stakes,
    costCapUsd: optionalNumber(body.costCapUsd) ?? profile?.costCapUsd,
    maxRounds: optionalNumber(body.maxRounds) ?? profile?.maxRounds,
    chatId: optionalString(body.chatId),
    callerBotName: optionalString(body.callerBotName),
    synthesizerBot: explicitSynthesizer ?? profile?.synthesizerBot,
  };

  return resolved;
}
