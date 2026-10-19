import { describe, expect, it } from 'vitest';
import { isTransientCapacity } from '../src/pipeline/transient';

describe('Oracle audio infrastructure recovery', () => {
  it('defers outages and queued work without consuming content retries', () => {
    expect(isTransientCapacity('OracleAudioUnavailable: oracle audio unavailable: request retries exhausted')).toBe(true);
    expect(isTransientCapacity('oracle audio unavailable: job still queued; retry later')).toBe(true);
  });
  it('keeps invalid media and authentication/configuration failures visible', () => {
    expect(isTransientCapacity('Oracle audio processing failed after three attempts')).toBe(false);
    expect(isTransientCapacity('Oracle audio rejected request (401)')).toBe(false);
  });
});
