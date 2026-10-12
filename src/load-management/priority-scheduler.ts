export interface PriorityCandidate {
  readonly chargerId: string;
  readonly priority: number;
}

export type SchedulingDirection = 'reduce' | 'recover';

/** Configuration-order rings survive temporary ineligibility of a member. */
export class PriorityScheduler {
  private readonly rings = new Map<number, string[]>();
  private readonly cursors = new Map<SchedulingDirection, Map<number, string>>();

  constructor(configuredCandidates: readonly PriorityCandidate[] = []) {
    this.remember(configuredCandidates);
  }

  /** Call only when an action will actually be emitted for the returned id. */
  select(candidates: readonly PriorityCandidate[], direction: SchedulingDirection): string | null {
    if (candidates.length === 0) return null;
    this.remember(candidates);
    const priorities = candidates.map(({ priority }) => priority);
    const priority = direction === 'reduce' ? Math.max(...priorities) : Math.min(...priorities);
    const ring = this.rings.get(priority);
    if (ring === undefined) return null;

    const eligible = new Set(
      candidates.filter((candidate) => candidate.priority === priority).map(({ chargerId }) => chargerId),
    );
    const directionCursors = this.cursors.get(direction) ?? new Map<number, string>();
    const previous = directionCursors.get(priority);
    const previousIndex = previous === undefined ? -1 : ring.indexOf(previous);

    for (let offset = 1; offset <= ring.length; offset += 1) {
      const id = ring[(previousIndex + offset) % ring.length];
      if (id !== undefined && eligible.has(id)) {
        directionCursors.set(priority, id);
        this.cursors.set(direction, directionCursors);
        return id;
      }
    }
    return null;
  }

  /** Reset fairness cursors while keeping the configured order. */
  reset(): void {
    this.cursors.clear();
  }

  private remember(candidates: readonly PriorityCandidate[]): void {
    for (const { chargerId, priority } of candidates) {
      const ring = this.rings.get(priority) ?? [];
      if (!ring.includes(chargerId)) ring.push(chargerId);
      this.rings.set(priority, ring);
    }
  }
}
