#!/usr/bin/env node
/**
 * `npm run bake:all`: bake everything the game needs, in dependency order,
 * into the folders the MMO_* path variables name (scripts/lib/bake-paths.mjs;
 * README "Baking everything"). Plain Node, no dependencies, any cwd.
 *
 *   npm run bake:all                       every step; steps whose outputs exist are skipped
 *   npm run bake:all -- --force            rebuild everything (the world too: stop the server first)
 *   npm run bake:all -- --only settlement,scale-fit      just those (the build comes along)
 *   npm run bake:all -- --skip dungeons,loot
 *   npm run bake:all -- --dry-run          print the plan and the commands, run nothing
 *   npm run bake:all -- --sites 3 --population 600 --auto-size --seed 1234 --settlement-id 0001
 *   npm run bake:all -- --data-dir D:/bake/data --content-dir D:/bake/content --assets-dir D:/art
 *
 * Steps (see STEPS in lib/bake-plan.mjs): build, world, loot, dungeons,
 * settlement (best sites first, one id each), scale-fit, wildlife-plan,
 * wildlife-models (these three need the art catalog; without it they are
 * skipped with a warning and the towns are stand-in boxes), env (prints, and
 * writes <content>/bake-env.local.txt, the MMO_* block that starts the server
 * on this bake). Stops at the first failure and prints the command to rerun.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PATH_FLAGS, resolvePaths } from "./lib/bake-paths.mjs";
import { STEPS, parseBakeArgs, planSteps, settlementId, settlementIds, sizeLadder } from "./lib/bake-plan.mjs";

const win = process.platform === "win32";
const log = (m = "") => console.log(m);
const secs = (ms) => `${(ms / 1000).toFixed(1)}s`;

const HELP = `npm run bake:all -- [options]
  --force                rebuild what exists (the world too: stop the server first)
  --only a,b             run just these steps (the build is added); steps: ${STEPS.map((s) => s.id).join(", ")}
  --skip a,b             leave these out
  --dry-run              print the plan and commands, run nothing
  --sites N|max          towns to bake, best sites first (default max: as many as the world supports with every constraint; 1 to 200)
  --population N         people per town (default 600); --auto-size falls back to 300 then 100 when no site fits
  --seed N  --settlement-id ID   town seed (default 1234; +1 per extra town) and first id (default 0001; 0002, ...)
paths (flag, or the variable; flags win): ${PATH_FLAGS.map((f) => `--${f}`).join(" ")}
  MMO_REPO MMO_DATA_DIR MMO_CONTENT_DIR MMO_ASSETS_DIR MMO_CATALOG MMO_WORLD_SPEC MMO_SETTLEMENT_OUT MMO_SCENES_DIR MMO_SCALE_OUT`;

// ---- running commands

/** Run `cmd args`, its output indented and returned; resolves { code, out }. */
function exec(cmd, args, { cwd, env, quiet = false }) {
  return new Promise((done) => {
    // npm is npm.cmd on Windows, which needs a shell; a single command line keeps Node from warning about escaping.
    const viaShell = win && cmd === "npm";
    const child = viaShell ? spawn(show(cmd, args), { cwd, env, stdio: ["ignore", "pipe", "pipe"], shell: true }) : spawn(cmd, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const feed = (stream, sink) => {
      let rest = "";
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => {
        out += chunk;
        const lines = (rest + chunk).split(/\r?\n/);
        rest = lines.pop();
        if (!quiet) for (const l of lines) sink.write(`    ${l}\n`);
      });
      stream.on("end", () => !quiet && rest && sink.write(`    ${rest}\n`));
    };
    feed(child.stdout, process.stdout);
    feed(child.stderr, process.stderr);
    child.on("error", (e) => done({ code: 1, out: out + String(e) }));
    child.on("close", (code) => done({ code: code ?? 1, out }));
  });
}

class StepFailure extends Error {
  constructor(message, command) {
    super(message);
    this.command = command;
  }
}

const show = (cmd, args) => [cmd, ...args].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ");

// ---- the towns, read back from disk (so env works however they were baked)

function readTown(paths, id) {
  const scene = join(paths.scenesDir, `settlement-${id}.scene.json`);
  const manifest = join(paths.settlementOut, `${id}.settlement.json`);
  if (!existsSync(scene) || !existsSync(manifest)) return null;
  const p = JSON.parse(readFileSync(scene, "utf8")).nodes?.[0]?.transform?.position;
  const people = JSON.parse(readFileSync(manifest, "utf8")).demographics?.population;
  if (!Array.isArray(p)) return null;
  return { id, x: p[0], z: p[2], people };
}

