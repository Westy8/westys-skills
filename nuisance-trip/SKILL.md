---
name: nuisance-trip
description: Use when adding or reviewing any verification, re-check, guard, readback, assertion or fail-closed safety check, or when a check keeps failing although the underlying action looks correct. Prevents "nuisance trips" - checks that fail when nothing is wrong.
---

# No nuisance-trip checks

A nuisance trip is a breaker cutting power when there's no fault: the guard itself becomes the failure.
A check that can fail when nothing is wrong is a bug, not safety.

Typical shape: a check re-confirms something already proven, using a weaker signal than the original
proof, and blocks the work when it misfires. The usual "fix" then adds more automation to satisfy the
bad check, which adds time and new failure modes.

Before adding a re-check or guard, it must pass all three:
1. **New information.** Name the real failure it catches that earlier steps haven't already ruled out.
2. **Observable in the real system.** Prove what it reads actually exists there (a real capture, log or
   API response), not in a mock or an assumption.
3. **Earns its cost.** Estimate how often it fires on work that actually succeeded, and what it adds in
   time and failure paths.

When a check keeps failing:
- First ask "is the check wrong?" Compare what it expects with what the real system exposes.
- Fix or remove the check before building workarounds around it.

Prefer one strong check at the moment of action (verify before you act) over several weak checks after.
Keep genuine safety checks (money, credentials, data loss, irreversible actions), but make them read
signals that really exist.

Origin: RedditFlow, 2026-09-28. An exact-name flair readback failed 88/88 because Reddit's iOS app gives
richtext flair chips no label; the tap had already been verified. The first proposed fix, reopening the
picker to re-check, was the same bug again.
