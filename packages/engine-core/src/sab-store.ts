/**
 * SAB-backed bitECS component storage (Phase 1 of the SAB adaptation).
 *
 * bitECS 0.3.40 has no API to inject a backing store: `defineComponent`
 * allocates plain `ArrayBuffer` stores. This module performs post-allocation
 * store replacement — define the component normally, then swap each field's
 * typed array for a `SharedArrayBuffer`-backed view of identical constructor
 * and length. Every bitECS access path (systems, queries, `resetStoreFor`,
 * `Changed` shadows) reads field arrays through the component object, so
 * systems and queries see no API change — only the backing buffer changes.
 *
 * Critical ordering constraint (proven by the Phase 0 spike): replacement
 * must happen BEFORE any `defineQuery` for the component, because
 * `defineQuery` snapshots `component[$storeFlattened]` into `q.flatProps`
 * at definition time. This module is therefore called at component
 * definition time (`defineSABComponent`), and all queries are defined
 * later (at module import of the query sites, or at system construction).
 * Verified: no `defineQuery` in the engine references Body/Injury/Mana,
 * and every query on components.ts components lives in modules that import
 * components.ts first, so definition order is safe by ES module evaluation.
 *
 * Fixed-size constraint: a SharedArrayBuffer cannot grow. Stores are sized
 * to SAB_ENTITY_CAPACITY at definition time. Growing past capacity
 * requires a resize/migrate step that is NOT implemented — the boot-time
 * assertion in `defineSABComponent` guards the sizing, and the engine
 * must not call bitECS `setDefaultSize` with a larger value without
 * growing these stores too.
 *
 * Backing layout: ONE SharedArrayBuffer per component (not a single pooled
 * SAB for all components). Pooling would require either two-pass schema
 * collection across three definition sites (import-order complexity) or an
 * over-allocated magic-number pool (wasteful, fragile). Per-component SABs
 * match bitECS's per-component store model, keep rollback trivial (revert
 * the definition sites), and systems iterate one component's fields at a
 * time, so the locality benefit of pooling is marginal here.
 *
 * Array-type fields (`[Types.f32, N]`, e.g. Body.hp): bitECS builds a
 * shared parent array per type within a component and per-eid subarray
 * views into it. Replacement gives each array field its own SAB-backed
 * parent and rebuilds the per-eid views. Systems only ever touch the
 * per-eid views (`Body.hp[e][i]`), and no engine code reads the parent
 * array or the `$storeSubarrays` metadata directly, so splitting the
 * shared parent is safe. The old shared parent is orphaned.
 *
 * Tag components (`defineComponent()` with no schema, e.g. God/Noclip)
 * carry no data and are returned unchanged — there is nothing to back.
 */

import { defineComponent, type ComponentType, type ISchema } from "bitecs";

/**
 * Entity capacity for SAB-backed component stores.
 *
 * Must equal bitECS's global default size: `defineComponent(schema)`
 * without an explicit size uses `getGlobalSize()`, whose default is
 * 1e5 (bitECS 0.3.40, `defaultSize = 1e5`). The engine creates all
 * worlds with no-arg `createWorld()`, which also uses the global size,
 * so 100_000 is the single consistent capacity.
 */
export const SAB_ENTITY_CAPACITY = 100_000;

type TypedArray = ArrayBufferView & {
  readonly BYTES_PER_ELEMENT: number;
  readonly length: number;
};

type TypedArrayCtor = new (
  buffer: SharedArrayBuffer,
  byteOffset: number,
  length: number,
) => TypedArray;

/** Find an own symbol of `obj` by its description, or throw. */
function symbolByDescription(obj: object, description: string): symbol {
  const found = findSymbol(obj, description);
  if (!found) throw new Error(`sab-store: symbol "${description}" not found`);
  return found;
}

/** Find an own symbol of `obj` by its description, or undefined. */
function findSymbol(obj: object, description: string): symbol | undefined {
  return Object.getOwnPropertySymbols(obj).find(
    (s) => s.description === description,
  );
}

/** True if `value` is a bitECS array-type field store (JS array of per-eid subarrays). */
function isArrayStore(value: unknown): value is unknown[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    ArrayBuffer.isView(value[0]) &&
    !(value[0] instanceof DataView)
  );
}

/**
 * Replace a bitECS component's field stores with SharedArrayBuffer-backed
 * views. Returns the same component object (mutated in place).
 *
 * Must be called BEFORE any `defineQuery` for this component.
 * Tag components (no fields) are returned unchanged.
 */
