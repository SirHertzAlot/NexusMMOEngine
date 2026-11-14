import test from "node:test";
import assert from "node:assert/strict";
import {
  WEATHERING_CHANNELS,
  buildBuildingProvenance5W1H,
  buildStructureSurfaceSamples,
  createParametricTemplateFromGrammar,
  createParametricTemplateFromPrototype,
  evaluateBuildingWeatheringMask,
  evaluateWeatheringAtPoint,
  explainBuildingAppearance,
  generateSpilloverDetailLayer,
  narrowTemplateForDistrict,
  parseBuildingProvenance5W1H,
  parseParametricBuildingTemplate,
  rollLotVariation,
  runBuildingAdoptionPipeline,
  synthesizeBuilding,
  synthesizeBuildingForParcel,
  validateRolledKnobs,
  type DecompositionLibrary,
  type InteriorGrammarDoc,
  type ParametricBuildingTemplate,
  type StructurePrototype,
} from "../src/index.js";

function makeSampleTemplate(): ParametricBuildingTemplate {
  return parseParametricBuildingTemplate({
    id: "timber-cottage-v1",
    family: "timber-framed-dwelling",
    sourceMode: "parametric-gn",
    archetypes: ["house", "cottage"],
    footprintRangeM: {
      min: [4, 4],
      max: [10, 10],
    },
    knobSpace: {
      floors: {
        kind: "range",
        min: 1,
        max: 3,
        step: 1,
        integer: true,
        default: 1,
        variationWeight: 0.75,
        legalConstraintTag: "storey-limit",
      },
      wallHeightM: {
        kind: "range",
        min: 2.6,
        max: 3.4,
        step: 0.2,
        default: 3.0,
        variationWeight: 0.5,
      },
      widthM: {
        kind: "range",
        min: 4,
        max: 9,
        step: 0.5,
        default: 6,
        variationWeight: 0.7,
      },
      depthM: {
        kind: "range",
        min: 4,
        max: 9,
        step: 0.5,
        default: 6,
        variationWeight: 0.7,
      },
      roofForm: {
        kind: "choice",
        options: [
          { value: "gabled-slate", weight: 0.55 },
          { value: "thatched", weight: 0.3 },
          { value: "flat-parapet", weight: 0.15 },
        ],
        default: "gabled-slate",
        variationWeight: 0.9,
      },
      balconyType: {
        kind: "choice",
        options: [
          { value: "none", weight: 0.45 },
          { value: "timber", weight: 0.4 },
          { value: "stone", weight: 0.15 },
        ],
        default: "none",
        variationWeight: 0.85,
      },
      lockedSignStyle: {
        kind: "choice",
        options: [
          { value: "oak-plank", weight: 0.8 },
          { value: "iron-hang", weight: 0.2 },
        ],
        default: "oak-plank",
        variationWeight: 0,
      },
    },
    grammarConstraints: [
      {
        kind: "requires",
        id: "balcony-needs-upper-floor",
        whenKnob: "balconyType",
        whenNotEquals: "none",
        targetKnob: "floors",
        min: 2,
      },
      {
        kind: "forbids",
        id: "no-stone-balcony-on-thatch",
        knobA: "balconyType",
        equalsA: "stone",
        knobB: "roofForm",
        equalsB: "thatched",
      },
    ],
    districtRules: [
      {
        district: "old-harbor",
        knobOverrides: {
          floors: { min: 1, max: 2 },
          roofForm: { allowedValues: ["gabled-slate", "flat-parapet"] },
        },
        maxFootprintM: [7.5, 7.5],
        maxHeightM: 6.4,
      },
    ],
    splatExperiment: {
      treatment: "hybrid",
      gateStatus: "rd-only",
      maxSplatBudget: 24,
      celPaletteSnapped: true,
      notes: "R&D experiment only; cross-quads active at runtime",
    },
  });
}

