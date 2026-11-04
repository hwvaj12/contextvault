# Run log

Only the lead appends run-log.jsonl through the Codex team-lead helper.
The live event log is stored in the configured lead directory and stays uncommitted.

## Record kinds

- piece: one worker attempt, with item, role, step, verdict, and independently observed check.
- item: a finished item's dispatch count, plan changes, and exact user answers.
- ruling: an actual user decision and its decision record.
- lesson: scope (skill, mod, or role), about, what, and suggest.

Piece steps: work, fix, review, check, prep, probe.
Review verdicts: ships, ships-with-fixes, does-not-ship.
Check results: pass, fail, skipped.
Friction signatures use role:, brief:, skill:, mod:, or project:.

The helper fills in work/fix round, known dispatch definition hashes, and observed native stop telemetry.
Trusted native hooks capture prepared worker events and available transcript usage automatically.
If hooks are inactive, the lead records observed lifecycle events manually.
Keep unavailable tokens, output_tokens, model, effort, minutes, and turns absent.
The report flags missing cost. Status does not know live agent liveness.
