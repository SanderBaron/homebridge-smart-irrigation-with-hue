import { applyConsensus, type ConsensusDecision } from './weather/consensus';
import type { ConsensusStrategy, ConsensusVote, WeatherSnapshot } from './weather/types';
import type { CompassOctant, RainBlockingConfig, Zone } from './types';

const OCTANTS: readonly CompassOctant[] = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

/**
 * Map a compass bearing (0..359°, the direction wind is *from*) to one of the
 * eight 45° octants. The N band straddles the 0/360 boundary and covers
 * 337.5°–22.5° inclusive of the lower edge and exclusive of the upper.
 */
export function degreesToOctant(degrees: number): CompassOctant {
  const normalised = ((degrees % 360) + 360) % 360;
  // Shifting by 22.5° rotates the octant boundaries to align with 0..360/8 bands.
  const shifted = (normalised + 22.5) % 360;
  const index = Math.floor(shifted / 45);
  return OCTANTS[index] ?? 'N';
}

/**
 * Evaluate the wind-blocking condition for a zone across all available weather
 * snapshots, then combine the per-source votes with the given consensus
 * strategy.
 *
 * A source abstains (no vote) when it lacks either wind speed or wind
 * direction. A source's vote is `blocked: true` when the wind is blowing from
 * one of the zone's configured blocked octants AND speed is at or above the
 * threshold.
 *
 * Returns `undefined` when wind blocking is disabled for the zone.
 */
export function evaluateWindBlocking(
  zone: Zone,
  snapshots: WeatherSnapshot[],
  strategy: ConsensusStrategy,
): ConsensusDecision | undefined {
  const cfg = zone.windBlocking;
  if (!cfg?.enabled) {
    return undefined;
  }

  const blockedSet = new Set(cfg.blockedOctants);
  const votes: ConsensusVote[] = [];
  for (const snap of snapshots) {
    if (typeof snap.windSpeedMs !== 'number' || typeof snap.windDirectionDeg !== 'number') {
      continue;
    }
    const octant = degreesToOctant(snap.windDirectionDeg);
    const fromBlockedOctant = blockedSet.has(octant);
    const overSpeed = snap.windSpeedMs >= cfg.minimumWindSpeedMs;
    const blocked = fromBlockedOctant && overSpeed;

    const vote: ConsensusVote = { source: snap.source, blocked };
    if (blocked) {
      vote.reason = `wind ${snap.windSpeedMs.toFixed(1)} m/s from ${octant}`;
    }
    votes.push(vote);
  }

  return applyConsensus(votes, strategy);
}

/**
 * Evaluate the global rain-skip condition across all available weather
 * snapshots, then combine the per-source votes with the given consensus
 * strategy.
 *
 * Rain blocking is global (not per-zone) from v0.2 onward — rain falls the
 * same everywhere on a single irrigation rig. The verdict applies to every
 * zone the platform asks about.
 *
 * A source abstains when it has neither past-24h nor next-12h rainfall. A
 * source's vote is `blocked: true` when at least one available value meets or
 * exceeds the corresponding threshold.
 *
 * Returns `undefined` when rain blocking is disabled (no config or
 * `enabled: false`).
 */
export function evaluateRainBlocking(
  cfg: RainBlockingConfig | undefined,
  snapshots: WeatherSnapshot[],
  strategy: ConsensusStrategy,
): ConsensusDecision | undefined {
  if (!cfg?.enabled) {
    return undefined;
  }

  const votes: ConsensusVote[] = [];
  for (const snap of snapshots) {
    const hasPast = typeof snap.rainLast24hMm === 'number';
    const hasNext = typeof snap.rainNext12hMm === 'number';
    if (!hasPast && !hasNext) {
      continue;
    }

    const reasons: string[] = [];
    if (hasPast && snap.rainLast24hMm! >= cfg.past24hThresholdMm) {
      reasons.push(`${snap.rainLast24hMm!.toFixed(1)}mm past 24h`);
    }
    if (hasNext && snap.rainNext12hMm! >= cfg.next12hThresholdMm) {
      reasons.push(`${snap.rainNext12hMm!.toFixed(1)}mm forecast 12h`);
    }

    const blocked = reasons.length > 0;
    const vote: ConsensusVote = { source: snap.source, blocked };
    if (blocked) {
      vote.reason = reasons.join(', ');
    }
    votes.push(vote);
  }

  return applyConsensus(votes, strategy);
}

export interface ZoneBlockingDecision {
  /** Final verdict — true if either wind or rain consensus blocked. */
  blocked: boolean;
  /** Wind consensus, present only when wind blocking is enabled on the zone. */
  wind?: ConsensusDecision;
  /** Rain consensus, present only when rain blocking is enabled on the zone. */
  rain?: ConsensusDecision;
}

/**
 * Combined evaluator: runs both blocking checks and aggregates the result.
 *
 * The zone is blocked when *either* wind or rain consensus blocks. Returning
 * the individual decisions lets the caller render override switches (one per
 * condition) and log explanations independently — the Phase 7 platform code
 * needs this distinction.
 */
export function evaluateZoneBlocking(
  zone: Zone,
  rainCfg: RainBlockingConfig | undefined,
  snapshots: WeatherSnapshot[],
  strategy: ConsensusStrategy,
): ZoneBlockingDecision {
  const wind = evaluateWindBlocking(zone, snapshots, strategy);
  const rain = evaluateRainBlocking(rainCfg, snapshots, strategy);
  const blocked = (wind?.blocked ?? false) || (rain?.blocked ?? false);

  const decision: ZoneBlockingDecision = { blocked };
  if (wind !== undefined) {
    decision.wind = wind;
  }
  if (rain !== undefined) {
    decision.rain = rain;
  }
  return decision;
}
