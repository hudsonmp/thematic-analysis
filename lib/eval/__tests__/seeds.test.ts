import { describe, expect, it } from 'vitest';
import { METRIC_DRAFT, ORACLE_SPEC_DRAFT, sha256Hex } from '@/lib/eval/seeds';

describe('sha256Hex', () => {
  it('hashes the empty string to the well-known sha256 digest', () => {
    expect(sha256Hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('is deterministic — same input, same digest', () => {
    expect(sha256Hex(ORACLE_SPEC_DRAFT)).toBe(sha256Hex(ORACLE_SPEC_DRAFT));
    expect(sha256Hex(METRIC_DRAFT)).toBe(sha256Hex(METRIC_DRAFT));
  });

  it('returns lowercase 64-char hex', () => {
    expect(sha256Hex('abc')).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256Hex(ORACLE_SPEC_DRAFT)).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256Hex(METRIC_DRAFT)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('distinguishes distinct inputs (the two drafts hash differently)', () => {
    expect(sha256Hex(ORACLE_SPEC_DRAFT)).not.toBe(sha256Hex(METRIC_DRAFT));
  });
});

describe('ORACLE_SPEC_DRAFT', () => {
  it('carries the DRAFT marker', () => {
    expect(ORACLE_SPEC_DRAFT).toContain('DRAFT');
  });

  it('covers all four authored scenarios', () => {
    expect(ORACLE_SPEC_DRAFT).toContain('Scenario 1');
    expect(ORACLE_SPEC_DRAFT).toContain('Scenario 2');
    expect(ORACLE_SPEC_DRAFT).toContain('Scenario 3');
    expect(ORACLE_SPEC_DRAFT).toContain('Scenario 4');
  });

  it('calls out the open silence-handling decision', () => {
    expect(ORACLE_SPEC_DRAFT).toContain('SILENCE HANDLING');
  });

  it('is grounded in the authored study content (locations, battery threshold)', () => {
    expect(ORACLE_SPEC_DRAFT).toContain('Lane Field');
    expect(ORACLE_SPEC_DRAFT).toContain('Newman Library');
    expect(ORACLE_SPEC_DRAFT).toContain('15%');
  });
});

describe('METRIC_DRAFT', () => {
  it('carries the DRAFT marker', () => {
    expect(METRIC_DRAFT).toContain('DRAFT');
  });

  it('defines the per-clause verdict vocabulary', () => {
    expect(METRIC_DRAFT).toContain('satisfied');
    expect(METRIC_DRAFT).toContain('unclear');
  });

  it('defines the improvement metric', () => {
    expect(METRIC_DRAFT).toContain('Improvement metric');
  });
});