function makeSyntheticPrototype(): StructurePrototype {
  return {
    id: "proto-tavern-1",
    name: "CornerTavern",
    category: "tavern",
    settlementArchetypes: ["tavern", "inn"],
    frontYawDeg: 0,
    footprint: [7, 6.4, 7],
    groundY: 0,
    hasInterior: true,
    cellSizeM: 3.5,
    storeys: [
      {
        level: 0,
        elevationY: 0,
        floorHeightM: 3.2,
        cellSizeM: 3.5,
        cols: 2,
        rows: 2,
        originXZ: [-3.5, -3.5],
        plan: ["..", ".."],
        cells: [],
        openings: [],
      },
      {
        level: 1,
        elevationY: 3.2,
        floorHeightM: 3.2,
        cellSizeM: 3.5,
        cols: 2,
        rows: 2,
        originXZ: [-3.5, -3.5],
        plan: ["..", ".."],
        cells: [],
        openings: [],
      },
    ],
    rooms: [
      {
        id: "tavern-hall",
        structureId: "proto-tavern-1",
        structureCategory: "tavern",
        roomType: "living_hall",
        storey: 0,
        elevationY: 0,
        bounds: { min: [-3.5, 0, -3.5], max: [3.5, 3.2, 3.5], size: [7, 3.2, 7] },
        cells: [
          [0, 0],
          [1, 0],
          [0, 1],
          [1, 1],
        ],
        openings: [{ kind: "door", side: "N", localPos: [0, 0, 3.5], yawDeg: 0 }],
        parts: [],
        vignetteRefs: [],
        partSummary: {},
      },
    ],
    roomGraph: [],
    parts: [
      {
        partId: "wall_stone_n",
        assetRef: "res://walls/wall_stone.glb",
        category: "wall",
        layer: "exterior",
        roomId: "tavern-hall",
        storey: 0,
        transform: { pos: [0, 1.6, 3.4], rot: [0, 0, 0, 1], scale: [1, 1, 1] },
        bounds: { min: [-3.5, -1.6, -0.2], max: [3.5, 1.6, 0.2], size: [7, 3.2, 0.4] },
      },
      {
        partId: "wall_stone_s",
        assetRef: "res://walls/wall_stone.glb",
        category: "wall",
        layer: "exterior",
        roomId: "tavern-hall",
        storey: 0,
        transform: { pos: [0, 1.6, -3.4], rot: [0, 0, 0, 1], scale: [1, 1, 1] },
        bounds: { min: [-3.5, -1.6, -0.2], max: [3.5, 1.6, 0.2], size: [7, 3.2, 0.4] },
      },
      {
        partId: "chimney_brick_stack",
        assetRef: "res://roofs/chimney.glb",
        category: "chimney",
        layer: "roof",
        roomId: "tavern-hall",
        storey: 1,
        transform: { pos: [2.2, 5.2, -1.8], rot: [0, 0, 0, 1], scale: [1, 1, 1] },
        bounds: { min: [-0.4, -1.0, -0.4], max: [0.4, 1.0, 0.4], size: [0.8, 2.0, 0.8] },
      },
      {
        partId: "door_oak_entry",
        assetRef: "res://doors/door_oak.glb",
        category: "door",
        layer: "exterior",
        roomId: "tavern-hall",
        storey: 0,
        transform: { pos: [0, 0.1, 3.5], rot: [0, 0, 0, 1], scale: [1, 1, 1] },
        bounds: { min: [-0.6, 0, -0.15], max: [0.6, 2.2, 0.15], size: [1.2, 2.2, 0.3] },
      },
    ],
    layerCounts: { exterior: 3, roof: 1 },
  };
}

