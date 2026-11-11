import type { McpCounters } from '../limits.js';

/** In-memory McpCounters for tests (no Redis). Set `down` to simulate an outage. */
export class FakeCounters implements McpCounters {
  readonly values = new Map<string, number>();
  down = false;
  async incr(key: string, _expireAtSec: number): Promise<number> {
    if (this.down) throw new Error('redis down');
    const n = (this.values.get(key) ?? 0) + 1;
    this.values.set(key, n);
    return n;
  }
}
