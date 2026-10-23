import { describe, expect, it } from 'vitest';
import { resolveConsensusRequest } from '../src/orchestrator/consensus-profile.js';
import type { ConsensusProfileConfig } from '../src/config.js';

const profiles: Record<string, ConsensusProfileConfig> = {
  default: {
    panelists: ['bot-a', 'bot-b', 'bot-c'],
    synthesizerBot: 'bot-d',
    type: 'architectural',
    stakes: 'medium',
    costCapUsd: 5,
    maxRounds: 5,
  },
};

describe('resolveConsensusRequest', () => {
  it('loads panelists and synthesis settings from a named profile', () => {
    const request = resolveConsensusRequest(
      {
        profile: 'default',
        problem: 'Should this design ship?',
      },
      profiles,
    );

    expect(request).toMatchObject({
      profileName: 'default',
      bots: ['bot-a', 'bot-b', 'bot-c'],
      problem: 'Should this design ship?',
      type: 'architectural',
      stakes: 'medium',
      costCapUsd: 5,
      maxRounds: 5,
      synthesizerBot: 'bot-d',
    });
  });

  it('lets explicit call-time values override profile defaults', () => {
    const request = resolveConsensusRequest(
      {
        profile: 'default',
        bots: ['bot-x', 'bot-y'],
        synthesizerBot: 'bot-z',
        type: 'empirical',
        stakes: 'high',
        costCapUsd: 1,
        maxRounds: 3,
      },
      profiles,
    );

    expect(request).toMatchObject({
      bots: ['bot-x', 'bot-y'],
      synthesizerBot: 'bot-z',
      type: 'empirical',
      stakes: 'high',
      costCapUsd: 1,
      maxRounds: 3,
    });
  });

  it('accepts panelists as an ergonomic alias for bots', () => {
    const request = resolveConsensusRequest(
      {
        panelists: [' bot-a ', '', 'bot-b'],
      },
      profiles,
    );

    expect(request.bots).toEqual(['bot-a', 'bot-b']);
  });

  it('falls back to safe protocol defaults without a profile', () => {
    const request = resolveConsensusRequest({}, profiles);

    expect(request).toMatchObject({
      type: 'architectural',
      stakes: 'medium',
    });
    expect(request.bots).toBeUndefined();
    expect(request.synthesizerBot).toBeUndefined();
  });
});