function makeSyntheticLibrary(proto: StructurePrototype): DecompositionLibrary {
  return {
    version: 1,
    family: "synthetic-test",
    source: "unit-test",
    license: "MIT",
    extractorVersion: "1.0.0",
    structures: [proto],
    rooms: proto.rooms,
    vignettes: [],
    archetypeRoomPriors: {
      tavern: { living_hall: 1 },
      inn: { living_hall: 1 },
    },
    roomVignettePriors: {},
    stats: {
      structures: 1,
      structuresWithInteriors: 1,
      rooms: proto.rooms.length,
      vignettes: 0,
      totalParts: proto.parts.length,
      categoryDistribution: { wall: 2, chimney: 1, door: 1 },
      roomTypeDistribution: { living_hall: 1 },
      vignetteKindDistribution: {},
    },
    ruleSet: {
      family: "synthetic-test",
      extractorVersion: "1.0.0",
      sourceAssemblies: ["unit-test"],
      parts: {
        wall_stone_n: {
          id: "wall_stone_n",
          assetRef: "res://walls/wall_stone.glb",
          category: "wall",
          bounds: { min: [-3.5, -1.6, -0.2], max: [3.5, 1.6, 0.2], size: [7, 3.2, 0.4] },
          sockets: [],
        },
        wall_stone_s: {
          id: "wall_stone_s",
          assetRef: "res://walls/wall_stone.glb",
          category: "wall",
          bounds: { min: [-3.5, -1.6, -0.2], max: [3.5, 1.6, 0.2], size: [7, 3.2, 0.4] },
          sockets: [],
        },
        chimney_brick_stack: {
          id: "chimney_brick_stack",
          assetRef: "res://roofs/chimney.glb",
          category: "chimney",
          bounds: { min: [-0.4, -1.0, -0.4], max: [0.4, 1.0, 0.4], size: [0.8, 2.0, 0.8] },
          sockets: [],
        },
        door_oak_entry: {
          id: "door_oak_entry",
          assetRef: "res://doors/door_oak.glb",
          category: "door",
          bounds: { min: [-0.6, 0, -0.15], max: [0.6, 2.2, 0.15], size: [1.2, 2.2, 0.3] },
          sockets: [],
        },
      },
      adjacency: [],
      terminals: [],
      stats: {
        totalPlacements: 4,
        uniqueParts: 4,
        totalAdjacencyPairs: 0,
        categoryDistribution: { wall: 2, chimney: 1, door: 1 },
        partFrequencies: { wall_stone_n: 1, wall_stone_s: 1, chimney_brick_stack: 1, door_oak_entry: 1 },
      },
    },
  };
}

test("parametric template bridges InteriorGrammar and StructurePrototype cleanly", () => {
  const grammar: InteriorGrammarDoc = {
    format: "mmo-interior-grammar/1",
    id: "stone-cell-grammar",
    cellM: 2.0,
    wallHeightM: 3.0,
    doorwayM: 1.2,
    plan: [
      "...",
      "...",
      "...",
    ],
    doors: [{ side: "S", index: 1 }],
  };

  const fromGrammar = createParametricTemplateFromGrammar({
    id: "stone-cell-grammar",
    family: "chapel",
    grammar,
  });
  assert.equal(fromGrammar.sourceMode, "parametric-gn");
  assert.equal(fromGrammar.baseGrammarId, "stone-cell-grammar");
  assert.ok(fromGrammar.knobSpace.floors);

  const proto = makeSyntheticPrototype();
  const fromProto = createParametricTemplateFromPrototype({ prototype: proto });
  assert.equal(fromProto.sourceMode, "static-decomposed");
  assert.equal(fromProto.prototypeId, proto.id);
  assert.deepEqual(fromProto.archetypes, ["tavern", "inn"]);
});

