import { describe, expect, it } from 'vitest';
import { PriorityScheduler, type PriorityCandidate } from '../../../src/load-management/priority-scheduler.js';

const garage: PriorityCandidate = { chargerId: 'garage', priority: 1 };
const links: PriorityCandidate = { chargerId: 'links', priority: 20 };
const rechts: PriorityCandidate = { chargerId: 'rechts', priority: 20 };
const all = [garage, links, rechts];

describe('PriorityScheduler', () => {
  it('reduces lower charging priorities first', () => {
    expect(new PriorityScheduler(all).select(all, 'reduce')).toBe('links');
  });

  it('recovers higher charging priorities first', () => {
    expect(new PriorityScheduler(all).select(all, 'recover')).toBe('garage');
  });

  it('alternates equal-priority chargers over multiple decisions', () => {
    const scheduler = new PriorityScheduler(all);
    expect(Array.from({ length: 6 }, () => scheduler.select(all, 'reduce'))).toEqual([
      'links', 'rechts', 'links', 'rechts', 'links', 'rechts',
    ]);
  });

  it('skips idle, minimum-current or other filtered-out peers without losing the ring position', () => {
    const scheduler = new PriorityScheduler(all);
    expect(scheduler.select([links, rechts], 'reduce')).toBe('links');
    expect(scheduler.select([rechts], 'reduce')).toBe('rechts');
    expect(scheduler.select([links, rechts], 'reduce')).toBe('links');
    expect(scheduler.select([links], 'reduce')).toBe('links');
    expect(scheduler.select([links, rechts], 'reduce')).toBe('rechts');
  });

  it('keeps the configured order when a previously idle charger becomes eligible', () => {
    const scheduler = new PriorityScheduler(all);
    expect(scheduler.select([rechts], 'reduce')).toBe('rechts');
    expect(scheduler.select([links, rechts], 'reduce')).toBe('links');
  });

  it('follows configuration order rather than alphabetic id order', () => {
    const scheduler = new PriorityScheduler([rechts, links]);
    expect(scheduler.select([links, rechts], 'reduce')).toBe('rechts');
    expect(scheduler.select([links, rechts], 'reduce')).toBe('links');
  });

  it('keeps independent round-robin cursors for reducing and recovering', () => {
    const scheduler = new PriorityScheduler(all);
    expect(scheduler.select([links, rechts], 'reduce')).toBe('links');
    expect(scheduler.select([links, rechts], 'recover')).toBe('links');
    expect(scheduler.select([links, rechts], 'reduce')).toBe('rechts');
    expect(scheduler.select([links, rechts], 'recover')).toBe('rechts');
  });

  it('keeps independent cursors for different priority groups', () => {
    const additional = { chargerId: 'second-high', priority: 1 };
    const scheduler = new PriorityScheduler([...all, additional]);
    expect(scheduler.select([garage, additional], 'reduce')).toBe('garage');
    expect(scheduler.select([links, rechts], 'reduce')).toBe('links');
    expect(scheduler.select([garage, additional], 'reduce')).toBe('second-high');
    expect(scheduler.select([links, rechts], 'reduce')).toBe('rechts');
  });

  it('does not advance a cursor on an empty decision', () => {
    const scheduler = new PriorityScheduler(all);
    expect(scheduler.select([links, rechts], 'reduce')).toBe('links');
    expect(scheduler.select([], 'reduce')).toBeNull();
    expect(scheduler.select([links, rechts], 'reduce')).toBe('rechts');
  });

  it('can reset cursors while preserving the configured order', () => {
    const scheduler = new PriorityScheduler([rechts, links]);
    expect(scheduler.select([links, rechts], 'reduce')).toBe('rechts');
    scheduler.reset();
    expect(scheduler.select([links, rechts], 'reduce')).toBe('rechts');
  });

  it('supports first-seen candidate order when no configuration is provided', () => {
    const scheduler = new PriorityScheduler();
    expect(scheduler.select([links, rechts], 'reduce')).toBe('links');
    expect(scheduler.select([links, rechts], 'reduce')).toBe('rechts');
  });

  it('does not mutate the candidate array or entries', () => {
    const candidates = Object.freeze([Object.freeze(links), Object.freeze(rechts)]);
    expect(new PriorityScheduler(candidates).select(candidates, 'reduce')).toBe('links');
    expect(candidates).toEqual([links, rechts]);
  });
});
