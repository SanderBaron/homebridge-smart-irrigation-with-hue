import type { ConsensusStrategy, ConsensusVote } from './types';

export interface ConsensusDecision {
  /** Final verdict: should the zone be blocked? */
  blocked: boolean;
  /** Strategy that was applied. */
  strategy: ConsensusStrategy;
  /** Total number of votes that contributed (failed sources are excluded by the caller). */
  totalVotes: number;
  /** Number of contributing votes that were `blocked: true`. */
  blockingVotes: number;
  /** Human-readable summary suitable for the info log. */
  explanation: string;
}

/**
 * Combine a list of per-source votes into a single block / don't-block decision.
 *
 * The caller is responsible for filtering out sources that failed to deliver
 * (timeout, HTTP error, missing metric). An empty vote list always resolves
 * to "not blocked" — the system errs on the side of watering when it has no
 * data to act on.
 *
 * Strategies:
 * - `any`      — blocked when at least one source votes to block.
 * - `majority` — blocked when a strict majority of contributing sources vote
 *                to block (ties resolve to "not blocked").
 * - `all`      — blocked when every contributing source votes to block. An
 *                empty list is never `all`, so this also resolves to false.
 */
export function applyConsensus(
  votes: ConsensusVote[],
  strategy: ConsensusStrategy,
): ConsensusDecision {
  const totalVotes = votes.length;
  const blockingVotes = votes.filter((v) => v.blocked).length;

  let blocked: boolean;
  switch (strategy) {
    case 'any':
      blocked = blockingVotes > 0;
      break;
    case 'majority':
      blocked = blockingVotes * 2 > totalVotes;
      break;
    case 'all':
      blocked = totalVotes > 0 && blockingVotes === totalVotes;
      break;
  }

  const explanation = buildExplanation(votes, strategy, totalVotes, blockingVotes, blocked);

  return { blocked, strategy, totalVotes, blockingVotes, explanation };
}

function buildExplanation(
  votes: ConsensusVote[],
  strategy: ConsensusStrategy,
  total: number,
  blocking: number,
  blocked: boolean,
): string {
  if (total === 0) {
    return `Not blocked; no sources reported (${strategy} strategy)`;
  }

  const blockingNames = votes
    .filter((v) => v.blocked)
    .map((v) => (v.reason !== undefined ? `${v.source} (${v.reason})` : v.source))
    .join(', ');

  if (blocked) {
    return `Blocked by ${blockingNames}; ${blocking} of ${total} sources voted block (${strategy} strategy)`;
  }

  if (blocking === 0) {
    return `Not blocked; 0 of ${total} sources voted block (${strategy} strategy)`;
  }

  return `Not blocked; ${blocking} of ${total} sources voted block but ${strategy} strategy was not met`;
}
