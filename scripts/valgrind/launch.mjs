/**
 * Entry for `npm run valgrind:*`: runs the script with the host's valgrind
 * when there is one, otherwise inside a Linux Docker container (Windows has
 * no valgrind and the addons must be Linux builds).
 *
 *   node scripts/valgrind/launch.mjs <memcheck|perf> [script args...]
 *
 * The container gets a read-only mount of the repo and copies it into a
 * named volume without assets/, .git/ and data/ (licensed art never enters
 * it), reinstalls when the lockfile changed, rebuilds the addons and runs
 * the same script. Reports are copied back to valgrind-out/ and, for
 * `perf --update`, the baseline file is copied back too.
 */

import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const [kind, ...rest] = process.argv.slice(2);
if (kind !== "memcheck" && kind !== "perf") {
  console.error("usage: launch.mjs <memcheck|perf> [args...]");
  process.exit(2);
}
const script = join("scripts", "valgrind", `${kind}.mjs`);
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { stdio: "inherit", cwd: root, ...opts });

if (spawnSync("valgrind", ["--version"], { stdio: "ignore" }).status === 0) {
  if (kind === "perf") run("npm", ["run", "build", "--workspace=@mmo-engine/engine-core"], { shell: true });
  process.exit(run(process.execPath, [script, ...rest]).status ?? 1);
}

if (spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], { stdio: "ignore" }).status !== 0) {
  console.error("[valgrind] no valgrind on PATH and the Docker daemon isn't running (start Docker Desktop).");
  process.exit(2);
}
const image = "mmo-valgrind";
if (spawnSync("docker", ["image", "inspect", image], { stdio: "ignore" }).status !== 0) {
  if (run("docker", ["build", "-t", image, join(root, "scripts", "valgrind")]).status !== 0) process.exit(2);
}
const name = `mmo-valgrind-${process.pid}`;
const cmd = [
  kind === "perf" ? "npm run build --workspace=@mmo-engine/engine-core &&" : "",
  "node",
  script.replaceAll("\\", "/"),
  ...rest.map((a) => `'${a.replaceAll("'", "'\\''")}'`),
].join(" ");
// docker-run.sh syncs the tree into /work, then runs its arguments there.
const code = run("docker", [
  "run", "--name", name, "-v", `${root}:/src:ro`, "-v", "mmo-vg-work:/work", image,
  "bash", "/src/scripts/valgrind/docker-run.sh", "bash", "-c", cmd,
]).status;
for (const p of ["valgrind-out/.", "perf/."]) {
  const dst = p.startsWith("perf") ? join(root, "perf") : join(root, "valgrind-out");
  if (p.startsWith("perf") && !rest.includes("--update")) continue;
  spawnSync("docker", ["cp", `${name}:/work/${p}`, dst], { stdio: "ignore" });
}
spawnSync("docker", ["rm", name], { stdio: "ignore" });
process.exit(code ?? 1);