export function sabBackComponent<C>(component: C): C {
  const comp = component as unknown as Record<string | symbol, unknown>;

  // Tag component: no schema, no field stores, nothing to back.
  // (Tag stores carry $tagStore; data components do not — hence the
  // non-throwing lookup.)
  const tagSym = findSymbol(comp, "tagStore");
  if (tagSym !== undefined && comp[tagSym] === true) return component;

  // Boot-time sizing guard: the component's store size must equal the
  // capacity these SABs are allocated for.
  const storeSize = comp[symbolByDescription(comp, "storeSize")];
  if (storeSize !== SAB_ENTITY_CAPACITY) {
    throw new Error(
      `sab-store: component store size ${String(storeSize)} != SAB_ENTITY_CAPACITY ${SAB_ENTITY_CAPACITY}`,
    );
  }

  // Pass 1: compute layout. One SAB, fields in Object.keys() order, each
  // aligned to its BYTES_PER_ELEMENT.
  interface FieldLayout {
    key: string;
    kind: "scalar" | "array";
    ctor: TypedArrayCtor;
    length: number;
    offset: number;
    old: unknown;
    oldParent?: TypedArray;
    storeSize?: number;
    perEid?: number;
  }
  const fields: FieldLayout[] = [];
  let totalBytes = 0;
  for (const key of Object.keys(comp)) {
    const value = comp[key];
    if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
      // Scalar field store: a single typed array of length = capacity.
      const view = value as TypedArray;
      const bpe = view.BYTES_PER_ELEMENT;
      const offset = Math.ceil(totalBytes / bpe) * bpe;
      fields.push({
        key,
        kind: "scalar",
        ctor: view.constructor as TypedArrayCtor,
        length: view.length,
        offset,
        old: value,
      });
      totalBytes = offset + view.length * bpe;
    } else if (isArrayStore(value)) {
      // Array-type field: JS array of per-eid subarray views.
      const store = value as unknown[];
      const parent = (store as unknown as Record<symbol, unknown>)[
        symbolByDescription(store, "parentArray")
      ] as TypedArray;
      const perEid = (store[0] as TypedArray).length;
      const bpe = parent.BYTES_PER_ELEMENT;
      const offset = Math.ceil(totalBytes / bpe) * bpe;
      fields.push({
        key,
        kind: "array",
        ctor: parent.constructor as TypedArrayCtor,
        length: store.length * perEid,
        offset,
        old: value,
        oldParent: parent,
        storeSize: store.length,
        perEid,
      });
      totalBytes = offset + store.length * perEid * bpe;
    } else if (value !== null && typeof value === "object") {
      // Nested schema or unexpected shape: fail loudly, never skip silently.
      throw new Error(
        `sab-store: component field "${key}" has unsupported nested/object shape`,
      );
    }
    // Non-object values (none expected) are ignored.
  }
  if (fields.length === 0) {
    throw new Error("sab-store: no field stores found on component");
  }

  const sab = new SharedArrayBuffer(totalBytes);

  // Pass 2: build SAB-backed stores, copy symbol props, swap in.
  const flatSym = symbolByDescription(comp, "storeFlattened");
  const flattened = comp[flatSym] as unknown[];
  for (const field of fields) {
    if (field.kind === "scalar") {
      const next = new field.ctor(sab, field.offset, field.length);
      for (const s of Object.getOwnPropertySymbols(field.old as object)) {
        (next as unknown as Record<symbol, unknown>)[s] = (
          field.old as Record<symbol, unknown>
        )[s];
      }
      const idx = flattened.indexOf(field.old);
      if (idx !== -1) flattened[idx] = next;
      comp[field.key] = next;
    } else {
      const parent = new field.ctor(sab, field.offset, field.length);
      const store = field.old as unknown[];
      (store as unknown as Record<symbol, unknown>)[
        symbolByDescription(store, "parentArray")
      ] = parent;
      for (let eid = 0; eid < field.storeSize!; eid++) {
        const sub = (parent as unknown as { subarray: (a: number, b: number) => TypedArray }).subarray(
          eid * field.perEid!,
          (eid + 1) * field.perEid!,
        );
        const oldSub = store[eid] as Record<symbol, unknown>;
        for (const s of Object.getOwnPropertySymbols(oldSub)) {
          (sub as unknown as Record<symbol, unknown>)[s] = oldSub[s];
        }
        store[eid] = sub;
      }
      // $storeFlattened holds the store object itself (same identity),
      // so no entry swap is needed for array stores.
    }
  }
  return component;
}

/**
 * Define a bitECS component whose field stores live in a
 * SharedArrayBuffer. Drop-in replacement for `defineComponent` for
 * data components (schemas with fields). Stores are always sized to
 * SAB_ENTITY_CAPACITY — there is no size parameter, because a component
 * sized differently would be inconsistent with the fixed-capacity SAB
 * layout this module guarantees. Tag components
 * (`defineComponent()` with no schema) do not need this — they carry no
 * data, so call sites keep plain `defineComponent()`.
 */
export function defineSABComponent<T extends ISchema>(
  schema: T,
): ComponentType<T> {
  if (!(SAB_ENTITY_CAPACITY > 0)) {
    throw new Error("sab-store: SAB_ENTITY_CAPACITY must be > 0");
  }
  const comp = defineComponent(schema, SAB_ENTITY_CAPACITY);
  return sabBackComponent(comp);
}
