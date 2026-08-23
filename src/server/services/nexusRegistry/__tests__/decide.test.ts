import { describe, expect, it } from 'vitest';

import {
  decideReview,
  parseThresholds,
  parseTrustedUpstreams,
  type DecisionInput,
} from '../decide';

const baseInput = (overrides: Partial<DecisionInput> = {}): DecisionInput => ({
  staticFlags: [],
  verdict: undefined,
  riskScore: 0,
  isOfficialSource: false,
  upstreamOwner: undefined,
  trustedUpstreams: [],
  thresholds: { blockMin: 70, passMax: 30 },
  ...overrides,
});

describe('decideReview', () => {
  describe('auto-reject (hard rules)', () => {
    it('rejects when the static scan flags a possible secret', () => {
      const decision = decideReview(baseInput({ staticFlags: ['possible-secret'] }));
      expect(decision).toMatchObject({ action: 'reject', actor: 'auto', automated: true });
    });

    it('rejects even when the LLM verdict is pass, because possible-secret is a hard rule', () => {
      const decision = decideReview(
        baseInput({ staticFlags: ['possible-secret'], verdict: 'pass', riskScore: 0 }),
      );
      expect(decision.action).toBe('reject');
      expect(decision.automated).toBe(true);
    });

    it('rejects when verdict is block', () => {
      const decision = decideReview(baseInput({ verdict: 'block', riskScore: 40 }));
      expect(decision).toMatchObject({ action: 'reject', automated: true });
    });

    it('rejects when riskScore reaches blockMin', () => {
      const decision = decideReview(baseInput({ verdict: 'review', riskScore: 70 }));
      expect(decision).toMatchObject({ action: 'reject', automated: true });
    });
  });

  describe('auto-approve (trusted + safe)', () => {
    it('approves an official source with pass verdict and low risk', () => {
      const decision = decideReview(
        baseInput({ isOfficialSource: true, verdict: 'pass', riskScore: 10 }),
      );
      expect(decision).toMatchObject({ action: 'approve', automated: true });
    });

    it('approves a user source whose upstream owner is on the trusted allowlist', () => {
      const decision = decideReview(
        baseInput({
          isOfficialSource: false,
          upstreamOwner: 'lobehub',
          trustedUpstreams: ['lobehub/*'],
          verdict: 'pass',
          riskScore: 20,
        }),
      );
      expect(decision).toMatchObject({ action: 'approve', automated: true });
    });

    it('does not auto-approve an untrusted user source even with a pass verdict', () => {
      const decision = decideReview(
        baseInput({
          isOfficialSource: false,
          upstreamOwner: 'someone-else',
          verdict: 'pass',
          riskScore: 5,
        }),
      );
      expect(decision.automated).toBe(false);
    });

    it('does not auto-approve when riskScore is at the passMax boundary', () => {
      const decision = decideReview(
        baseInput({ isOfficialSource: true, verdict: 'pass', riskScore: 30 }),
      );
      expect(decision.automated).toBe(false);
    });

    it('does not auto-approve when a large-archive flag requires a human spot-check', () => {
      const decision = decideReview(
        baseInput({
          isOfficialSource: true,
          staticFlags: ['large-archive'],
          verdict: 'pass',
          riskScore: 5,
        }),
      );
      expect(decision.automated).toBe(false);
      expect(decision.action).not.toBe('reject');
    });
  });

  describe('human review queue', () => {
    it('routes a medium-risk review verdict to human review', () => {
      const decision = decideReview(baseInput({ verdict: 'review', riskScore: 50 }));
      expect(decision).toMatchObject({ action: 'request_changes', automated: false });
    });

    it('routes a trusted pass with a large archive to human review (not auto-approve)', () => {
      const decision = decideReview(
        baseInput({
          isOfficialSource: true,
          staticFlags: ['large-archive'],
          verdict: 'pass',
          riskScore: 10,
        }),
      );
      expect(decision.action).toBe('request_changes');
    });
  });

  describe('parseThresholds', () => {
    it('parses "30,70"', () => {
      expect(parseThresholds('30,70')).toEqual({ passMax: 30, blockMin: 70 });
    });

    it('falls back to defaults on garbage input', () => {
      expect(parseThresholds('garbage')).toEqual({ passMax: 30, blockMin: 70 });
    });

    it('falls back when passMax >= blockMin (inverted)', () => {
      expect(parseThresholds('80,20')).toEqual({ passMax: 30, blockMin: 70 });
    });

    it('returns defaults when undefined', () => {
      expect(parseThresholds(undefined)).toEqual({ passMax: 30, blockMin: 70 });
    });
  });

  describe('parseTrustedUpstreams', () => {
    it('parses a comma-separated allowlist, trimming whitespace', () => {
      expect(parseTrustedUpstreams('lobehub/*, nexus-dev/*')).toEqual([
        'lobehub/*',
        'nexus-dev/*',
      ]);
    });

    it('returns an empty array for undefined', () => {
      expect(parseTrustedUpstreams(undefined)).toEqual([]);
    });
  });
});
