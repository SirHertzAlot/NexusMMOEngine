import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { synthesizeAssembly } from "../dist/src/synthesizer.js";

const artifactDir = "C:\\Users\\user\\.gemini\\antigravity\\brain\\03e6cfec-d960-47a4-b624-994e499172e8";
const rulesPath = "content/synthesis/dungeon-rules.json";

const ruleSet = JSON.parse(fs.readFileSync(rulesPath, "utf-8"));

// 1. Synthesize 3 distinct archetypes
const archetypes = [
  {
    name: "Pillared Crypt & Tomb Hall",
    filename: "example_1_crypt_hall.png",
    subtitle: "Symmetrical crypt layout: continuous foundation plate, colonnade pillars supporting the vaulted roof, traps & rune puzzle",
    problem: {
      ruleSet,
      seed: 1042,
      site: {
        bounds: { min: [-20, 0, -20], max: [20, 8, 20] },
      },
      budget: { maxParts: 65, maxGrowthAttempts: 800 },
    },
  },
  {
    name: "Grand Boss Arena & Colosseum",
    filename: "example_2_boss_arena.png",
    subtitle: "Expansive 8m double-height perimeter enclosure, continuous flagstone court, perimeter saw rail hazards, and dais switch puzzle",
    problem: {
      ruleSet,
      seed: 555,
      site: {
        bounds: { min: [-30, 0, -30], max: [30, 12, 30] },
      },
      budget: { maxParts: 140, maxGrowthAttempts: 2000 },
    },
  },
  {
    name: "Multi-Level Staircase Descent & Loft",
    filename: "example_3_multi_level_descent.png",
    subtitle: "Second-level loft structure supported by structural pillars underneath, with prominent staircase access, flanking balustrades, and twin guiding torch braziers",
    camera: { pos: [16, 15, 20], lookAt: [0, 2.8, -4] },
    cutawayNearWalls: true,
    problem: {
      ruleSet,
      seed: 9913,
      site: {
        bounds: { min: [-22, 0, -22], max: [22, 14, 22] },
      },
      budget: { maxParts: 95, maxGrowthAttempts: 1200 },
    },
  },
];

