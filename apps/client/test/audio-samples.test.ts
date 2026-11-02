/** Recorded sample loading (U4b): fetch and decode once, fall back to missing. */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SampleBank, type SampleSource } from "../src/audio/samples.js";

type Fake = SampleSource<string> & { urls: string[]; decodes: number };

/** A source where each file is either served (200) or missing (404); decode may fail. */
function fakeSource(served: Record<string, string | "decode-fails">): Fake {
  const src: Fake = {
    urls: [],
    decodes: 0,
    async fetch(url) {
      src.urls.push(url);
      const name = decodeURIComponent(url.slice(url.lastIndexOf("/") + 1));
      const body = served[name];
      return {
        ok: body !== undefined,
        async arrayBuffer() {
          return new TextEncoder().encode(body ?? "").buffer;
        },
      };
    },
    async decode(data) {
      src.decodes++;
      const text = new TextDecoder().decode(data);
      if (text === "decode-fails") throw new Error("bad audio");
      return `buffer:${text}`;
    },
  };
  return src;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("sample bank", () => {
  it("loads a served recording once, then hands it out decoded", async () => {
    const src = fakeSource({ "step-grass.ogg": "grass-pcm" });
    const bank = new SampleBank<string>(src, "/assets/audio/");
    assert.equal(bank.status("step-grass.ogg"), "missing", "unknown until preloaded");
    bank.preload(["step-grass.ogg", "step-grass.ogg"]);
    assert.equal(bank.status("step-grass.ogg"), "loading");
    assert.equal(bank.get("step-grass.ogg"), null, "nothing until it decodes");
    await flush();
    assert.equal(bank.status("step-grass.ogg"), "ready");
    assert.equal(bank.get("step-grass.ogg"), "buffer:grass-pcm");
    bank.preload(["step-grass.ogg"]);
    await flush();
    assert.equal(src.urls.length, 1, "a name is fetched once");
    assert.equal(src.decodes, 1);
    assert.deepEqual(src.urls, ["/assets/audio/step-grass.ogg"]);
  });

  it("a file that is not served stays missing, and get returns null", async () => {
    const bank = new SampleBank<string>(fakeSource({}), "/assets/audio/");
    bank.preload(["sword-hit.ogg"]);
    await flush();
    assert.equal(bank.status("sword-hit.ogg"), "missing");
    assert.equal(bank.get("sword-hit.ogg"), null);
  });

  it("a recording that fails to decode is missing, not an error", async () => {
    const bank = new SampleBank<string>(fakeSource({ "hit.ogg": "decode-fails" }), "/assets/audio/");
    bank.preload(["hit.ogg"]);
    await flush();
    assert.equal(bank.status("hit.ogg"), "missing");
    assert.equal(bank.get("hit.ogg"), null);
  });

  it("encodes the file name in the URL", async () => {
    const src = fakeSource({ "a b.ogg": "x" });
    const bank = new SampleBank<string>(src, "/assets/audio/");
    bank.preload(["a b.ogg"]);
    await flush();
    assert.deepEqual(src.urls, ["/assets/audio/a%20b.ogg"]);
    assert.equal(bank.get("a b.ogg"), "buffer:x");
  });
});
