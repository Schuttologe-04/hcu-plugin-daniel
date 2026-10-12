import { randomUUID } from 'node:crypto';

export interface IdProvider {
  nextId(): string;
}

/** Randomness stays at this infrastructure boundary, outside engine decisions. */
export class RandomIdProvider implements IdProvider {
  nextId(): string { return randomUUID(); }
}