// ---- the steps

/** Each step: cmds(ctx) the commands as shown by --dry-run; run(ctx) does it (throws StepFailure). */
const node = (ctx, rel, args) => ({ cmd: process.execPath, args: [join(ctx.paths.repo, rel), ...args], shown: `node ${rel} ${args.join(" ")}`.trim() });

const IMPL = {
  build: {
    cmds: () => [{ cmd: "npm", args: ["run", "build", "-w", "@mmo-engine/engine-core", "-w", "@mmo-engine/settlement", "-w", "@mmo-engine/dungeon"], shown: "npm run build -w engine-core -w settlement -w dungeon" }],
  },
  world: {
    cmds: (c) => [node(c, "packages/engine-core/dist/src/bake-world.js", c.opts.force ? ["--force"] : [])],
  },
  loot: {
    cmds: (c) => [node(c, "packages/compose/dist/src/cli.js", ["--out", join(c.paths.dataDir, "loot")])],
  },
  dungeons: {
    cmds: (c) => [node(c, "packages/dungeon/dist/src/cli.js", ["--n", "10", "--out", join(c.paths.dataDir, "dungeons"), ...(c.opts.force ? ["--fresh"] : [])])],
  },
  settlement: {
    cmds: (c) => [townCommand(c, 0, sizeLadder(c.opts.population, c.opts.autoSize)[0])],
    async run(c) {
      const ladder = sizeLadder(c.opts.population, c.opts.autoSize);
      if (c.opts.sites === "max") {
        const t = listSitesCommand(c, ladder[0]);
        log(`    counting the sites the world supports for ${ladder[0]} people`);
        const r = await exec(t.cmd, t.args, { cwd: c.paths.repo, env: c.env, quiet: true });
        const found = /^SITES (\d+)/m.exec(r.out);
        if (r.code !== 0 || !found) throw new StepFailure("could not count the world's town sites", t.shown);
        c.opts.sites = Math.min(200, Number(found[1]));
        log(`    the world supports ${found[1]} sites; baking ${c.opts.sites}`);
        if (c.opts.sites === 0) throw new StepFailure(`the world has no site for ${ladder[0]} people (site selection wants flat, low, dry, reachable land); ${c.opts.autoSize ? "try a smaller --population" : "try --auto-size or a smaller --population"}, or a different MMO_WORLD_SPEC`, t.shown);
      }
      const ids = settlementIds(c.opts.settlementId, c.opts.sites);
      if (!c.paths.hasCatalog) log(`    WARNING: no art catalog at ${c.paths.catalog}: the towns are stand-in boxes`);
      let from = 0; // the ladder index that fit the last town: later towns start there
      let baked = 0;
      for (let k = 0; k < ids.length; k++) {
        if (!c.opts.force && readTown(c.paths, ids[k])) {
          log(`    town ${ids[k]}: exists`);
          baked++;
          continue;
        }
        let ok = false;
        for (let s = from; s < ladder.length && !ok; s++) {
          const t = townCommand(c, k, ladder[s]);
          log(`    town ${ids[k]}: site ${k + 1}, ${ladder[s]} people`);
          const r = await exec(t.cmd, t.args, { cwd: c.paths.repo, env: c.env });
          if (r.code === 0) {
            ok = true;
            from = s;
          } else if (/the world has fewer sites/.test(r.out)) {
            log(`    no site ${k + 1} for ${ladder[s]} people${s + 1 < ladder.length ? `; trying ${ladder[s + 1]}` : ""}`);
          } else throw new StepFailure(`the settlement baker failed for town ${ids[k]}`, t.shown);
        }
        if (ok) baked++;
        else if (k === 0) throw new StepFailure(`the world has no site for ${ladder.join(", ")} people (site selection wants flat, low, dry, reachable land); ${c.opts.autoSize ? "try a smaller --population" : "try --auto-size or a smaller --population"}, or a different MMO_WORLD_SPEC`, townCommand(c, 0, ladder[0]).shown);
        else {
          log(`    WARNING: the world has ${k} site(s) for these sizes; baked ${k} of the ${ids.length} towns asked for`);
          break;
        }
      }
      return baked;
    },
  },
  "scale-fit": {
    cmds: (c) => [node(c, "packages/settlement/dist/src/scale-fit-cli.js", ["--catalog", c.paths.catalog, "--scale", c.paths.scaleBase, "--out", c.paths.scaleOut])],
  },
  "wildlife-plan": {
    cmds: (c) => [node(c, "packages/engine-core/dist/src/procgen/wildlife-plan.js", ["--catalog", c.paths.catalog, "--base", c.paths.ecologyBase, "--out", c.paths.ecologyOut])],
    prepare: (c) => mkdirSync(join(c.paths.ecologyOut, ".."), { recursive: true }),
  },
  "wildlife-models": {
    cmds: (c) => [node(c, "packages/engine-core/dist/src/procgen/wildlife-table.js", ["--catalog", c.paths.catalog, "--out", c.paths.wildlifeModelsOut])],
    prepare: (c) => mkdirSync(join(c.paths.wildlifeModelsOut, ".."), { recursive: true }),
  },
  env: { cmds: () => [] },
};

