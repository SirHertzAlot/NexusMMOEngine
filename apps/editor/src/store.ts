/**
 * The editor's one external store. Anything several panels share without a
 * parent in common (the active tool, the selection, the open document's
 * actions, the clipboard) is a `createStore`, so each of them gets the same
 * `get` / `set` / `subscribe` / `use` and the same change test, instead of its
 * own listener set.
 */

import * as React from "react";

export interface Store<T> {
  get: () => T;
  /** Set the value (or compute it from the last). Listeners run only when it changed. */
  set: (next: T | ((prev: T) => T)) => void;
  subscribe: (fn: () => void) => () => void;
  /** The value as React state: the component re-renders when it changes. */
  use: () => T;
}

/** `equals` decides "unchanged" (default `Object.is`), so a set with the same value is silent. */
export function createStore<T>(initial: T, equals: (a: T, b: T) => boolean = Object.is): Store<T> {
  let value = initial;
  const listeners = new Set<() => void>();
  const subscribe = (fn: () => void): (() => void) => {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  };
  return {
    get: () => value,
    set: (next) => {
      const v = typeof next === "function" ? (next as (prev: T) => T)(value) : next;
      if (equals(v, value)) return;
      value = v;
      listeners.forEach((l) => l());
    },
    subscribe,
    use: () => React.useSyncExternalStore(subscribe, () => value),
  };
}

/**
 * A store for "whoever is showing it right now": a panel claims the slot with
 * its value and releases it on unmount, and a release only clears the slot if
 * the panel's own claim is still the current one (a newer panel keeps it).
 */
export interface Slot<T> extends Store<T | null> {
  /** Put `value` in the slot; the returned function releases it (a no-op if another claim replaced it). */
  claim: (value: T) => () => void;
}

export function createSlot<T>(): Slot<T> {
  const store = createStore<T | null>(null);
  return {
    ...store,
    claim: (value) => {
      store.set(value);
      return () => {
        if (store.get() === value) store.set(null);
      };
    },
  };
}
