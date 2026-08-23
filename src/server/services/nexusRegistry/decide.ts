import type { NexusSafetyRisk } from '@lobechat/database/schemas';

export type SafetyVerdict = 'block' | 'pass' | 'review';
export type ReviewAction = 'approve' | 'reject' | 'request_changes';
export type ReviewActor = 'auto' | 'human';

/** Sentinel stored as `reviewerId` when a decision is made by the auto-reviewer. */
export const AUTO_REVIEWER_ID = 'AUTO_REVIEWER';

/** Static organizer flag that always forces auto-reject, before any LLM scan. */
const POSSIBLE_SECRET_FLAG = 'possible-secret';
/** Static organizer flag that blocks auto-approve (routes to human) but does not reject. */
const LARGE_ARCHIVE_FLAG = 'large-archive';

export interface DecisionInput {
  /** organizer reviewFlags: ['possible-secret', 'large-archive', 'archive-not-inlined']. */
  staticFlags?: string[];
  verdict?: SafetyVerdict;
  /** 0–100 integer from the safety scan. */
  riskScore?: number;
  isOfficialSource: boolean;
  /** GitHub owner extracted from the upstream repo, e.g. `lobehub`. */
  upstreamOwner?: string;
  /** Parsed from NEXUS_TRUSTED_UPSTREAMS, e.g. ['lobehub/*', 'nexus-dev/*']. */
  trustedUpstreams: string[];
  thresholds: { passMax: number; blockMin: number };
}

export interface ReviewDecision {
  action: ReviewAction;
  actor: ReviewActor;
  reason: string;
  /** true when the decider can finalize this without a human (auto-approve / auto-reject). */
  automated: boolean;
  /** Risks to persist alongside the decision for audit context. */
  risks?: NexusSafetyRisk[];
}

export const DEFAULT_THRESHOLDS = { blockMin: 70, passMax: 30 };

/**
 * Parse `NEXUS_REGISTRY_RISK_THRESHOLDS=30,70` into validated thresholds.
 * Falls back to defaults on any malformation or inversion (passMax must be < blockMin).
 */
export const parseThresholds = (raw?: string): { blockMin: number; passMax: number } => {
  if (!raw) return DEFAULT_THRESHOLDS;
  const parts = raw
    .split(',')
    .map((part) => Number.parseInt(part.trim(), 10))
    .filter((part) => Number.isFinite(part));
  if (parts.length === 2) {
    const [passMax, blockMin] = parts;
    if (passMax > 0 && blockMin < 100 && passMax < blockMin) {
      return { blockMin, passMax };
    }
  }
  return DEFAULT_THRESHOLDS;
};

/** Parse `NEXUS_TRUSTED_UPSTREAMS=lobehub/*,nexus-dev/*` into a trimmed list. */
export const parseTrustedUpstreams = (raw?: string): string[] =>
  (raw ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

const isTrustedUpstream = (
  upstreamOwner: string | undefined,
  trustedUpstreams: string[],
): boolean => {
  if (!upstreamOwner) return false;
  const owner = upstreamOwner.toLowerCase().trim();
  if (!owner) return false;

  return trustedUpstreams.some((pattern) => {
    // Accept both `lobehub` and `lobehub/*` shapes.
    const normalized = pattern.toLowerCase().trim().replace(/\/\*$/, '');
    return normalized === owner;
  });
};

/**
 * Pure verdict→action decider. Priority order:
 *   1. Static `possible-secret` flag → auto-reject (hard rule, skips LLM).
 *   2. `verdict === 'block'` or `riskScore >= blockMin` → auto-reject.
 *   3. `verdict === 'pass'` && `riskScore < passMax` && trusted && no `large-archive` → auto-approve.
 *   4. Everything else → human review queue (not automated).
 *
 * `large-archive` deliberately blocks auto-approve (human spot-check) but never auto-rejects.
 */
export const decideReview = (input: DecisionInput): ReviewDecision => {
  const flags = input.staticFlags ?? [];
  const score = input.riskScore ?? 0;

  if (flags.includes(POSSIBLE_SECRET_FLAG)) {
    return {
      action: 'reject',
      actor: 'auto',
      automated: true,
      reason: 'Static scan flagged a possible secret; auto-rejected before LLM review.',
    };
  }

  if (input.verdict === 'block' || score >= input.thresholds.blockMin) {
    return {
      action: 'reject',
      actor: 'auto',
      automated: true,
      reason: `Safety scan verdict=${input.verdict ?? 'n/a'} riskScore=${score} reached the block threshold (${input.thresholds.blockMin}).`,
    };
  }

  const trusted =
    input.isOfficialSource || isTrustedUpstream(input.upstreamOwner, input.trustedUpstreams);
  const humanSpotCheck = flags.includes(LARGE_ARCHIVE_FLAG);

  if (input.verdict === 'pass' && score < input.thresholds.passMax && trusted && !humanSpotCheck) {
    return {
      action: 'approve',
      actor: 'auto',
      automated: true,
      reason: `Trusted upstream + safety scan passed (riskScore=${score}).`,
    };
  }

  return {
    action: 'request_changes',
    actor: 'auto',
    automated: false,
    reason: 'Needs human review (medium risk, untrusted source, or large archive).',
  };
};