test("rollLotVariation is deterministic, enforces grammar/district constraints, and respects variationWeight", () => {
  const tpl = makeSampleTemplate();

  const a = rollLotVariation(tpl, { seed: 4242, parcelSizeM: [8, 8] });
  const b = rollLotVariation(tpl, { seed: 4242, parcelSizeM: [8, 8] });
  assert.deepEqual(a, b);
  assert.equal(a.legal, true);
  assert.equal(a.knobValues.lockedSignStyle, "oak-plank");

  const seenRoofForms = new Set<string>();
  const seenFloors = new Set<number>();
  for (let s = 1; s <= 40; s++) {
    const rolled = rollLotVariation(tpl, {
      seed: 1000 + s * 37,
      parcelSizeM: [8, 8],
    });
    assert.equal(rolled.knobValues.lockedSignStyle, "oak-plank");
    assert.ok(rolled.rolledFootprintM[0] <= 8);
    assert.ok(rolled.rolledFootprintM[1] <= 8);
    if (rolled.knobValues.balconyType !== "none") {
      assert.ok((rolled.knobValues.floors as number) >= 2);
    }
    assert.ok(
      !(rolled.knobValues.balconyType === "stone" && rolled.knobValues.roofForm === "thatched"),
    );
    const check = validateRolledKnobs(tpl, rolled.knobValues, { parcelSizeM: [8, 8] });
    assert.equal(check.legal, true, check.violations.join("; "));
    seenRoofForms.add(String(rolled.knobValues.roofForm));
    seenFloors.add(rolled.knobValues.floors as number);
  }
  assert.ok(seenRoofForms.size >= 2);
  assert.ok(seenFloors.size >= 2);

  // District narrowing checks
  const narrowed = narrowTemplateForDistrict(tpl, "old-harbor");
  assert.ok(narrowed.footprintRangeM.max[0] <= 7.5);
  for (let s = 1; s <= 25; s++) {
    const r = rollLotVariation(tpl, { seed: 500 + s, district: "old-harbor" });
    assert.equal(r.district, "old-harbor");
    assert.notEqual(r.knobValues.roofForm, "thatched");
    assert.ok((r.knobValues.floors as number) <= 2);
    const estHeight = (r.knobValues.floors as number) * (r.knobValues.wallHeightM as number);
    assert.ok(estHeight <= 6.4 + 1e-6);
  }

  // Illegal overrides / unsatisfiable parcel bounds throw cleanly
  assert.throws(() =>
    rollLotVariation(tpl, { seed: 7, parcelSizeM: [2, 2] }),
  );
  assert.throws(() =>
    rollLotVariation(tpl, {
      seed: 7,
      overrides: { balconyType: "timber", floors: 1 },
    }),
  );
});

test("weathering evaluator separates age-driven channels from moisture/aspect-driven channels", () => {
  // Brand new building: cracking, dirt, soot, wornThresholds must all be strictly 0.
  const brandNew = evaluateBuildingWeatheringMask(
    {
      moisture: 0.75,
      aspectDeg: 0,
      buildingAgeYears: 0,
      chimneyPositions: [[2, 5, -2]],
      thresholdPositions: [[0, 0.1, 3]],
      seed: 101,
    },
    [
      { position: [0, 0.25, 3], normal: [0, 0, 1], surfaceTag: "threshold" },
      { position: [2, 5.0, -2], normal: [0, 0.8, 0.6], surfaceTag: "chimney" },
      { position: [0, 1.5, 3], normal: [0, 0, 1], surfaceTag: "wall" },
    ],
  );
  assert.equal(brandNew.meanChannels.cracking, 0);
  assert.equal(brandNew.meanChannels.dirt, 0);
  assert.equal(brandNew.meanChannels.soot, 0);
  assert.equal(brandNew.meanChannels.wornThresholds, 0);
  assert.ok(brandNew.meanChannels.moss > 0);

  // Older building in same environment must accumulate age-driven channels.
  const ancient = evaluateBuildingWeatheringMask(
    {
      moisture: 0.75,
      aspectDeg: 0,
      buildingAgeYears: 140,
      chimneyPositions: [[2, 5, -2]],
      thresholdPositions: [[0, 0.1, 3]],
      seed: 101,
    },
    [
      { position: [0, 0.25, 3], normal: [0, 0, 1], surfaceTag: "threshold" },
      { position: [2, 5.0, -2], normal: [0, 0.8, 0.6], surfaceTag: "chimney" },
      { position: [0, 1.5, 3], normal: [0, 0, 1], surfaceTag: "wall" },
    ],
  );
  assert.ok(ancient.meanChannels.cracking > 0.45);
  assert.ok(ancient.meanChannels.dirt > 0.25);
  assert.ok(ancient.maxChannels.soot > 0.65);
  assert.ok(ancient.maxChannels.wornThresholds > 0.65);
  assert.ok(ancient.maxChannels.cracking > brandNew.maxChannels.cracking);

  // Moisture + aspect sensitivity: shaded damp wall vs sunlit dry wall.
  const wetNorth = evaluateWeatheringAtPoint(
    { moisture: 0.9, aspectDeg: 0, sunAzimuthDeg: 180, buildingAgeYears: 40, seed: 5 },
    { position: [0, 0.35, 2], normal: [0, 0, 1], surfaceTag: "wall" },
  );
  const drySouth = evaluateWeatheringAtPoint(
    { moisture: 0.1, aspectDeg: 180, sunAzimuthDeg: 180, buildingAgeYears: 40, seed: 5 },
    { position: [0, 0.35, -2], normal: [0, 0, -1], surfaceTag: "wall" },
  );
  assert.ok(wetNorth.channels.moss > drySouth.channels.moss * 3);
  assert.ok(wetNorth.channels.lichen > drySouth.channels.lichen * 2);
  assert.ok(drySouth.channels.sunDried > wetNorth.channels.sunDried * 2);

  // Ground splash dirt should decay up the wall height.
  const wallLow = evaluateWeatheringAtPoint(
    { moisture: 0.6, aspectDeg: 0, buildingAgeYears: 60, seed: 9 },
    { position: [1, 0.2, 2], normal: [0, 0, 1], surfaceTag: "wall" },
  );
  const wallHigh = evaluateWeatheringAtPoint(
    { moisture: 0.6, aspectDeg: 0, buildingAgeYears: 60, seed: 9 },
    { position: [1, 4.2, 2], normal: [0, 0, 1], surfaceTag: "wall" },
  );
  assert.ok(wallLow.channels.dirt > wallHigh.channels.dirt * 3);

  for (const ch of WEATHERING_CHANNELS) {
    assert.ok(ancient.meanChannels[ch] >= 0 && ancient.meanChannels[ch] <= 1);
  }
});