/** Asks the settlement baker how many sites the world has for towns of this size (it prints `SITES <n>`). */
function listSitesCommand(c, population) {
  return node(c, "packages/settlement/dist/src/cli.js", ["--world", c.paths.worldSpec, "--population", String(population), "--scale", c.paths.scaleBase, "--list-sites"]);
}

function townCommand(c, k, population) {
  const id = settlementId(c.opts.settlementId, k);
  const args = [
    "--world", c.paths.worldSpec, "--site", String(k + 1), "--id", id, "--seed", String((c.opts.seed + k) >>> 0), "--population", String(population),
    "--scene", "--scale", c.paths.scaleBase, "--out", c.paths.settlementOut, "--scenes", c.paths.scenesDir,
    ...(c.paths.hasCatalog ? ["--catalog", c.paths.catalog] : []),
  ];
  return node(c, "packages/settlement/dist/src/cli.js", args);
}

/** The environment block that starts the server on this bake. */
function envBlock(c) {
  const { paths: p } = c;
  // With "max" and the settlement step not run this time, the towns are whichever consecutive ids already exist.
  let ids;
  if (c.opts.sites === "max") for (ids = []; readTown(p, settlementId(c.opts.settlementId, ids.length)); ) ids.push(settlementId(c.opts.settlementId, ids.length));
  else ids = settlementIds(c.opts.settlementId, c.opts.sites);
  const towns = ids.map((id) => readTown(p, id)).filter(Boolean);
  const vars = [["MMO_DATA_DIR", p.dataDir]];
  const notes = [];
  if (towns.length) {
    const t = towns[0];
    vars.push(["MMO_SCENES", p.scenesDir], ["MMO_SCENE", `settlement-${t.id}`], ["MMO_SPAWN_OVERRIDE", `${Math.round(t.x)},${Math.round(t.z)}`]);
    for (const o of towns.slice(1)) notes.push(`other town ${o.id}: MMO_SCENE=settlement-${o.id} MMO_SPAWN_OVERRIDE=${Math.round(o.x)},${Math.round(o.z)}`);
  } else notes.push("no town baked yet: run the settlement step");
  if (existsSync(p.scaleOut)) vars.push(["MMO_SCALE", p.scaleOut]);
  if (existsSync(p.ecologyOut)) vars.push(["MMO_ECOLOGY", p.ecologyOut]);
  if (p.hasCatalog && p.sources.catalog !== "default") vars.push(["MMO_CATALOG", p.catalog]);
  if (p.sources.assetsDir !== "default") vars.push(["MMO_ASSETS_DIR", p.assetsDir]);
  notes.push("moving wildlife (the creature brains are in progress): add MMO_WILD_CREATURES=1 MMO_WILDLIFE=1");
  const sh = vars.map(([k, v]) => `export ${k}="${v}"`);
  const ps = vars.map(([k, v]) => `$env:${k} = "${v}"`);
  return [
    "# Git Bash / POSIX shell", ...sh, "", "# PowerShell", ...ps, "", ...notes.map((n) => `# ${n}`), "", "# then: npm run server   (or npm start -- --server)", "",
  ].join("\n");
}

// ---- main

