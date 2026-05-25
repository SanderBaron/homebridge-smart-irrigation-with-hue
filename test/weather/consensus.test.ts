import { applyConsensus } from '../../src/weather/consensus';
import type { ConsensusVote } from '../../src/weather/types';

const block = (source: ConsensusVote['source'], reason?: string): ConsensusVote => {
  const vote: ConsensusVote = { source, blocked: true };
  if (reason !== undefined) {
    vote.reason = reason;
  }
  return vote;
};

const pass = (source: ConsensusVote['source']): ConsensusVote => ({ source, blocked: false });

describe('applyConsensus — empty input', () => {
  it.each(['any', 'majority', 'all'] as const)(
    'returns not blocked for empty votes (%s)',
    (strategy) => {
      const decision = applyConsensus([], strategy);
      expect(decision.blocked).toBe(false);
      expect(decision.totalVotes).toBe(0);
      expect(decision.blockingVotes).toBe(0);
      expect(decision.explanation).toContain('no sources reported');
    },
  );
});

describe('applyConsensus — any strategy', () => {
  it('blocks when one of three sources votes block', () => {
    const decision = applyConsensus(
      [block('open-meteo', 'rain 8mm'), pass('buienradar'), pass('openweathermap')],
      'any',
    );
    expect(decision.blocked).toBe(true);
    expect(decision.blockingVotes).toBe(1);
    expect(decision.explanation).toContain('open-meteo');
  });

  it('does not block when no source votes block', () => {
    const decision = applyConsensus([pass('open-meteo'), pass('buienradar')], 'any');
    expect(decision.blocked).toBe(false);
  });
});

describe('applyConsensus — majority strategy', () => {
  it('blocks on strict majority (2 of 3)', () => {
    const decision = applyConsensus(
      [block('open-meteo'), block('buienradar'), pass('openweathermap')],
      'majority',
    );
    expect(decision.blocked).toBe(true);
    expect(decision.blockingVotes).toBe(2);
  });

  it('does not block on a 1-of-2 tie', () => {
    const decision = applyConsensus([block('open-meteo'), pass('buienradar')], 'majority');
    expect(decision.blocked).toBe(false);
    expect(decision.explanation).toContain('not met');
  });

  it('blocks with a single vote (1 > 0.5)', () => {
    const decision = applyConsensus([block('open-meteo')], 'majority');
    expect(decision.blocked).toBe(true);
  });
});

describe('applyConsensus — all strategy', () => {
  it('blocks only when every vote is blocking', () => {
    const decision = applyConsensus(
      [block('open-meteo'), block('buienradar'), block('openweathermap')],
      'all',
    );
    expect(decision.blocked).toBe(true);
  });

  it('does not block if any vote is non-blocking', () => {
    const decision = applyConsensus(
      [block('open-meteo'), block('buienradar'), pass('openweathermap')],
      'all',
    );
    expect(decision.blocked).toBe(false);
  });

  it('returns not blocked for an empty vote list (vacuous truth disabled)', () => {
    const decision = applyConsensus([], 'all');
    expect(decision.blocked).toBe(false);
  });
});

describe('applyConsensus — explanation', () => {
  it('lists blocking sources with their reasons', () => {
    const decision = applyConsensus(
      [block('open-meteo', '8mm past 24h'), block('buienradar', '6 m/s NW')],
      'any',
    );
    expect(decision.explanation).toContain('open-meteo (8mm past 24h)');
    expect(decision.explanation).toContain('buienradar (6 m/s NW)');
  });

  it('does not include reasons when none provided', () => {
    const decision = applyConsensus([block('open-meteo')], 'any');
    expect(decision.explanation).not.toContain('()');
  });
});
