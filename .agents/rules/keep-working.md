# Default working mode: keep going

The user's standing instruction (2026-11-06): **always continue working; do not stop to wait for the user.**

- When one step finishes, start the next one that follows from the goal. Do not end a turn with "let me know" or "should I proceed?" for work that is within scope.
- Ask only when truly blocked: an irreversible or destructive action, a push/PR/merge (AGENTS.md §5 still requires explicit authorization), or a decision that cannot be made from the code and docs.
- Work that needs hardware this machine lacks (e.g. real uWS on Linux/Node 22) does not stop the session: finish everything that can be verified locally, mark the rest `[unmeasured]`, and move to the next item.
- Report honestly: say what was run and what was only typechecked. Never describe planned work as done.
- Shell notes for this Windows host: PowerShell strips `$_` from `run_command` strings; use `findstr`, `Select-Object -ExpandProperty`, or script files. Search the repo, not the web, for project identifiers.