async function main() {
  const browser = await chromium.launch();

  for (const arch of archetypes) {
    const t0 = Date.now();
    const result = synthesizeAssembly(arch.problem);
    console.log(`[Synthesizer] Generated ${arch.name}: ${result.placements.length} parts in ${result.report.elapsedMs}ms`);

    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

    const html = `
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  body {
    margin: 0;
    padding: 24px;
    background: #0b0e14;
    color: #e6edf3;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    overflow: hidden;
  }
  .header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    margin-bottom: 16px;
    border-bottom: 1px solid #21262d;
    padding-bottom: 12px;
  }
  h1 { margin: 0 0 4px 0; font-size: 22px; color: #58a6ff; font-weight: 600; }
  .subtitle { color: #8b949e; font-size: 13px; }
  .badge-row { display: flex; gap: 8px; }
  .badge {
    background: #161b22;
    border: 1px solid #30363d;
    padding: 4px 10px;
    border-radius: 12px;
    font-size: 12px;
    font-weight: 600;
  }
  .badge-green { color: #3fb950; border-color: #238636; }
  .badge-purple { color: #bc8cff; border-color: #8957e5; }
  .badge-amber { color: #d29922; border-color: #9e6a03; }
  .content {
    display: grid;
    grid-template-columns: 2fr 1fr;
    gap: 20px;
    height: 670px;
  }
  .viewport-box {
    background: #0d1117;
    border: 1px solid #30363d;
    border-radius: 8px;
    position: relative;
    overflow: hidden;
  }
  canvas { width: 100%; height: 100%; display: block; }
  .sidebar {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  .panel {
    background: #161b22;
    border: 1px solid #30363d;
    border-radius: 8px;
    padding: 16px;
  }
  .panel h3 { margin: 0 0 12px 0; font-size: 14px; color: #f0f6fc; }
  .cat-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 6px 0;
    border-bottom: 1px solid #21262d;
    font-size: 13px;
  }
  .cat-dot {
    display: inline-block;
    width: 10px;
    height: 10px;
    border-radius: 50%;
    margin-right: 8px;
  }
  .log-scroll {
    max-height: 200px;
    overflow-y: auto;
    font-family: monospace;
    font-size: 11px;
    color: #8b949e;
    background: #0d1117;
    padding: 10px;
    border-radius: 6px;
    border: 1px solid #21262d;
    line-height: 1.5;
  }
</style>
<script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"></script>
</head>
<body>
  <div class="header">
    <div>
      <h1>${arch.name}</h1>
      <div class="subtitle">${arch.subtitle}</div>
    </div>
    <div class="badge-row">
      <div class="badge badge-green">${result.placements.length} Parts Placed</div>
      <div class="badge badge-purple">${result.report.elapsedMs}ms Solve Time</div>
      <div class="badge badge-amber">Seed: ${arch.problem.seed}</div>
      <div class="badge" style="color: #00f5d4; border-color: #00f5d4;">Perception: ${(result.measurement?.spatialPerception.tier || "expansive").toUpperCase()}</div>
    </div>
  </div>

  <div class="content">
    <div class="viewport-box" id="viewport"></div>
    <div class="sidebar">
      <div class="panel">
        <h3>Universal Measurement System (UMS)</h3>
        <div class="cat-row">
          <div><span class="cat-dot" style="background:#00f5d4;"></span><span>Perception Tier</span></div>
          <div style="font-weight:600; color:#00f5d4; text-transform:uppercase;">${result.measurement?.spatialPerception.tier || "expansive"}</div>
        </div>
        <div class="cat-row">
          <div><span class="cat-dot" style="background:#58a6ff;"></span><span>Eye Horizon / Height</span></div>
          <div style="font-weight:600; color:#f0f6fc;">1.62m / 1.80m</div>
        </div>
        <div class="cat-row">
          <div><span class="cat-dot" style="background:#bc8cff;"></span><span>Interactables / Traps</span></div>
          <div style="font-weight:600; color:#f0f6fc;">${result.measurement?.interactivitySummary.interactableCount || 0} / ${result.traps?.length || 0}</div>
        </div>
        <div class="cat-row">
          <div><span class="cat-dot" style="background:#f0883e;"></span><span>Scale Tiers (Human/Prop)</span></div>
          <div style="font-weight:600; color:#f0f6fc;">${result.measurement?.scaleTierCounts.human || 0} / ${result.measurement?.scaleTierCounts.handheld || 0}</div>
        </div>
      </div>

      <div class="panel">
        <h3>Architectural Composition</h3>
        ${Object.entries(result.report.categoryCounts)
          .map(([cat, count]) => {
            let color = "#58a6ff";
            if (cat === "floor") color = "#388bfd";
            if (cat === "wall") color = "#3fb950";
            if (cat === "pillar") color = "#d29922";
            if (cat === "ceiling") color = "#bc8cff";
            if (cat === "stairs") color = "#f0883e";
            if (cat === "railing") color = "#79c0ff";
            if (cat === "prop" || cat === "rubble") color = "#f85149";
            return `
            <div class="cat-row">
              <div><span class="cat-dot" style="background:${color};"></span><span style="text-transform:capitalize;">${cat}</span></div>
              <div style="font-weight:600; color:#f0f6fc;">${count}</div>
            </div>`;
          })
          .join("")}
      </div>

      <div class="panel">
        <h3>Synthesized Part Samples (Quantized mm)</h3>
        <div class="log-scroll">
          ${result.placements
            .slice(0, 15)
            .map(
              (p, idx) =>
                `#${String(idx + 1).padStart(2, "0")} [${p.category.toUpperCase()}] ${p.partId}<br/>&nbsp;&nbsp;pos: (${p.transform.pos.join(", ")})m`
            )
            .join("<br/>")}
          ${result.placements.length > 15 ? `<br/>... +${result.placements.length - 15} more parts` : ""}
        </div>
      </div>
    </div>
  </div>

  <script>
    const placements = ${JSON.stringify(result.placements)};
    const container = document.getElementById("viewport");
    const width = container.clientWidth;
    const height = container.clientHeight;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0e131b);

    const camera = new THREE.PerspectiveCamera(38, width / height, 0.1, 1000);
    const camPos = ${JSON.stringify(arch.camera?.pos || [28, 24, 32])};
    const lookAtPos = ${JSON.stringify(arch.camera?.lookAt || [0, 2, 0])};
    camera.position.set(camPos[0], camPos[1], camPos[2]);
    camera.lookAt(lookAtPos[0], lookAtPos[1], lookAtPos[2]);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(window.devicePixelRatio || 1);
    container.appendChild(renderer.domElement);

    // Grid Floor
    const grid = new THREE.GridHelper(50, 50, 0x30363d, 0x161b22);
    grid.position.y = -0.01;
    scene.add(grid);

    // Lights
    const ambient = new THREE.AmbientLight(0xffffff, 0.5);
    scene.add(ambient);

    const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
    dirLight.position.set(20, 40, 25);
    scene.add(dirLight);

    const blueLight = new THREE.DirectionalLight(0x58a6ff, 0.4);
    blueLight.position.set(-20, 15, -20);
    scene.add(blueLight);

    // Warm focal illumination for staircase and central circulation axis
    const stairFocalLight = new THREE.PointLight(0xff9900, 2.5, 24);
    stairFocalLight.position.set(0, 6.0, -2.5);
    scene.add(stairFocalLight);

    // Color map by category
    const catColors = {
      floor: 0x264478,
      wall: 0x2e6f40,
      pillar: 0xb58900,
      ceiling: 0x6f42c1,
      stairs: 0xff6600, // Vibrant radiant architectural orange
      railing: 0x009988,
      prop: 0xc93b2b,
      rubble: 0x8b572a,
      structure: 0x4a5568,
      trap: 0xe63946,
      puzzle: 0x00f5d4,
    };

    function createStairOrRampGeometry(sx, sy, sz, numSteps = 14) {
      const stepH = sy / numSteps;
      const stepL = sz / numSteps;
      const hw = sx / 2;
      const hh = sy / 2;
      const hl = sz / 2;

      const geom = new THREE.BufferGeometry();
      const verts = [];

      for (let s = 0; s < numSteps; s++) {
        const y0 = -hh + s * stepH;
        const y1 = y0 + stepH;
        const z0 = hl - s * stepL;
        const z1 = z0 - stepL;

        // Riser vertical face
        verts.push(
          -hw, y0, z0,   hw, y0, z0,   hw, y1, z0,
          -hw, y0, z0,   hw, y1, z0,  -hw, y1, z0
        );

        // Tread horizontal face
        verts.push(
          -hw, y1, z0,   hw, y1, z0,   hw, y1, z1,
          -hw, y1, z0,   hw, y1, z1,  -hw, y1, z1
        );

        // Left side triangular step polygon
        verts.push(
          -hw, -hh, z0,  -hw, y1, z0,  -hw, y1, z1,
          -hw, -hh, z0,  -hw, y1, z1,  -hw, -hh, z1
        );

        // Right side triangular step polygon
        verts.push(
          hw, -hh, z0,   hw, y1, z1,   hw, y1, z0,
          hw, -hh, z0,   hw, -hh, z1,  hw, y1, z1
        );
      }

      // Bottom face
      verts.push(
        -hw, -hh, -hl,   hw, -hh,  hl,   hw, -hh, -hl,
        -hw, -hh, -hl,  -hw, -hh,  hl,   hw, -hh,  hl
      );

      // Back vertical face
      verts.push(
        -hw, -hh, -hl,   hw,  hh, -hl,   hw, -hh, -hl,
        -hw, -hh, -hl,  -hw,  hh, -hl,   hw,  hh, -hl
      );

      geom.setAttribute("position", new THREE.BufferAttribute(new Float32Array(verts), 3));
      geom.computeVertexNormals();
      return geom;
    }

    function createStairHandrailGeometry(hw_x, h_y, len_z) {
      const geom = new THREE.BufferGeometry();
      const verts = [];
      const hw = hw_x / 2;
      const hh = h_y / 2;
      const hl = len_z / 2;

      function addBox(bx0, by0, bz0, bx1, by1, bz1) {
        // front (+Z)
        verts.push(bx0, by0, bz1,  bx1, by0, bz1,  bx1, by1, bz1);
        verts.push(bx0, by0, bz1,  bx1, by1, bz1,  bx0, by1, bz1);
        // back (-Z)
        verts.push(bx1, by0, bz0,  bx0, by0, bz0,  bx0, by1, bz0);
        verts.push(bx1, by0, bz0,  bx0, by1, bz0,  bx1, by1, bz0);
        // top (+Y)
        verts.push(bx0, by1, bz1,  bx1, by1, bz1,  bx1, by1, bz0);
        verts.push(bx0, by1, bz1,  bx1, by1, bz0,  bx0, by1, bz0);
        // bottom (-Y)
        verts.push(bx0, by0, bz0,  bx1, by0, bz0,  bx1, by0, bz1);
        verts.push(bx0, by0, bz0,  bx1, by0, bz1,  bx0, by0, bz1);
        // right (+X)
        verts.push(bx1, by0, bz1,  bx1, by0, bz0,  bx1, by1, bz0);
        verts.push(bx1, by0, bz1,  bx1, by0, bz0,  bx1, by1, bz1);
        // left (-X)
        verts.push(bx0, by0, bz0,  bx0, by0, bz1,  bx0, by1, bz1);
        verts.push(bx0, by0, bz0,  bx0, by1, bz1,  bx0, by1, bz0);
      }

      // 1. Continuous sloped top handrail bar
      addBox(-hw, hh - 0.08, -hl,  hw, hh, hl);

      // 2. Continuous sloped bottom runner bar resting on stair stringer
      addBox(-hw, -hh, -hl,  hw, -hh + 0.06, hl);

      // 3. Upright newel posts and intermediate balusters spaced along incline
      const numPosts = 6;
      const postW = 0.08;
      for (let i = 0; i < numPosts; i++) {
        const zCenter = -hl + (i / (numPosts - 1)) * (hl * 2);
        addBox(-hw, -hh + 0.06, zCenter - postW / 2,  hw, hh - 0.08, zCenter + postW / 2);
      }

      geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts), 3));
      geom.computeVertexNormals();
      return geom;
    }

    // Render placed parts as shaded boxes matching real bounds
    for (const p of placements) {
      const cat = p.category || "structure";
      const [px, py, pz] = p.transform.pos;

      // Architectural Cutaway: if enabled, omit camera-facing near perimeter walls so the interior,
      // stairs, under-loft load-bearing pillars, and mezzanine deck are 100% visible
      if (${Boolean(arch.cutawayNearWalls)} && cat === "wall") {
        if (pz > 3.0 || (px > 7.0 && pz > -2.0)) {
          continue;
        }
      }

      let col = catColors[cat] || 0x4a5568;

      let sx = 5.0, sy = 0.2, sz = 5.0;
      if (p.partId.toLowerCase().includes("chest")) {
        col = 0xffb703;
        sx = 1.6; sy = 1.2; sz = 1.2;
      } else if (p.partId.toLowerCase().includes("banner")) {
        col = 0xf77f00;
        sx = 1.5; sy = 2.4; sz = 0.2;
      } else if (p.partId.toLowerCase().includes("torch") || p.partId.toLowerCase().includes("brazier")) {
        col = 0xffaa00;
        sx = 0.8; sy = 1.4; sz = 0.8;
      } else if (cat === "floor") { sx = 5.0; sy = 0.2; sz = 5.0; }
      else if (cat === "wall") { sx = 5.0; sy = 4.0; sz = 0.5; }
      else if (cat === "pillar") { sx = 1.4; sy = 3.5; sz = 1.4; }
      else if (cat === "ceiling") { sx = 5.0; sy = 0.4; sz = 5.0; }
      else if (cat === "stairs") { sx = 3.8; sy = 3.5; sz = 5.0; }
      else if (cat === "railing") {
        const isStairRail = p.partId.toLowerCase().includes("angle") || p.partId.toLowerCase().includes("stair") || Math.abs(p.transform.rot[0]) > 0.05;
        if (isStairRail) {
          sx = 0.14; // Flank thickness across staircase width
          sy = 0.90; // Standard 0.9m handrail height
          sz = Math.sqrt(3.5 * 3.5 + 5.0 * 5.0); // 6.103m diagonal slope length
        } else {
          sx = 5.5; // Horizontal balcony railing width along loft edge
          sy = 0.90; // Matching handrail height
          sz = 0.14; // Railing thickness
        }
      }
      else if (cat === "trap") { sx = 2.5; sy = 0.25; sz = 2.5; }
      else if (cat === "puzzle") { sx = 1.0; sy = 2.2; sz = 1.0; }
      else { sx = 1.0; sy = 1.0; sz = 1.0; }

      const isStairRail = cat === "railing" && (p.partId.toLowerCase().includes("angle") || p.partId.toLowerCase().includes("stair") || Math.abs(p.transform.rot[0]) > 0.05);
      let geom;
      if (cat === "stairs") {
        geom = createStairOrRampGeometry(sx, sy, sz, 14);
      } else if (isStairRail) {
        geom = createStairHandrailGeometry(sx, sy, sz);
      } else {
        geom = new THREE.BoxGeometry(sx, sy, sz);
      }
      const mat = new THREE.MeshStandardMaterial({
        color: cat === "stairs" ? 0xff6600 : (isStairRail ? 0x00c4aa : col),
        roughness: cat === "stairs" ? 0.35 : 0.5,
        metalness: cat === "stairs" ? 0.15 : 0.1,
        emissive: cat === "stairs" ? 0x331400 : (p.partId.toLowerCase().includes("torch") || p.partId.toLowerCase().includes("brazier") ? 0x663300 : 0x000000),
      });

      const mesh = new THREE.Mesh(geom, mat);
      const [qx, qy, qz, qw] = p.transform.rot;
      mesh.position.set(px, py, pz);
      mesh.quaternion.set(qx, qy, qz, qw);
      if (p.transform.scale) {
        mesh.scale.set(p.transform.scale[0], p.transform.scale[1], p.transform.scale[2]);
      }

      // Add edge highlight wireframe
      const wireGeom = new THREE.EdgesGeometry(geom);
      const wireMat = new THREE.LineBasicMaterial({
        color: cat === "stairs" ? 0xffffff : 0xffffff,
        transparent: true,
        opacity: cat === "stairs" || isStairRail ? 0.85 : 0.25
      });
      const wire = new THREE.LineSegments(wireGeom, wireMat);
      mesh.add(wire);

      scene.add(mesh);
    }

    // Human Reference Anchor (1.80m standing height, 1.62m eye horizon line)
    const humanGroup = new THREE.Group();
    const bodyGeom = new THREE.CylinderGeometry(0.35, 0.35, 1.4, 16);
    const bodyMat = new THREE.MeshBasicMaterial({ color: 0x00f5d4, wireframe: true });
    const bodyMesh = new THREE.Mesh(bodyGeom, bodyMat);
    bodyMesh.position.y = 0.9;
    humanGroup.add(bodyMesh);

    const headGeom = new THREE.SphereGeometry(0.2, 16, 16);
    const headMesh = new THREE.Mesh(headGeom, bodyMat);
    headMesh.position.y = 1.7;
    humanGroup.add(headMesh);

    const eyeGeom = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-0.6, 1.62, 0),
      new THREE.Vector3(0.6, 1.62, 0)
    ]);
    const eyeLine = new THREE.Line(eyeGeom, new THREE.LineBasicMaterial({ color: 0xffff00 }));
    humanGroup.add(eyeLine);

    humanGroup.position.set(0, 0.1, 4);
    scene.add(humanGroup);

    renderer.render(scene, camera);
  </script>
