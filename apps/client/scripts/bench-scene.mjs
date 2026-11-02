/**
 * Scene and PhysX adapter for the client physics benchmark. No Node built-ins:
 * it runs in Node (where physx-js-webidl refuses to load) and in Chromium
 * (where it loads). See bench-physics.mjs and physx-browser-bench.html.
 */
export const SCENE = {
  dt: 1 / 60,
  substeps: 2,
  terrainHalf: 64,
  terrainCells: 128,
  props: 300,
  rigCols: 10,
  rigSpacing: 4,
  character: { radius: 20, speed: 4, halfHeight: 0.9, radius2: 0.4 },
};

/** Radially symmetric terrain, so it reads the same whichever axis a library indexes first. */
export function terrainHeight(x, z) {
  const r = Math.hypot(x, z);
  return 1.5 + 1.2 * Math.sin(0.12 * r) * Math.exp(-r / 80) + 0.3 * Math.cos(0.05 * r);
}

/** Deterministic scatter: a 32-bit LCG, so both libraries get the same props. */
export function propLayout(count = SCENE.props) {
  let seed = 1234567;
  const next = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  const out = [];
  for (let i = 0; i < count; i++) {
    const x = (next() * 2 - 1) * 60;
    const z = (next() * 2 - 1) * 60;
    const size = 0.5 + next();
    out.push({ x, y: terrainHeight(x, z) + size / 2, z, size });
  }
  return out;
}

/**
 * Rig shape: 11 boxes, 10 ball joints, centres relative to the rig root. Parts
 * are laid out so that joined parts only touch, so the rig is not in contact with itself at rest.
 */
export const RIG_PARTS = [
  { c: [0, 1.6, 0], h: [0.1, 0.12, 0.1] }, // head
  { c: [0, 1.15, 0], h: [0.2, 0.3, 0.12] }, // chest
  { c: [0, 0.6, 0], h: [0.18, 0.12, 0.12] }, // pelvis
  { c: [-0.35, 1.15, 0], h: [0.07, 0.25, 0.07] }, // upper arm L
  { c: [0.35, 1.15, 0], h: [0.07, 0.25, 0.07] }, // upper arm R
  { c: [-0.35, 0.66, 0], h: [0.06, 0.22, 0.06] }, // forearm L
  { c: [0.35, 0.66, 0], h: [0.06, 0.22, 0.06] }, // forearm R
  { c: [-0.12, 0.2, 0], h: [0.09, 0.2, 0.09] }, // thigh L
  { c: [0.12, 0.2, 0], h: [0.09, 0.2, 0.09] }, // thigh R
  { c: [-0.12, -0.25, 0], h: [0.08, 0.22, 0.08] }, // shin L
  { c: [0.12, -0.25, 0], h: [0.08, 0.22, 0.08] }, // shin R
];
export const RIG_JOINTS = [[0, 1], [1, 2], [1, 3], [1, 4], [3, 5], [4, 6], [2, 7], [2, 8], [7, 9], [8, 10]];

export function rigRoot(i) {
  const col = i % SCENE.rigCols;
  const row = Math.floor(i / SCENE.rigCols);
  const x = -36 + col * SCENE.rigSpacing;
  const z = -40 + row * SCENE.rigSpacing;
  return { x, y: terrainHeight(x, z) + 2.5, z };
}

export function characterAt(t) {
  const { radius, speed, halfHeight, radius2 } = SCENE.character;
  const w = speed / radius;
  const x = radius * Math.cos(w * t);
  const z = radius * Math.sin(w * t);
  return { x, y: terrainHeight(x, z) + halfHeight + radius2, z };
}

// ---------------------------------------------------------------- PhysX

/**
 * PhysX 5.12 (CPU) through physx-js-webidl. Same scene. Terrain is a height
 * field (int16 samples, 0.01 m units). Substeps are two simulate() calls of
 * dt / 2 each. "Awake" wakes every rig body each tick.
 */