test("structure-surface spillover propagates vines across wall seam to nearby neighbor and obeys budgets & R&D splat gate", () => {
  const vineLayer = {
    id: "creeping-ivy",
    assetSet: "foliage/ivy-v1",
    surface: "structure-surface" as const,
    density: 0.9,
    noise: { scale: 0.45, threshold: 0.1 },
    band: { min: 0, max: 0.95 },
    affinity: { weight: 0.85, preference: 0.85 },
    cluster: { size: 1.5, falloff: 0.8 },
    seed: 777,
    budget: 90,
    sampleSpacingM: 0.5,
    maxClimbHeightM: 3.0,
    groundSpillRadiusM: 1.5,
    seamReachM: 2.0,
    minMoisture: 0.2,
    shadeAffinity: 0.75,
    treatment: "hybrid" as const,
    splatBudget: 16,
  };

  const baseInput = {
    buildingId: "cottage-west",
    buildingBox: { min: [-2, 0, -2] as [number, number, number], max: [2, 3.2, 2] as [number, number, number] },
    weatheringInputs: {
      moisture: 0.85,
      aspectDeg: 0,
      sunAzimuthDeg: 180,
      buildingAgeYears: 55,
      seed: 777,
    },
  };

  const closeNeighbor = {
    id: "shed-east",
    box: { min: [3.1, 0, -1.5] as [number, number, number], max: [6.1, 2.8, 1.5] as [number, number, number] },
    moisture: 0.9,
  };
  const farNeighbor = {
    id: "distant-barn",
    box: { min: [10, 0, -2] as [number, number, number], max: [14, 3, 2] as [number, number, number] },
    moisture: 0.9,
  };

  const r1 = generateSpilloverDetailLayer(vineLayer, {
    ...baseInput,
    adjacentStructures: [closeNeighbor],
  });
  const r2 = generateSpilloverDetailLayer(vineLayer, {
    ...baseInput,
    adjacentStructures: [closeNeighbor],
  });
  assert.deepEqual(r1.placements, r2.placements);
  assert.ok(r1.placements.length > 0 && r1.placements.length <= vineLayer.budget);
  assert.ok(r1.roleCounts["wall-face"] > 0);
  assert.ok(r1.roleCounts.seam > 0 || r1.roleCounts.ground > 0);
  assert.ok(r1.roleCounts["adjacent-wall"] > 0);
  assert.ok(
    r1.placements.some((p) => p.targetStructureId === "shed-east" && p.surfaceRole === "adjacent-wall"),
  );
  assert.ok(r1.geometry.quads > 0);
  assert.ok(r1.geometry.positions.length > 0);

  // Stacked climbing wall-face vines sharing an (x, z) column must retain distinct Y bands in geometry.positions.
  const ySetByCol = new Map<string, Set<number>>();
  for (const sp of r1.placements) {
    const col = `${sp.worldPos[0]}:${sp.worldPos[2]}`;
    let set = ySetByCol.get(col);
    if (!set) {
      set = new Set<number>();
      ySetByCol.set(col, set);
    }
    set.add(sp.worldPos[1]);
  }
  const stackedCols = [...ySetByCol.entries()].filter(([, ys]) => ys.size >= 2);
  assert.ok(stackedCols.length > 0, "expected at least one wall column with multiple vine elevation bands");
  const expectedBaseYs = new Set(r1.placements.map((sp) => Math.round(sp.worldPos[1] * 1000) / 1000));
  const geomYs = new Set<number>();
  for (let i = 1; i < r1.geometry.positions.length; i += 3) {
    geomYs.add(Math.round(r1.geometry.positions[i]! * 1000) / 1000);
  }
  for (const baseY of expectedBaseYs) {
    assert.ok(geomYs.has(baseY), `missing base Y=${baseY} in cross-quad geometry.positions`);
  }

  assert.ok(r1.splatExperiment);
  assert.equal(r1.splatExperiment.gateStatus, "rd-only");
  assert.equal(r1.splatExperiment.activeRuntimeTreatment, "cross-quad");
  assert.equal(r1.splatExperiment.maxSplatBudget, 16);

  // Far neighbor beyond seamReachM should not receive spillover.
  const isolated = generateSpilloverDetailLayer(vineLayer, {
    ...baseInput,
    adjacentStructures: [farNeighbor],
  });
  assert.equal(isolated.roleCounts["adjacent-wall"], 0);

  // tierScale=0.5 reduces placement count vs tierScale=1.
  const halfTier = generateSpilloverDetailLayer(
    vineLayer,
    { ...baseInput, adjacentStructures: [closeNeighbor] },
    0.5,
  );
  assert.ok(halfTier.placements.length <= Math.ceil(r1.placements.length * 0.55));

  // Dry desert below minMoisture suppresses vine spillover cleanly.
  const desertSamples = buildStructureSurfaceSamples(
    {
      ...baseInput,
      weatheringInputs: { moisture: 0.05, aspectDeg: 180, buildingAgeYears: 55, seed: 777 },
    },
    vineLayer,
  );
  assert.ok(desertSamples.every((s) => s.affinity === 0));
});