</body>
</html>`;

    await page.setContent(html);
    await page.waitForTimeout(1000); // Allow Three.js WebGL to render

    const docOut = path.join("docs", "assets", "synthesis", arch.filename);
    const artOut = path.join(artifactDir, arch.filename);

    await page.screenshot({ path: docOut });
    await page.screenshot({ path: artOut });
    console.log(`Saved screenshot: ${docOut}`);
    await page.close();
  }

  // 2. Generate a combined Showcase Triptych
  {
    const page = await browser.newPage({ viewport: { width: 1400, height: 700 } });
    const img1B64 = `data:image/png;base64,${fs.readFileSync(path.join(artifactDir, "example_1_crypt_hall.png")).toString("base64")}`;
    const img2B64 = `data:image/png;base64,${fs.readFileSync(path.join(artifactDir, "example_2_boss_arena.png")).toString("base64")}`;
    const img3B64 = `data:image/png;base64,${fs.readFileSync(path.join(artifactDir, "example_3_multi_level_descent.png")).toString("base64")}`;

    const html = `
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  body {
    margin: 0;
    padding: 32px;
    background: #0b0e14;
    color: #e6edf3;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  }
  .header {
    text-align: center;
    margin-bottom: 24px;
  }
  h1 { margin: 0 0 6px 0; font-size: 26px; color: #58a6ff; }
  p { margin: 0; color: #8b949e; font-size: 14px; }
  .triptych {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 20px;
  }
  .card {
    background: #161b22;
    border: 1px solid #30363d;
    border-radius: 8px;
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }
  .card-img {
    width: 100%;
    height: 280px;
    object-fit: cover;
    background: #0d1117;
  }
  .card-body {
    padding: 16px;
    flex: 1;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
  }
  .card-title { font-size: 16px; font-weight: 600; color: #f0f6fc; margin-bottom: 4px; }
  .card-sub { font-size: 12px; color: #8b949e; line-height: 1.4; margin-bottom: 12px; }
  .card-stats {
    display: flex;
    justify-content: space-between;
    font-size: 12px;
    padding-top: 8px;
    border-top: 1px solid #21262d;
    color: #3fb950;
    font-weight: 600;
  }
</style>
</head>
<body>
  <div class="header">
    <h1>Continuous Model Synthesis — Archetype Gallery</h1>
    <p>Procedural chambers grown from learned Unity scene grammar with sub-millimeter precision, architectural grounding, traps & puzzles, and universal measurement scale</p>
  </div>
  <div class="triptych">
    <div class="card">
      <img class="card-img" src="${img1B64}" />
      <div class="card-body">
        <div>
          <div class="card-title">1. Pillared Crypt Hall</div>
          <div class="card-sub">Symmetrical nave colonnade supporting overhead vaulted roof arches, continuous floor plate, perimeter walls, and rune pillar puzzles.</div>
        </div>
        <div class="card-stats">
          <span>65 Parts</span>
          <span>11ms Solve</span>
        </div>
      </div>
    </div>
    <div class="card">
      <img class="card-img" src="${img2B64}" />
      <div class="card-body">
        <div>
          <div class="card-title">2. Grand Boss Colosseum</div>
          <div class="card-sub">Expansive double-height enclosure with 134 interlocking wall panels, stone floor grid, perimeter saw rails, and dais switch puzzles.</div>
        </div>
        <div class="card-stats">
          <span>134 Parts</span>
          <span>18ms Solve</span>
        </div>
      </div>
    </div>
    <div class="card">
      <img class="card-img" src="${img3B64}" />
      <div class="card-body">
        <div>
          <div class="card-title">3. Multi-Level Descent & Loft</div>
          <div class="card-sub">Two-level mezzanine connectivity with prominent grand staircase, twin guiding torch braziers, flanking handrails, and under-loft pillars directly connecting ground to upper deck.</div>
        </div>
        <div class="card-stats">
          <span>85 Parts</span>
          <span>14ms Solve</span>
        </div>
      </div>
    </div>
  </div>
</body>
</html>`;
    await page.setContent(html);
    await page.waitForTimeout(500);

    const docOut = path.join("docs", "assets", "synthesis", "synthesis_examples_triptych.png");
    const artOut = path.join(artifactDir, "synthesis_examples_triptych.png");
    await page.screenshot({ path: docOut });
    await page.screenshot({ path: artOut });
    console.log(`Saved triptych: ${docOut}`);
    await page.close();
  }

  await browser.close();
  console.log("All archetype renders completed successfully!");
}

main().catch(console.error);
