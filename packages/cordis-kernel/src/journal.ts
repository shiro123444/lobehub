import type { RuntimeEvent } from './run';
import type { Disposable } from './types';

export type EventJournalErrorCode = 'EVENT_SEQ_INVALID';

export class EventJournalError extends Error {
  constructor(
    public readonly code: EventJournalErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'EventJournalError';
  }
}

export type EventListener = (event: RuntimeEvent) => void;

export interface EventJournalPort {
  append: (runId: string, event: RuntimeEvent) => RuntimeEvent;
  replay: (runId: string, afterSeq?: number) => RuntimeEvent[];
  subscribe: (runId: string, listener: EventListener) => Disposable;
}

interface Subscription {
  readonly listener: EventListener;
}

const copyEvent = (event: RuntimeEvent): RuntimeEvent => ({ ...event });

export class EventJournal implements EventJournalPort {
  private readonly events = new Map<string, RuntimeEvent[]>();
  private readonly subscriptions = new Map<string, Set<Subscription>>();

  append(runId: string, event: RuntimeEvent): RuntimeEvent {
    if (!Number.isInteger(event.seq) || event.seq < 1) {
      throw new EventJournalError(
        'EVENT_SEQ_INVALID',
        `Event sequence must be a positive integer: ${event.seq}`,
      );
    }

    const stream = this.events.get(runId) ?? [];
    const latest = stream.at(-1);
    if (latest && event.seq === latest.seq) return copyEvent(latest);
    if (latest && event.seq < latest.seq) {
      throw new EventJournalError(
        'EVENT_SEQ_INVALID',
        `Event sequence ${event.seq} is behind latest sequence ${latest.seq}`,
      );
    }

    const stored = copyEvent(event);
    stream.push(stored);
    this.events.set(runId, stream);

    for (const { listener } of this.subscriptions.get(runId) ?? []) {
      listener(copyEvent(stored));
    }

    return copyEvent(stored);
  }

  replay(runId: string, afterSeq = 0): RuntimeEvent[] {
    return (this.events.get(runId) ?? []).filter((event) => event.seq > afterSeq).map(copyEvent);
  }

  subscribe(runId: string, listener: EventListener): Disposable {
    const subscription: Subscription = { listener };
    const subscriptions = this.subscriptions.get(runId) ?? new Set<Subscription>();
    subscriptions.add(subscription);
    this.subscriptions.set(runId, subscriptions);

    let active = true;
    return () => {
      if (!active) return;
      active = false;
      subscriptions.delete(subscription);
      if (subscriptions.size === 0) this.subscriptions.delete(runId);
    };
  }

  has(runId: string): boolean {
    return this.events.has(runId);
  }
}

export { EventJournal as InMemoryEventJournal };