export async function physxAdapter() {
  const PHYSX = (await import("physx-js-webidl")).default;
  const P = await PHYSX();
  const T = P;
  const V = T.PHYSICS_VERSION;
  const foundation = T.CreateFoundation(V, new P.PxDefaultAllocator(), new P.PxDefaultErrorCallback());
  const tol = new P.PxTolerancesScale();
  const physics = T.CreatePhysics(V, foundation, tol);
  T.InitExtensions(physics);
  const identity = () => new P.PxTransform(P.PxIDENTITYEnum.PxIdentity);
  const vec = (x, y, z) => new P.PxVec3(x, y, z);
  const tf = (x, y, z) => new P.PxTransform(vec(x, y, z), new P.PxQuat(0, 0, 0, 1));
  // Embind objects are not garbage collected: every temporary is deleted here.
  const posOf = (actor) => {
    const pose = actor.getGlobalPose();
    const p = pose.p;
    const out = { x: p.x, y: p.y, z: p.z };
    p.delete?.();
    pose.delete?.();
    return out;
  };
  // PhysX's default filter shader only collides shapes whose filter words overlap:
  // zero filter data collides with nothing. Every shape gets the same group.
  const shapeOf = (geom) => {
    const shape = physics.createShape(geom, material, true);
    shape.setSimulationFilterData(new P.PxFilterData(1, 1, 0, 0));
    return shape;
  };
  const staticAt = (pose, geom) => {
    const a = physics.createRigidStatic(pose);
    a.attachShape(shapeOf(geom));
    return a;
  };
  const dynamicAt = (pose, geom, mass = 1) => {
    const a = physics.createRigidDynamic(pose);
    a.attachShape(shapeOf(geom));
    a.setMass(mass);
    a.setMassSpaceInertiaTensor(vec(0.1, 0.1, 0.1));
    return a;
  };
  const setVel = (actor, x, y, z) => {
    const v = vec(x, y, z);
    actor.setLinearVelocity(v, true);
    v.delete?.();
  };
  const setAngVel0 = (actor) => {
    const v = vec(0, 0, 0);
    actor.setAngularVelocity(v, true);
    v.delete?.();
  };
  const cell = SCENE.terrainHalf * 2 / SCENE.terrainCells;
  const material = physics.createMaterial(0.6, 0.6, 0.1);
  return {
    name: "physx",
    build(rigCount, awake) {
      const sceneDesc = new P.PxSceneDesc(tol);
      sceneDesc.gravity = vec(0, -9.81, 0);
      sceneDesc.cpuDispatcher = T.DefaultCpuDispatcherCreate(0); // no worker threads in the wasm build
      sceneDesc.filterShader = T.DefaultFilterShader();
      const scene = physics.createScene(sceneDesc);

      // Terrain: int16 samples in 0.01 m units, row by row.
      const n = SCENE.terrainCells + 1;
      const samples = new P.PxArray_PxHeightFieldSample(n * n);
      for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
        const h = terrainHeight(i * cell - SCENE.terrainHalf, j * cell - SCENE.terrainHalf);
        const sample = new P.PxHeightFieldSample();
        sample.height = Math.round(h / 0.01);
        samples.set(j * n + i, sample);
      }
      const hfDesc = new P.PxHeightFieldDesc();
      hfDesc.nbRows = n;
      hfDesc.nbColumns = n;
      hfDesc.samples.data = samples.begin();
      hfDesc.samples.stride = 4;
      hfDesc.samples.count = n * n;
      const hf = T.CreateHeightField(hfDesc);
      const hfGeom = new P.PxHeightFieldGeometry(hf, new P.PxMeshGeometryFlags(0), 0.01, cell, cell);
      const terrain = staticAt(tf(-SCENE.terrainHalf, 0, -SCENE.terrainHalf), hfGeom);
      scene.addActor(terrain);

      for (const p of propLayout()) {
        const box = staticAt(tf(p.x, p.y, p.z), new P.PxBoxGeometry(p.size / 2, p.size / 2, p.size / 2));
        scene.addActor(box);
      }

      const c0 = characterAt(0);
      // PhysX capsules lie along X by default: turn the walker upright (90 degrees about Z).
      const walker = physics.createRigidDynamic(tf(c0.x, c0.y, c0.z));
      const walkerShape = physics.createShape(
        new P.PxCapsuleGeometry(SCENE.character.radius2, SCENE.character.halfHeight), material, true);
      walkerShape.setLocalPose(new P.PxTransform(vec(0, 0, 0), new P.PxQuat(0, 0, Math.SQRT1_2, Math.SQRT1_2)));
      walkerShape.setSimulationFilterData(new P.PxFilterData(1, 1, 0, 0));
      walker.attachShape(walkerShape);
      walker.setMass(1);
      walker.setMassSpaceInertiaTensor(vec(0.1, 0.1, 0.1));
      walker.setRigidDynamicLockFlags(new P.PxRigidDynamicLockFlags(P.PxRigidDynamicLockFlagEnum.PxRigidDynamicLockFlag_eLOCK_ANGULAR_X | 0));
      scene.addActor(walker);

      const rigs = [];
      for (let r = 0; r < rigCount; r++) {
        const root = rigRoot(r);
        const bodies = RIG_PARTS.map((p) => {
          const body = dynamicAt(tf(root.x + p.c[0], root.y + p.c[1], root.z + p.c[2]),
            new P.PxBoxGeometry(...p.h));
          scene.addActor(body);
          return body;
        });
        for (const [a, b] of RIG_JOINTS) {
          const pa = RIG_PARTS[a].c, pb = RIG_PARTS[b].c;
          const mid = [0, 1, 2].map((k) => (pa[k] + pb[k]) / 2);
          const local = (pc) => tf(mid[0] - pc[0], mid[1] - pc[1], mid[2] - pc[2]);
          T.SphericalJointCreate(physics, bodies[a], local(pa), bodies[b], local(pb));
        }
        rigs.push(bodies);
      }

      let lastT = 0;
      return {
        step(t) {
          lastT = t;
          const target = characterAt(t);
          const p = posOf(walker);
          const inv = 1 / SCENE.dt;
          setVel(walker, (target.x - p.x) * inv, (target.y - p.y) * inv, (target.z - p.z) * inv);
          setAngVel0(walker);
          if (awake) for (const bodies of rigs) for (const b of bodies) b.wakeUp();
          for (let s = 0; s < SCENE.substeps; s++) {
            scene.simulate(SCENE.dt / SCENE.substeps);
            scene.fetchResults(true);
          }
        },
        stats() {
          let fellThrough = 0, nonFinite = 0;
          for (const bodies of rigs) for (const b of bodies) {
            const p = posOf(b);
            if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) nonFinite++;
            else if (p.y < terrainHeight(p.x, p.z) - 1) fellThrough++;
          }
          const cp = posOf(walker);
          const want = characterAt(lastT);
          const charErr = Math.hypot(cp.x - want.x, cp.y - want.y, cp.z - want.z);
          return { bodies: scene.getNbActors(P.PxActorTypeFlagEnum.eRIGID_DYNAMIC), fellThrough, nonFinite,
            charErr, charX: cp.x };
        },
        free() { scene.release?.(); },
      };
    },
  };
}

