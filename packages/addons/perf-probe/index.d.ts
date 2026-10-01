/** Callgrind start/stop marks; no-ops outside valgrind. */
export function running(): boolean;
/** Zero callgrind's counters and start collecting. */
export function begin(): void;
/** Stop collecting and write a dump named `name`. */
export function end(name: string): void;
