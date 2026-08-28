import type { Disposable, Listener } from './types';

export class EventBus {
  private readonly listeners = new Map<string, Set<Listener>>();

  on(event: string, listener: Listener): Disposable {
    let listeners = this.listeners.get(event);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(event, listeners);
    }

    listeners.add(listener);
    let active = true;

    return () => {
      if (!active) return;
      active = false;
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(event);
    };
  }

  emit(event: string, ...args: unknown[]): void {
    const listeners = this.listeners.get(event);
    if (!listeners) return;

    for (const listener of listeners) listener(...args);
  }

  clear(): void {
    this.listeners.clear();
  }
}

export { EventBus as Events };