async function main() {
  const argv = process.argv.slice(2);
  const { options: opts, pathFlags } = parseBakeArgs(argv);
  if (opts.help) return log(HELP);
  const paths = resolvePaths({ flags: pathFlags });
  const plan = planSteps(opts, paths);
  const env = {
    ...process.env,
    MMO_REPO: paths.repo, MMO_DATA_DIR: paths.dataDir, MMO_CONTENT_DIR: paths.contentDir, MMO_ASSETS_DIR: paths.assetsDir, MMO_CATALOG: paths.catalog,
    MMO_WORLD_SPEC: paths.worldSpec, MMO_SETTLEMENT_OUT: paths.settlementOut, MMO_SCENES_DIR: paths.scenesDir, MMO_SCALE_OUT: paths.scaleOut,
  };
  const ctx = { opts, paths, env };

  log(`[bake:all] ${opts.dryRun ? "plan (dry run)" : "paths"}:`);
  for (const k of ["repo", "dataDir", "contentDir", "assetsDir", "catalog", "worldSpec", "settlementOut", "scenesDir", "scaleOut"]) log(`  ${k.padEnd(14)} ${paths[k]}   (${paths.sources[k]})`);
  if (!paths.hasCatalog) log(`  WARNING: no art catalog: scale-fit and wildlife steps are skipped, towns are stand-in boxes`);
  log(opts.sites === "max"
    ? `  towns: as many as the world supports (counted when the settlement step runs) x ${opts.population} people${opts.autoSize ? " (auto-size)" : ""}, first id ${opts.settlementId}, seed ${opts.seed}`
    : `  towns: ${opts.sites} x ${opts.population} people${opts.autoSize ? " (auto-size)" : ""}, ids ${settlementIds(opts.settlementId, opts.sites).join(", ")}, seed ${opts.seed}`);
  log();

  const t0 = Date.now();
  const rows = [];
  let n = 0;
  for (const step of plan) {
    n++;
    const tag = `[${n}/${plan.length}] ${step.id}`;
    if (step.status !== "run") {
      log(`[bake:all] ${tag}: ${step.status}${step.reason ? ` (${step.reason})` : ""}`);
      rows.push({ id: step.id, status: step.status, ms: 0 });
      continue;
    }
    const impl = IMPL[step.id];
    log(`[bake:all] ${tag}: ${step.title}`);
    if (opts.dryRun) {
      for (const c of impl.cmds(ctx)) log(`    ${c.shown}`);
      if (step.id === "settlement" && opts.autoSize) log(`    (falls back through ${sizeLadder(opts.population, true).join(", ")} people when no site fits)`);
      rows.push({ id: step.id, status: "would run", ms: 0 });
      continue;
    }
    const t = Date.now();
    try {
      impl.prepare?.(ctx);
      if (step.id === "env") {
        mkdirSync(paths.contentDir, { recursive: true });
        const block = envBlock(ctx);
        writeFileSync(paths.envFile, block);
        log(block.split("\n").map((l) => `    ${l}`).join("\n"));
        log(`    (also written to ${paths.envFile})`);
      } else if (impl.run) await impl.run(ctx);
      else {
        for (const c of impl.cmds(ctx)) {
          log(`    $ ${c.shown}`);
          const r = await exec(c.cmd, c.args, { cwd: paths.repo, env });
          if (r.code !== 0) throw new StepFailure(`exit ${r.code}`, c.shown);
        }
      }
    } catch (e) {
      const keep = argv.filter((a, i) => !/^--(only|skip)(=|$)/.test(a) && !/^--(only|skip)$/.test(argv[i - 1] ?? ""));
      log();
      log(`[bake:all] FAILED at step "${step.id}" after ${secs(Date.now() - t)}: ${e.message}`);
      if (e.command) log(`  command: ${e.command}`);
      log(`  rerun:   npm run bake:all -- --only ${step.id} ${keep.filter((a) => a !== "--force").join(" ")}`.trimEnd());
      log(`  (steps before it finished and are skipped next time; the MMO_* path variables apply again)`);
      process.exitCode = 1;
      return;
    }
    rows.push({ id: step.id, status: "ok", ms: Date.now() - t });
    log(`[bake:all] ${tag}: done in ${secs(Date.now() - t)}`);
  }

  log();
  log(`[bake:all] ${opts.dryRun ? "plan" : "summary"} (${secs(Date.now() - t0)} total)`);
  for (const r of rows) log(`  ${r.id.padEnd(16)} ${r.status.padEnd(12)} ${r.ms ? secs(r.ms) : ""}`);
}

main().catch((e) => {
  console.error(`[bake:all] ${e.message}`);
  process.exit(1);
});