// ---------------------------------------------------------------- Rapier

export async function rapierAdapter() {
  const RAPIER = (await import("@dimforge/rapier3d-compat")).default;
  await RAPIER.init();
  const cell = SCENE.terrainHalf * 2 / SCENE.terrainCells;
  return {
    name: "rapier",
    build(rigCount, awake) {
      const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
      world.timestep = SCENE.dt / SCENE.substeps;
      const n = SCENE.terrainCells + 1;
      const heights = new Float32Array(n * n);
      for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
        heights[j * n + i] = terrainHeight(i * cell - SCENE.terrainHalf, j * cell - SCENE.terrainHalf);
      }
      world.createCollider(RAPIER.ColliderDesc.heightfield(SCENE.terrainCells, SCENE.terrainCells, heights,
        { x: SCENE.terrainHalf * 2, y: 1, z: SCENE.terrainHalf * 2 }));
      for (const p of propLayout()) {
        world.createCollider(RAPIER.ColliderDesc.cuboid(p.size / 2, p.size / 2, p.size / 2)
          .setTranslation(p.x, p.y, p.z), undefined);
      }
      // The character is dynamic (rotation locked) and steered by velocity, so it
      // collides with the terrain and props as a real walker does.
      const c0 = characterAt(0);
      const character = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(c0.x, c0.y, c0.z).lockRotations().setCanSleep(false));
      world.createCollider(RAPIER.ColliderDesc.capsule(SCENE.character.halfHeight, SCENE.character.radius2), character);
      const rigs = [];
      for (let r = 0; r < rigCount; r++) {
        const root = rigRoot(r);
        const bodies = RIG_PARTS.map((p) => {
          const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic()
            .setTranslation(root.x + p.c[0], root.y + p.c[1], root.z + p.c[2])
            .setCanSleep(!awake));
          world.createCollider(RAPIER.ColliderDesc.cuboid(...p.h), body);
          return body;
        });
        for (const [a, b] of RIG_JOINTS) {
          const pa = RIG_PARTS[a].c, pb = RIG_PARTS[b].c;
          const mid = [0, 1, 2].map((k) => (pa[k] + pb[k]) / 2);
          const local = (pc) => ({ x: mid[0] - pc[0], y: mid[1] - pc[1], z: mid[2] - pc[2] });
          world.createImpulseJoint(RAPIER.JointData.spherical(local(pa), local(pb)), bodies[a], bodies[b], true);
        }
        rigs.push(bodies);
      }
      let lastT = 0;
      return {
        world,
        step(t) {
          lastT = t;
          // Two substeps at dt / 2 each, as the engine's tick does.
          const target = characterAt(t);
          const p = character.translation();
          const inv = 1 / SCENE.dt;
          character.setLinvel({ x: (target.x - p.x) * inv, y: (target.y - p.y) * inv, z: (target.z - p.z) * inv }, true);
          for (let s = 0; s < SCENE.substeps; s++) world.step();
        },
        stats() {
          let fellThrough = 0, nonFinite = 0;
          for (const bodies of rigs) for (const b of bodies) {
            const p = b.translation();
            if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) nonFinite++;
            else if (p.y < terrainHeight(p.x, p.z) - 1) fellThrough++;
          }
          const t = characterAt(lastT);
          const cp = character.translation();
          const charErr = Math.hypot(cp.x - t.x, cp.y - t.y, cp.z - t.z);
          return { bodies: world.bodies.len(), fellThrough, nonFinite, charErr };
        },
        free() { world.free(); },
      };
    },
  };
}

