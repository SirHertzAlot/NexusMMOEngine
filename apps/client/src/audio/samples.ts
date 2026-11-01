/**
 * Recorded sample loading (U4b). An audio event names a file ("step-grass.ogg");
 * when a recording with that name is served under `/assets/audio/` (the
 * licensed art folder, served to this machine only in dev), it is fetched and
 * decoded once and played instead of the synthesized placeholder. A file that
 * is missing or fails to decode stays a placeholder, and nothing else changes.
 *
 * The bank is generic over the decoded buffer so it can be tested without a
 * Web Audio context: the engine passes the real fetch and decodeAudioData.
 */

/** The browser calls the bank needs: fetch the bytes, decode them. */
export interface SampleSource<B> {
  fetch(url: string): Promise<{ ok: boolean; arrayBuffer(): Promise<ArrayBuffer> }>;
  decode(data: ArrayBuffer): Promise<B>;
}

export const SAMPLE_BASE = "/assets/audio/";

type Entry<B> = { status: "loading" } | { status: "ready"; buffer: B } | { status: "missing" };

export class SampleBank<B> {
  private readonly entries = new Map<string, Entry<B>>();

  constructor(
    private readonly source: SampleSource<B>,
    private readonly base: string = SAMPLE_BASE,
  ) {}

  /** Starts loading each file not yet known. Safe to call with the same names again. */
  preload(files: Iterable<string>): void {
    for (const file of files) {
      if (!file || this.entries.has(file)) continue;
      this.entries.set(file, { status: "loading" });
      void this.load(file);
    }
  }

  /** The decoded recording, or null while it loads or when there is none. */
  get(file: string): B | null {
    const e = this.entries.get(file);
    return e?.status === "ready" ? e.buffer : null;
  }

  /** Where a file stands: unknown names are "missing" too. */
  status(file: string): "loading" | "ready" | "missing" {
    return this.entries.get(file)?.status ?? "missing";
  }

  private async load(file: string): Promise<void> {
    try {
      const res = await this.source.fetch(this.base + encodeURIComponent(file));
      if (!res.ok) return this.set(file, { status: "missing" });
      const buffer = await this.source.decode(await res.arrayBuffer());
      this.set(file, { status: "ready", buffer });
    } catch {
      // A network or decode failure is a missing sample: the placeholder plays.
      this.set(file, { status: "missing" });
    }
  }

  private set(file: string, e: Entry<B>): void {
    this.entries.set(file, e);
  }
}