test("5W1H provenance answers why a house looks the way it does and integrates optionally into synthesizeBuilding", () => {
  const tpl = makeSampleTemplate();
  const pipelineOut = runBuildingAdoptionPipeline({
    buildingId: "harbor-house-12",
    archetype: "house",
    template: tpl,
    seed: 9191,
    parcelSizeM: [7.5, 7.5],
    district: "old-harbor",
    weatheringInputs: {
      moisture: 0.72,
      aspectDeg: 0,
      buildingAgeYears: 80,
      chimneyPositions: [[1.5, 4.5, -1.0]],
      thresholdPositions: [[0, 0.1, 3.0]],
      seed: 9191,
    },
    spilloverLayers: [
      {
        id: "harbor-moss",
        assetSet: "foliage/coastal-moss",
        surface: "structure-surface",
        density: 0.8,
        noise: { scale: 0.5, threshold: 0.15 },
        band: { min: 0, max: 0.9 },
        affinity: { weight: 0.8, preference: 0.8 },
        cluster: { size: 1.2, falloff: 0.7 },
        seed: 9191,
        budget: 50,
      },
    ],
  });

  // Round-trip JSON validation on provenance
  const roundTripped = parseBuildingProvenance5W1H(
    JSON.parse(JSON.stringify(pipelineOut.provenance)),
  );
  assert.equal(roundTripped.template.id, tpl.id);
  assert.equal(roundTripped.seed, 9191);
  assert.equal(roundTripped.district, "old-harbor");
  assert.equal(roundTripped.weatheringInputs.buildingAgeYears, 80);
  assert.equal(roundTripped.layerPasses.length, 1);

  const explanation = explainBuildingAppearance(roundTripped);
  assert.ok(explanation.summary.includes(tpl.id));
  assert.ok(explanation.fiveWOneH.why.includes("9191"));
  assert.ok(explanation.fiveWOneH.when.includes("80y"));
  assert.ok(explanation.byField.knobValues.floors.includes("old-harbor"));
  assert.ok(explanation.byField.weatheringChannels.moss.includes("moisture=0.72"));
  assert.equal(explanation.byField.layerPasses.length, 1);

  // Backwards compatibility check: synthesizeBuilding WITHOUT adoption options omits `adoption`.
  const proto = makeSyntheticPrototype();
  const lib = makeSyntheticLibrary(proto);
  const legacyA = synthesizeBuilding(lib, {
    archetype: "tavern",
    seed: 333,
    maxFootprintM: [8, 8],
    synthesizeInteriors: false,
  });
  const legacyB = synthesizeBuilding(lib, {
    archetype: "tavern",
    seed: 333,
    maxFootprintM: [8, 8],
    synthesizeInteriors: false,
  });
  assert.equal("adoption" in legacyA, false);
  assert.deepEqual(legacyA.placements, legacyB.placements);

  // Integration check: synthesizeBuildingForParcel WITH Slice H options attaches adoption + 5W1H provenance.
  const adopted = synthesizeBuildingForParcel(lib, "tavern", 7.5, 7.5, 0, 333, {
    synthesizeInteriors: false,
    buildingId: "tavern-parcel-333",
    weatheringInputs: {
      moisture: 0.65,
      aspectDeg: 0,
      buildingAgeYears: 45,
      chimneyPositions: [[2.2, 5.2, -1.8]],
      thresholdPositions: [[0, 0.1, 3.5]],
    },
    spilloverLayers: [
      {
        id: "tavern-ivy",
        assetSet: "foliage/ivy-v1",
        surface: "structure-surface",
        density: 0.85,
        noise: { scale: 0.4, threshold: 0.15 },
        band: { min: 0, max: 0.9 },
        affinity: { weight: 0.8, preference: 0.8 },
        cluster: { size: 1.4, falloff: 0.75 },
        seed: 333,
        budget: 60,
      },
    ],
  });
  assert.ok(adopted.adoption);
  assert.equal(adopted.adoption.provenance.buildingId, "tavern-parcel-333");
  assert.equal(adopted.adoption.provenance.template.sourceMode, "static-decomposed");
  assert.ok(adopted.adoption.weatheringMask.maxChannels.soot > 0.4);
  assert.equal(adopted.adoption.spilloverLayers.length, 1);

  // Also sanity-check direct buildBuildingProvenance5W1H export.
  const directProv = buildBuildingProvenance5W1H({
    buildingId: "direct-1",
    archetype: "house",
    template: { id: tpl.id, family: tpl.family, sourceMode: tpl.sourceMode },
    seed: 12,
    knobValues: { floors: 1 },
    weatheringMask: pipelineOut.weatheringMask,
  });
  assert.equal(directProv.seed, 12);
});