// ---------------------------------------------------------------- Jolt

export async function joltAdapter() {
  const Jolt = (await import("jolt-physics/wasm-compat")).default;
  const J = await Jolt();
  const NON_MOVING = 0, MOVING = 1;
  return {
    name: "jolt",
    build(rigCount, awake) {
      const pairFilter = new J.ObjectLayerPairFilterTable(2);
      pairFilter.EnableCollision(NON_MOVING, MOVING);
      pairFilter.EnableCollision(MOVING, MOVING);
      const bpLayers = new J.BroadPhaseLayerInterfaceTable(2, 2);
      bpLayers.MapObjectToBroadPhaseLayer(NON_MOVING, new J.BroadPhaseLayer(0));
      bpLayers.MapObjectToBroadPhaseLayer(MOVING, new J.BroadPhaseLayer(1));
      const vsFilter = new J.ObjectVsBroadPhaseLayerFilterTable(bpLayers, 2, pairFilter, 2);
      const settings = new J.JoltSettings();
      settings.mMaxBodies = 20000;
      settings.mMaxBodyPairs = 65536;
      settings.mMaxContactConstraints = 10240;
      settings.mBroadPhaseLayerInterface = bpLayers;
      settings.mObjectVsBroadPhaseLayerFilter = vsFilter;
      settings.mObjectLayerPairFilter = pairFilter;
      const jolt = new J.JoltInterface(settings);
      J.destroy(settings);
      const system = jolt.GetPhysicsSystem();
      system.SetGravity(new J.Vec3(0, -9.81, 0));
      const bi = system.GetBodyInterface();

      const { EMotionType_Static, EMotionType_Kinematic, EMotionType_Dynamic, EActivation_Activate, EActivation_DontActivate } = J;
      const shapeOf = (settings) => settings.Create().Get();
      const boxShape = (hx, hy, hz) => shapeOf(new J.BoxShapeSettings(new J.Vec3(hx, hy, hz), 0.05));
      const addBody = (shape, x, y, z, motion, layer, activation, canSleep = true) => {
        const s = new J.BodyCreationSettings(shape, new J.RVec3(x, y, z), new J.Quat(0, 0, 0, 1), motion, layer);
        s.mAllowSleeping = canSleep;
        const body = bi.CreateBody(s);
        J.destroy(s);
        bi.AddBody(body.GetID(), activation);
        return body;
      };

      // Terrain: a heightfield with 1 m cells, centred on the origin like Rapier's.
      const n = SCENE.terrainCells + 1;
      const cell = SCENE.terrainHalf * 2 / SCENE.terrainCells;
      const hf = new J.HeightFieldShapeSettings();
      hf.mOffset = new J.Vec3(-SCENE.terrainHalf, 0, -SCENE.terrainHalf);
      hf.mScale = new J.Vec3(cell, 1, cell);
      hf.mSampleCount = n;
      for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
        hf.mHeightSamples.push_back(terrainHeight(i * cell - SCENE.terrainHalf, j * cell - SCENE.terrainHalf));
      }
      addBody(shapeOf(hf), 0, 0, 0, EMotionType_Static, NON_MOVING, EActivation_DontActivate);

      const propShapes = new Map();
      for (const p of propLayout()) {
        const key = p.size.toFixed(4);
        if (!propShapes.has(key)) propShapes.set(key, boxShape(p.size / 2, p.size / 2, p.size / 2));
        addBody(propShapes.get(key), p.x, p.y, p.z, EMotionType_Static, NON_MOVING, EActivation_DontActivate);
      }

      const c0 = characterAt(0);
      const character = addBody(new J.CapsuleShapeSettings(SCENE.character.halfHeight, SCENE.character.radius2)
        .Create().Get(), c0.x, c0.y, c0.z, EMotionType_Dynamic, MOVING, EActivation_Activate, false);

      const rigShapes = RIG_PARTS.map((p) => boxShape(...p.h));
      const rigs = [];
      for (let r = 0; r < rigCount; r++) {
        const root = rigRoot(r);
        const bodies = RIG_PARTS.map((p, k) => addBody(rigShapes[k], root.x + p.c[0], root.y + p.c[1], root.z + p.c[2],
          EMotionType_Dynamic, MOVING, EActivation_Activate, !awake));
        for (const [a, b] of RIG_JOINTS) {
          const pa = RIG_PARTS[a].c, pb = RIG_PARTS[b].c;
          const mid = [0, 1, 2].map((k) => (pa[k] + pb[k]) / 2);
          const cs = new J.PointConstraintSettings();
          cs.mSpace = J.EConstraintSpace_WorldSpace;
          cs.mPoint1 = new J.RVec3(root.x + mid[0], root.y + mid[1], root.z + mid[2]);
          cs.mPoint2 = cs.mPoint1;
          system.AddConstraint(cs.Create(bodies[a], bodies[b]));
        }
        rigs.push(bodies);
      }

      let lastT = 0;
      return {
        step(t) {
          lastT = t;
          const target = characterAt(t);
          const p = bi.GetPosition(character.GetID());
          const inv = 1 / SCENE.dt;
          bi.SetLinearVelocity(character.GetID(), new J.Vec3((target.x - p.GetX()) * inv,
            (target.y - p.GetY()) * inv, (target.z - p.GetZ()) * inv));
          J.destroy(p);
          bi.SetAngularVelocity(character.GetID(), new J.Vec3(0, 0, 0));
          jolt.Step(SCENE.dt, SCENE.substeps);
        },
        stats() {
          let fellThrough = 0, nonFinite = 0;
          const ids = [];
          for (const bodies of rigs) for (const b of bodies) ids.push(b.GetID());
          for (const id of ids) {
            const p = bi.GetPosition(id);
            const x = p.GetX(), y = p.GetY(), z = p.GetZ();
            if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) nonFinite++;
            else if (y < terrainHeight(x, z) - 1) fellThrough++;
            J.destroy(p);
          }
          const t = characterAt(lastT);
          const cp = bi.GetPosition(character.GetID());
          const charErr = Math.hypot(cp.GetX() - t.x, cp.GetY() - t.y, cp.GetZ() - t.z);
          J.destroy(cp);
          return { bodies: system.GetNumBodies(), fellThrough, nonFinite, charErr };
        },
        free() { J.destroy(jolt); },
      };
    },
  };
}

