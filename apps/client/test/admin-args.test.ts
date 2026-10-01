/**
 * Admin console arg parsing: JSON objects, the quoteless {k:v}
 * shorthand (numbers stay numeric), and the bare entity.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseAdminArgs } from "../src/ui/admin-args.js";

describe("parseAdminArgs", () => {
  it("passes JSON objects through", () => {
    assert.deepEqual(
      parseAdminArgs('{"entity":"me","component":"Health","field":"current","value":10}'),
      { entity: "me", component: "Health", field: "current", value: 10 },
    );
  });

  it("reads the quoteless shorthand with numeric values", () => {
    assert.deepEqual(
      parseAdminArgs("{entity:me,component:Health,field:current,value:10}"),
      { entity: "me", component: "Health", field: "current", value: 10 },
    );
  });

  it("falls back to the bare entity", () => {
    assert.deepEqual(parseAdminArgs("me"), { entity: "me" });
    assert.deepEqual(parseAdminArgs("12345"), { entity: "12345" });
    assert.deepEqual(parseAdminArgs(""), undefined);
    assert.deepEqual(parseAdminArgs("{oops}"), { entity: "{oops}" });
  });
});