test("edge cases: aspect-only weathering, monotonic aging, inline district rules, sum-bound, and strict R&D splat schema", () => {
  // 1. Canonical weathering (no explicit samples) + aspect-only evaluation + monotonic age curve.
  const canonical = evaluateBuildingWeatheringMask({
    moisture: 0.55,
    aspectDeg: 0,
    buildingAgeYears: 0,
    seed: 12,
  });
  assert.ok(canonical.samples.length >= 6);
  assert.equal(canonical.maxChannels.cracking, 0);

  const ages = [0, 30, 150].map((age) =>
    evaluateWeatheringAtPoint(
      {
        moisture: 0.65,
        aspectDeg: 0,
        buildingAgeYears: age,
        chimneyPositions: [[0, 0.5, 2]],
        thresholdPositions: [[0, 0.5, 2]],
        seed: 7,
      },
      { position: [0, 0.5, 2], surfaceTag: "wall" },
    ),
  );
  assert.ok(ages[0]!.channels.cracking < ages[1]!.channels.cracking);
  assert.ok(ages[1]!.channels.cracking < ages[2]!.channels.cracking);
  assert.ok(ages[0]!.channels.dirt < ages[1]!.channels.dirt);
  assert.ok(ages[1]!.channels.dirt < ages[2]!.channels.dirt);
  assert.ok(ages[0]!.channels.soot < ages[1]!.channels.soot);
  assert.ok(ages[1]!.channels.soot < ages[2]!.channels.soot);
  assert.ok(ages[0]!.channels.wornThresholds < ages[1]!.channels.wornThresholds);
  assert.ok(ages[1]!.channels.wornThresholds < ages[2]!.channels.wornThresholds);

  // Aspect-only (omitted point normal): aspect=180 sun-facing has higher sunDried than shaded aspect=0.
  const northNoNormal = evaluateWeatheringAtPoint(
    { moisture: 0.25, aspectDeg: 0, sunAzimuthDeg: 180, buildingAgeYears: 20, seed: 3 },
    { position: [1, 1, 1], surfaceTag: "wall" },
  );
  const southNoNormal = evaluateWeatheringAtPoint(
    { moisture: 0.25, aspectDeg: 180, sunAzimuthDeg: 180, buildingAgeYears: 20, seed: 3 },
    { position: [1, 1, 1], surfaceTag: "wall" },
  );
  assert.ok(southNoNormal.sunExposure > northNoNormal.sunExposure);
  assert.ok(southNoNormal.channels.sunDried > northNoNormal.channels.sunDried);

  // 2. sum-bound constraint & inline DistrictNarrowingRule & invalid narrowing error.
  const sumTpl = parseParametricBuildingTemplate({
    id: "sum-bound-test",
    family: "chapel",
    archetypes: ["chapel"],
    footprintRangeM: { min: [4, 4], max: [12, 12] },
    knobSpace: {
      widthM: { kind: "range", min: 4, max: 10, step: 1, default: 6, variationWeight: 1 },
      depthM: { kind: "range", min: 4, max: 10, step: 1, default: 6, variationWeight: 1 },
      floors: { kind: "range", min: 1, max: 3, step: 1, integer: true, default: 1, variationWeight: 0.5 },
    },
    grammarConstraints: [
      { kind: "sum-bound", id: "perimeter-budget", knobs: ["widthM", "depthM"], minSum: 9, maxSum: 13 },
    ],
  });
  for (let s = 1; s <= 20; s++) {
    const r = rollLotVariation(sumTpl, {
      seed: 800 + s,
      district: {
        district: "tight-ward",
        knobOverrides: { floors: { fixedValue: 2 } },
      },
    });
    const sum = (r.knobValues.widthM as number) + (r.knobValues.depthM as number);
    assert.ok(sum >= 9 && sum <= 13);
    assert.equal(r.knobValues.floors, 2);
  }
  assert.throws(() =>
    narrowTemplateForDistrict(sumTpl, {
      district: "broken-ward",
      knobOverrides: { widthM: { min: 9, max: 8 } },
    }),
  );

  // 3. R&D gate enforcement on splatExperiment schema (cannot mark as shipping/production).
  assert.throws(() =>
    parseParametricBuildingTemplate({
      id: "bad-splat-gate",
      family: "chapel",
      archetypes: ["chapel"],
      footprintRangeM: { min: [4, 4], max: [8, 8] },
      knobSpace: {
        floors: { kind: "range", min: 1, max: 2, step: 1, integer: true, default: 1, variationWeight: 0 },
      },
      splatExperiment: {
        treatment: "splat-overlay",
        gateStatus: "production",
        maxSplatBudget: 50,
      },
    }),
  );

  // 4. Spillover cross-quad geometry buffers contain strictly finite coordinates.
  const spill = generateSpilloverDetailLayer(
    {
      id: "finite-check",
      assetSet: "foliage/moss",
      surface: "structure-surface",
      density: 0.8,
      noise: { scale: 0.5, threshold: 0.1 },
      band: { min: 0, max: 0.9 },
      affinity: { weight: 0.8, preference: 0.8 },
      cluster: { size: 1.0, falloff: 0.5 },
      seed: 44,
      budget: 30,
    },
    {
      buildingId: "shed-a",
      buildingBox: { min: [-2, 0, -2], max: [2, 3, 2] },
      weatheringInputs: { moisture: 0.8, aspectDeg: 0, buildingAgeYears: 30, seed: 44 },
    },
  );
  for (let i = 0; i < spill.geometry.positions.length; i++) {
    assert.ok(Number.isFinite(spill.geometry.positions[i]));
  }
  for (let i = 0; i < spill.geometry.uvs.length; i++) {
    assert.ok(Number.isFinite(spill.geometry.uvs[i]));
  }
});
