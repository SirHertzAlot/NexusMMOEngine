/**
 * The persisted geology record: what a reload needs without regenerating.
 * Stored in region.db (`world_docs.geology_snapshot`) next to the per-cell
 * maps `geology_province`, `geology_kind`, `geology_plate`, `geology_uplift`.
 *
 * It carries the snapshot itself (generator name, version and params, the
 * frame with projection and scale, the explicit plates, cratons, sutures and
 * overrides), the province table with stable ids, and the fields' hash.
 * Seed-only reconstruction is never relied on: the snapshot's numbers are
 * the source, and the hash proves the stored maps still match them.
 */

import type { GeologyFields, ProvinceRecord } from "./provinces.js";
import { PROVINCE_KINDS, type GeologySpec } from "./snapshot.js";

export const GEOLOGY_RECORD_VERSION = 1;

export interface GeologyRecord {
  recordVersion: number;
  snapshot: GeologySpec;
  provinceKinds: readonly string[];
  provinces: ProvinceRecord[];
  fieldsHash: string;
  maps: { province: "geology_province"; kind: "geology_kind"; plate: "geology_plate"; uplift: "geology_uplift" };
}

export function geologyRecord(snapshot: GeologySpec, fields: GeologyFields): GeologyRecord {
  return {
    recordVersion: GEOLOGY_RECORD_VERSION,
    snapshot,
    provinceKinds: PROVINCE_KINDS,
    provinces: fields.provinces,
    fieldsHash: fields.hash,
    maps: { province: "geology_province", kind: "geology_kind", plate: "geology_plate", uplift: "geology_uplift" },
  };
}
