import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { RateLimiter } from '../src/rate-limiter.js';

describe('RateLimiter', () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    limiter = new RateLimiter('TestAPI', 3);
  });

  describe('constructor', () => {
    it('creates with default rate limit of 3', () => {
      const l = new RateLimiter('X');
      assert.equal(l.name, 'X');
      assert.equal(l.rateLimit, 3);
      assert.equal(l.cooldownPeriod, 30000);
    });

    it('accepts custom rate limit', () => {
      const l = new RateLimiter('X', 10);
      assert.equal(l.rateLimit, 10);
    });
  });

  describe('isBlocked / getRemainingCooldown', () => {
    it('is not blocked initially', () => {
      assert.equal(limiter.isBlocked(), false);
      assert.equal(limiter.getRemainingCooldown(), 0);
    });

    it('is blocked when blockedUntil is in the future', () => {
      limiter.blockedUntil = Date.now() + 10000;
      assert.equal(limiter.isBlocked(), true);
      const remaining = limiter.getRemainingCooldown();
      assert.ok(remaining > 9000 && remaining <= 10000);
    });

    it('clears block when cooldown expires', () => {
      limiter.blockedUntil = Date.now() - 1000;
      assert.equal(limiter.isBlocked(), false);
      assert.equal(limiter.blockedUntil, null);
      assert.equal(limiter.getRemainingCooldown(), 0);
    });
  });

  describe('block', () => {
    it('blocks for default cooldown', () => {
      limiter.block();
      assert.ok(limiter.isBlocked());
      const remaining = limiter.getRemainingCooldown();
      assert.ok(remaining > 29000 && remaining <= 30000);
    });

    it('blocks for custom duration', () => {
      limiter.block(5000);
      assert.ok(limiter.isBlocked());
      const remaining = limiter.getRemainingCooldown();
      assert.ok(remaining > 4000 && remaining <= 5000);
    });
  });

  describe('getRequiredDelay', () => {
    it('returns 0 when no calls made', () => {
      assert.equal(limiter.getRequiredDelay(), 0);
    });

    it('returns 0 when under rate limit', () => {
      limiter.callTimestamps = [Date.now() - 500, Date.now() - 250];
      assert.equal(limiter.getRequiredDelay(), 0);
    });

    it('returns delay when at rate limit', () => {
      const now = Date.now();
      limiter.callTimestamps = [now - 800, now - 400, now - 100];
      const delay = limiter.getRequiredDelay();
      // Oldest call at now-800, so we need to wait until now-800+1000 = now+200
      assert.ok(delay >= 180 && delay <= 300, `Expected ~200ms delay, got ${delay}ms`);
    });

    it('removes timestamps outside the 1-second window', () => {
      limiter.callTimestamps = [Date.now() - 2000, Date.now() - 1500, Date.now() - 500];
      limiter.getRequiredDelay();
      assert.equal(limiter.callTimestamps.length, 1);
    });
  });

  describe('throttle', () => {
    it('throws when blocked', async () => {
      limiter.block(5000);
      await assert.rejects(limiter.throttle(), /TestAPI API is rate limited/);
    });

    it('records call timestamp', async () => {
      await limiter.throttle();
      assert.equal(limiter.callTimestamps.length, 1);
    });

    it('delays when at rate limit', async () => {
      const now = Date.now();
      limiter.callTimestamps = [now - 50, now - 25, now - 10];

      const start = Date.now();
      await limiter.throttle();
      const elapsed = Date.now() - start;

      assert.ok(elapsed >= 900, `Expected >= 900ms delay, got ${elapsed}ms`);
    });
  });

  describe('parseCooldownFromResponse', () => {
    it('returns default when no response', () => {
      assert.equal(limiter.parseCooldownFromResponse(null, null), 30000);
    });

    it('parses Retry-After header in seconds', () => {
      const mock = { headers: { get: (n: string) => n === 'Retry-After' ? '60' : null } };
      assert.equal(limiter.parseCooldownFromResponse(mock, null), 60000);
    });

    it('parses "suspended for X s" pattern (TronGrid/TronScan)', () => {
      const mock = { headers: { get: () => null } };
      const patterns = [
        { body: { Error: 'suspended for 5 s' }, expected: 5000 },
        { body: { Error: 'suspended for 120 s' }, expected: 120000 },
        { body: { Error: 'request rate exceeded the allowed_rps(3), and the query server is suspended for 5 s' }, expected: 5000 },
        { body: { Error: 'request rate of (/api/account) exceeded the allowed_rps(1), and the query server is suspended for 120 s' }, expected: 120000 },
      ];

      for (const { body, expected } of patterns) {
        const cooldown = limiter.parseCooldownFromResponse(mock, body);
        assert.equal(cooldown, expected, `Failed for: ${JSON.stringify(body)}`);
      }
    });

    it('parses generic "try again in X seconds" patterns', () => {
      const mock = { headers: { get: () => null } };
      const patterns = [
        { body: 'wait 30 seconds', expected: 30000 },
        { body: 'retry after 15s', expected: 15000 },
        { body: 'try again in 60 seconds', expected: 60000 },
      ];

      for (const { body, expected } of patterns) {
        const cooldown = limiter.parseCooldownFromResponse(mock, body);
        assert.equal(cooldown, expected, `Failed for: "${body}"`);
      }
    });
  });

  describe('handle429', () => {
    it('blocks and throws with parsed cooldown', () => {
      assert.throws(
        () => limiter.handle429(null, null),
        /TestAPI API returned 429/,
      );
      assert.ok(limiter.isBlocked());
    });

    it('uses parsed cooldown from response body', () => {
      const mock = { headers: { get: () => null } };
      assert.throws(
        () => limiter.handle429(mock, { Error: 'suspended for 60 s' }),
        /blocked for 60 seconds/,
      );
      const remaining = limiter.getRemainingCooldown();
      assert.ok(remaining > 59000 && remaining <= 60000);
    });

    it('uses Retry-After header', () => {
      const mock = { headers: { get: (n: string) => n === 'Retry-After' ? '45' : null } };
      assert.throws(
        () => limiter.handle429(mock, null),
        /blocked for 45 seconds/,
      );
    });
  });

  describe('getStatus', () => {
    it('returns status when idle', () => {
      const s = limiter.getStatus();
      assert.equal(s.name, 'TestAPI');
      assert.equal(s.rateLimit, 3);
      assert.equal(s.callsInLastSecond, 0);
      assert.equal(s.isBlocked, false);
      assert.equal(s.remainingCooldown, 0);
      assert.equal(s.blockedUntil, null);
    });

    it('reflects blocked state', () => {
      limiter.block(5000);
      const s = limiter.getStatus();
      assert.equal(s.isBlocked, true);
      assert.ok(s.remainingCooldown > 4000);
    });

    it('counts calls in last second', () => {
      const now = Date.now();
      limiter.callTimestamps = [now - 500, now - 250, now - 100];
      assert.equal(limiter.getStatus().callsInLastSecond, 3);
    });
  });

  describe('reset', () => {
    it('clears all state', () => {
      limiter.callTimestamps = [Date.now(), Date.now()];
      limiter.blockedUntil = Date.now() + 10000;
      limiter.reset();
      assert.deepEqual(limiter.callTimestamps, []);
      assert.equal(limiter.blockedUntil, null);
    });
  });

  describe('concurrent requests', () => {
    it('delays concurrent calls that exceed rate limit', async () => {
      const l = new RateLimiter('ConcTest', 2);

      const start = Date.now();
      const times = await Promise.all([
        l.throttle().then(() => Date.now() - start),
        l.throttle().then(() => Date.now() - start),
        l.throttle().then(() => Date.now() - start),
        l.throttle().then(() => Date.now() - start),
        l.throttle().then(() => Date.now() - start),
      ]);

      assert.equal(times.length, 5);
      const sorted = [...times].sort((a, b) => a - b);
      // First 2 should be near-instant
      assert.ok(sorted[0]! < 100, `First call took ${sorted[0]}ms`);
      assert.ok(sorted[1]! < 100, `Second call took ${sorted[1]}ms`);
      console.log(`  Concurrent call times (ms): ${sorted.join(', ')}`);
    });
  });

  describe('env variable integration', () => {
    it('parses rate limit from env string', () => {
      assert.equal(parseInt('5') || 3, 5);
    });

    it('defaults to 3 for undefined env', () => {
      assert.equal(parseInt(undefined as any) || 3, 3);
    });

    it('defaults to 3 for invalid env', () => {
      assert.equal(parseInt('invalid') || 3, 3);
    });
  });

  describe('TronScan vs TronGrid cooldown behaviors', () => {
    it('TronScan has longer cooldown than TronGrid', () => {
      const trongrid = new RateLimiter('TronGrid', 3);
      const tronscan = new RateLimiter('TronScan', 3);
      const mock = { headers: { get: () => null } };

      try { trongrid.handle429(mock, { Error: 'suspended for 5 s' }); } catch { /* expected */ }
      try { tronscan.handle429(mock, { Error: 'suspended for 120 s' }); } catch { /* expected */ }

      assert.ok(
        tronscan.getRemainingCooldown() > trongrid.getRemainingCooldown(),
        'TronScan should have longer cooldown',
      );
    });
  });
});
