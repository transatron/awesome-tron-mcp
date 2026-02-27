export class RateLimiter {
  name: string;
  rateLimit: number;
  callTimestamps: number[];
  blockedUntil: number | null;
  cooldownPeriod: number;

  constructor(name: string, rateLimit: number = 3) {
    this.name = name;
    this.rateLimit = rateLimit;
    this.callTimestamps = [];
    this.blockedUntil = null;
    this.cooldownPeriod = 30000; // 30 seconds default cooldown after 429
  }

  isBlocked(): boolean {
    if (!this.blockedUntil) return false;
    if (Date.now() >= this.blockedUntil) {
      this.blockedUntil = null;
      return false;
    }
    return true;
  }

  getRemainingCooldown(): number {
    if (!this.blockedUntil) return 0;
    return Math.max(0, this.blockedUntil - Date.now());
  }

  block(duration: number | null = null): void {
    const cooldown = duration || this.cooldownPeriod;
    this.blockedUntil = Date.now() + cooldown;
    const seconds = Math.ceil(cooldown / 1000);
    console.error(`[RateLimiter] ${this.name} blocked for ${seconds}s due to 429`);
  }

  getRequiredDelay(): number {
    const now = Date.now();
    const windowStart = now - 1000;

    this.callTimestamps = this.callTimestamps.filter(t => t > windowStart);

    if (this.callTimestamps.length < this.rateLimit) {
      return 0;
    }

    const oldestInWindow = this.callTimestamps[0]!;
    return Math.max(0, oldestInWindow + 1000 - now + 10);
  }

  async throttle(): Promise<void> {
    if (this.isBlocked()) {
      const waitTime = this.getRemainingCooldown();
      throw new Error(
        `${this.name} API is rate limited. Please wait ${Math.ceil(waitTime / 1000)} seconds.`
      );
    }

    const delay = this.getRequiredDelay();
    if (delay > 0) {
      console.error(`[RateLimiter] ${this.name} throttling for ${delay}ms`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }

    this.callTimestamps.push(Date.now());
  }

  parseCooldownFromResponse(response: any, body: any = null): number {
    const retryAfter = response?.headers?.get?.('Retry-After');
    if (retryAfter) {
      const seconds = parseInt(retryAfter, 10);
      if (!isNaN(seconds)) {
        return seconds * 1000;
      }
      const date = new Date(retryAfter);
      if (!isNaN(date.getTime())) {
        return Math.max(0, date.getTime() - Date.now());
      }
    }

    if (body) {
      const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);

      const trongridMatch = bodyStr.match(/suspended\s+for\s+(\d+)\s*s/i);
      if (trongridMatch) {
        return parseInt(trongridMatch[1]!, 10) * 1000;
      }

      const genericMatch = bodyStr.match(/(?:try again in|wait|retry after)\s*(\d+)\s*(?:seconds?|s)/i);
      if (genericMatch) {
        return parseInt(genericMatch[1]!, 10) * 1000;
      }
    }

    return this.cooldownPeriod;
  }

  handle429(response: any = null, body: any = null): never {
    const cooldown = this.parseCooldownFromResponse(response, body);
    this.blockedUntil = Date.now() + cooldown;
    const seconds = Math.ceil(cooldown / 1000);
    console.error(`[RateLimiter] ${this.name} blocked for ${seconds}s due to 429`);
    throw new Error(
      `${this.name} API returned 429 (rate limited). All requests blocked for ${seconds} seconds. Please wait before retrying.`
    );
  }

  getStatus(): Record<string, any> {
    const now = Date.now();
    const windowStart = now - 1000;
    const callsInWindow = this.callTimestamps.filter(t => t > windowStart).length;

    return {
      name: this.name,
      rateLimit: this.rateLimit,
      callsInLastSecond: callsInWindow,
      isBlocked: this.isBlocked(),
      remainingCooldown: this.getRemainingCooldown(),
      blockedUntil: this.blockedUntil ? new Date(this.blockedUntil).toISOString() : null,
    };
  }

  reset(): void {
    this.callTimestamps = [];
    this.blockedUntil = null;
  }
}
