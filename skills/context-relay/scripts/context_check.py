#!/usr/bin/env python3
"""Claude Code hook: nudge the agent to hand off before its context passes the cap.

Reads the real token count from the session transcript (last assistant turn's usage),
so it needs no status line. Silent below the threshold. Warns on first crossing and on
crossing the cap, then repeats only every STEP tokens so it never spams the context.

Env overrides: CONTEXT_RELAY_TOKENS (default 370000), CONTEXT_RELAY_CAP (default 500000).
"""
import json, os, sys, tempfile

WARN = int(os.environ.get("CONTEXT_RELAY_TOKENS", 370_000))
CAP = int(os.environ.get("CONTEXT_RELAY_CAP", 500_000))
STEP = 25_000
CHUNK = 1_000_000


def usage_of(line):
    if b'"usage"' not in line:
        return None
    try:
        u = json.loads(line)["message"]["usage"]
    except (ValueError, KeyError, TypeError):
        return None
    # Top-level usage sums every model call in the turn (e.g. advisor calls);
    # the last plain "message" iteration is the real context size.
    msgs = [i for i in u.get("iterations") or [] if i.get("type") == "message"]
    if msgs:
        u = msgs[-1]
    return (u.get("input_tokens", 0) + u.get("cache_creation_input_tokens", 0)
            + u.get("cache_read_input_tokens", 0) + u.get("output_tokens", 0))


def context_tokens(path):
    # The last usage record in the transcript is the current context size.
    # Scan backward in chunks so one huge tool/image line can't hide it.
    with open(path, "rb") as f:
        pos = f.seek(0, 2)
        tail = b""
        while pos > 0:
            step = min(CHUNK, pos)
            pos -= step
            f.seek(pos)
            tail = f.read(step) + tail
            lines = tail.split(b"\n")
            complete, tail = (lines, b"") if pos == 0 else (lines[1:], lines[0])
            for line in reversed(complete):
                n = usage_of(line)
                if n is not None:
                    return n
    return 0


def main():
    try:
        event = json.load(sys.stdin)
        tokens = context_tokens(event["transcript_path"])
    except Exception:
        return  # never break the agent's turn over a hook problem
    state = os.path.join(tempfile.gettempdir(), f"context-relay-{event.get('session_id', 'x')}")
    try:
        last = int(open(state).read())
    except (OSError, ValueError):
        last = 0
    if tokens < last:  # context shrank (compaction): start over
        last = 0
        try:
            os.remove(state)
        except OSError:
            pass
    if tokens < WARN:
        return
    first = last == 0
    crossed_cap = tokens >= CAP > last
    if not (first or crossed_cap or tokens - last >= STEP):
        return
    with open(state, "w") as f:
        f.write(str(tokens))
    urgency = "NOW - you are over the cap" if tokens >= CAP else "soon"
    msg = (f"Context is ~{tokens // 1000}k tokens (hand-off line {WARN // 1000}k, hard cap {CAP // 1000}k). "
           f"First finish answering the user's current request and the step you are on; do not drop it. "
           f"Then, only if you still have work to do, hand off {urgency}: invoke the `context-relay` skill. "
           f"If you are idle or finished, do not hand off; just stop.")
    name = event.get("hook_event_name", "PostToolUse")
    print(json.dumps({"hookSpecificOutput": {"hookEventName": name, "additionalContext": msg}}))


if __name__ == "__main__":
    main()
