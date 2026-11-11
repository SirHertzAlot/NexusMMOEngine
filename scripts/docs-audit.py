#!/usr/bin/env python3
"""Checks the docs against the code: relative links, repo paths named in backticks, MMO_* environment
variables, npm scripts, packages and message codes. Writes docs-audit.json to $DOCS_AUDIT_OUT (default
valgrind-out/, which is git-ignored) and prints a short report.

    python3 scripts/docs-audit.py

See docs/DOCS-AUDIT.md for how to read the output. Needs Python 3 only.
"""
import json, os, re, subprocess, sys, glob

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)
OUT = os.environ.get("DOCS_AUDIT_OUT", os.path.join(ROOT, "valgrind-out"))
os.makedirs(OUT, exist_ok=True)

def read(p):
    try: return open(p, errors="ignore").read()
    except Exception: return ""

docs = sorted(glob.glob("docs/**/*.md", recursive=True)) + ["README.md", "CONTRIBUTING.md", "AGENTS.md"]
# docs/DOCS-AUDIT.md quotes the paths it reports, so checking it would flag itself.
docs = [d for d in docs if os.path.exists(d) and "/library/" not in d and not d.startswith("docs/superpowers") and d != "docs/DOCS-AUDIT.md"]
res = {"docs_checked": len(docs)}

# ---- A. relative links and backticked repo paths
broken_links, missing_paths = [], []
ROOTS = ("apps/", "packages/", "scripts/", "content/", "docs/", "perf/", "third_party/")
for d in docs:
    t = read(d)
    t_nocode = re.sub(r"```.*?```", "", t, flags=re.S)
    for m in re.finditer(r"\]\(([^)\s#]+)(?:#[^)]*)?\)", t_nocode):
        u = m.group(1)
        if re.match(r"(https?:|mailto:|file:|data:)", u): continue
        target = os.path.normpath(os.path.join(os.path.dirname(d), u))
        if not os.path.exists(target): broken_links.append((d, u))
    for m in re.finditer(r"`((?:apps|packages|scripts|content|perf|third_party)/[A-Za-z0-9_./@*-]+)`", t_nocode):
        p = m.group(1).rstrip("/.")
        if "*" in p or p.endswith(("/...",)): continue
        if not os.path.exists(p): missing_paths.append((d, p))
res["broken_links"] = broken_links
res["missing_paths"] = sorted(set(missing_paths))

# ---- B. environment variables
code_files = [f for pat in ("apps/**/*.ts", "apps/**/*.tsx", "packages/**/*.ts", "packages/**/*.mjs", "scripts/**/*.mjs", "scripts/**/*.js") for f in glob.glob(pat, recursive=True)
              if "/node_modules/" not in f and "/dist/" not in f and "/generated/" not in f]
used = {}
for f in code_files:
    for v in set(re.findall(r"\b(MMO_[A-Z0-9_]+)\b", read(f))):
        used.setdefault(v, []).append(f)
documented = set()
for d in docs: documented |= set(re.findall(r"\b(MMO_[A-Z0-9_]+)\b", read(d)))
cfg = set(re.findall(r"\b(MMO_[A-Z0-9_]+)\b", read("docs/CONFIGURATION.md")))
res["env_used_in_code"] = len(used)
res["env_undocumented_anywhere"] = sorted(v for v in used if v not in documented)
res["env_missing_from_CONFIGURATION"] = sorted(v for v in used if v not in cfg and v in documented)
res["env_documented_but_unused"] = sorted(v for v in cfg if v not in used)

# ---- C. npm scripts
scripts = {}
for pj in ["package.json"] + glob.glob("apps/*/package.json") + glob.glob("packages/*/package.json") + glob.glob("packages/addons/*/package.json"):
    try:
        j = json.load(open(pj))
        for k in j.get("scripts", {}): scripts.setdefault(k, []).append(pj)
    except Exception: pass
root_scripts = set(json.load(open("package.json")).get("scripts", {}))
cli = read("docs/CLI.md") + read("docs/GETTING-STARTED.md") + read("README.md")
mentioned = set(re.findall(r"npm run ([A-Za-z0-9:_-]+)", "".join(read(d) for d in docs)))
res["root_scripts"] = len(root_scripts)
res["root_scripts_not_in_CLI_or_GETTING_STARTED_or_README"] = sorted(s for s in root_scripts if s not in cli)
res["scripts_mentioned_but_nonexistent"] = sorted(s for s in mentioned if s not in scripts)

# ---- D. packages and apps vs the docs that list them
pkgs = sorted([os.path.relpath(os.path.dirname(p)) for p in glob.glob("packages/*/package.json") + glob.glob("packages/addons/*/package.json") + glob.glob("apps/*/package.json")])
arch = read("README.md") + read("docs/ARCHITECTURE.md")
res["packages_total"] = len(pkgs)
res["packages_not_named_in_README_or_ARCHITECTURE"] = [p for p in pkgs if os.path.basename(p) not in arch]

# ---- E. message codes
codes = set()
for f in glob.glob("packages/protocol/src/**/*.ts", recursive=True):
    codes |= {c.lower() for c in re.findall(r"\b0x[0-9a-fA-F]{2}\b", read(f))}
doc_codes = {c.lower() for c in re.findall(r"\b0x[0-9a-fA-F]{2}\b", read("docs/MESSAGE-CATALOG.md"))}
res["protocol_codes"] = len(codes)
res["codes_in_protocol_not_in_catalog"] = sorted(codes - doc_codes)
res["codes_in_catalog_not_in_protocol"] = sorted(doc_codes - codes)

# ---- F. freshness (days since last commit touching the doc vs the code it describes is too fuzzy; report age only)
age = {}
for d in docs:
    r = subprocess.run(["git", "log", "-1", "--format=%cs", "--", d], capture_output=True, text=True).stdout.strip()
    age[d] = r
res["last_changed"] = age

json.dump(res, open(os.path.join(OUT, "docs-audit.json"), "w"), indent=1)
print("docs checked:", res["docs_checked"])
print("broken relative links:", len(broken_links))
print("backticked repo paths that do not exist:", len(res["missing_paths"]))
print(f"env vars used in code: {len(used)}; undocumented anywhere: {len(res['env_undocumented_anywhere'])}; documented elsewhere but not in CONFIGURATION: {len(res['env_missing_from_CONFIGURATION'])}; in CONFIGURATION but unused: {len(res['env_documented_but_unused'])}")
print(f"root npm scripts: {len(root_scripts)}; not mentioned in CLI/GETTING-STARTED/README: {len(res['root_scripts_not_in_CLI_or_GETTING_STARTED_or_README'])}; mentioned in docs but nonexistent: {len(res['scripts_mentioned_but_nonexistent'])}")
print(f"packages/apps: {len(pkgs)}; not named in README/ARCHITECTURE: {len(res['packages_not_named_in_README_or_ARCHITECTURE'])}")
print(f"protocol codes: {len(codes)}; missing from catalog: {len(res['codes_in_protocol_not_in_catalog'])}; catalog-only: {len(res['codes_in_catalog_not_in_protocol'])}")
