#!/usr/bin/env python3
"""tasks: the crew-board task store (SQLite) and CLI. Stdlib only.

The lead calls this to keep one durable record per task, so recaps, decisions and
handoffs come from the store instead of chat scrollback. Run `tasks -h` for commands.
Store: $TASKS_DB or ~/.tasks/tasks.db.
"""
import argparse, hashlib, json, os, re, shlex, sqlite3, subprocess, sys, time

DB = os.environ.get("TASKS_DB") or os.path.expanduser("~/.tasks/tasks.db")
STATUSES = ["proposed", "running", "blocked-on-user", "blocked", "in-review", "pr-open",
            "merged-not-live", "live", "proven", "done", "dropped"]
CLOSED = ("done", "dropped")
FINISHED = ("proven", "done", "dropped")  # reaching one closes the task's open decisions
SCHEMA = """
CREATE TABLE IF NOT EXISTS repos(repo TEXT PRIMARY KEY, prefix TEXT UNIQUE, enabled INTEGER DEFAULT 0, seq INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, repo TEXT, title TEXT, aliases TEXT DEFAULT '',
  status TEXT DEFAULT 'proposed', origin TEXT DEFAULT 'user', parent TEXT, why TEXT DEFAULT '',
  done TEXT DEFAULT '', next TEXT DEFAULT '', verified TEXT DEFAULT '', dseq INTEGER DEFAULT 0,
  created REAL, updated REAL);
CREATE TABLE IF NOT EXISTS decisions(id TEXT PRIMARY KEY, task_id TEXT, question TEXT, options TEXT,
  recommended INTEGER, state TEXT DEFAULT 'open', answer TEXT, raised INTEGER DEFAULT 1, created REAL, updated REAL);
CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY, task_id TEXT, ts REAL, kind TEXT, text TEXT);
CREATE TABLE IF NOT EXISTS links(task_id TEXT, kind TEXT, ref TEXT, label TEXT DEFAULT '', PRIMARY KEY(task_id, kind, ref));
CREATE TABLE IF NOT EXISTS leads(repo TEXT PRIMARY KEY, terminal TEXT, session TEXT, cwd TEXT, updated REAL);
CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY, task_id TEXT, kind TEXT DEFAULT 'message', author TEXT,
  text TEXT, ts REAL, state TEXT, state_note TEXT DEFAULT '', file_ids TEXT DEFAULT '[]', linked_task TEXT, decision_id TEXT);
CREATE TABLE IF NOT EXISTS files(file_id TEXT PRIMARY KEY, name TEXT, path TEXT, size INTEGER, ts REAL);
CREATE TABLE IF NOT EXISTS prompt_map(prompt_id TEXT PRIMARY KEY, session TEXT, message_ids TEXT);
CREATE TABLE IF NOT EXISTS lead_state(repo TEXT PRIMARY KEY, state TEXT, ts REAL);
CREATE TABLE IF NOT EXISTS lead_sessions(repo TEXT, key TEXT, PRIMARY KEY(repo, key));
CREATE TABLE IF NOT EXISTS lead_board(repo TEXT PRIMARY KEY, view TEXT DEFAULT '', reopen TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS lead_starts(repo TEXT PRIMARY KEY, ts REAL, terminal TEXT DEFAULT '');
"""
# Columns added after v0; added in place on older stores. Additive only, and never on a table an older
# CLI inserts into positionally (leads, links), so the older `tasks` keeps working on the same file.
COLUMNS = {"tasks": [("stage", "TEXT"), ("steps_done", "INTEGER DEFAULT 0"), ("steps_total", "INTEGER DEFAULT 0"),
                     ("step_label", "TEXT DEFAULT ''"), ("seen", "REAL DEFAULT 0"),
                     ("finished", "REAL DEFAULT 0"), ("finish_seen", "REAL DEFAULT 0")],
           "decisions": [("descs", "TEXT DEFAULT '[]'"), ("multi", "INTEGER DEFAULT 0")], "messages": [("sent_at", "REAL"), ("sent_pid", "INTEGER"), ("sent_start", "TEXT"), ("turn", "TEXT"), ("sent_session", "TEXT")]}
STAGES = ["planning", "development", "review", "testing", "done"]
# The user's message states only move forward; queued/held share rank 0.
# failed (Claude refused the prompt) sits above accepted: a refusal can only follow a submit, and only Resend undoes it.
RANK = {"queued": 0, "held": 0, "sending": 1, "accepted": 2, "failed": 3, "received": 4, "replied": 5, "replied?": 5}
STUCK = 30  # seconds in 'sending' (since sent_at): a healthy send leaves it within a second, so older means the send was cut off
RANK_SQL = "CASE state " + " ".join(f"WHEN '{k}' THEN {v}" for k, v in RANK.items()) + " ELSE 0 END"
ENVELOPE = re.compile(r"\[([A-Z][A-Z0-9]*-\d+) · m(\d+)\]")
LEADING = re.compile(r"\s*\[([A-Z][A-Z0-9]*-\d+) · m(\d+)\]")  # the delivery envelope; quoted ones in the body are text
HOLD = 300  # seconds a finished task stays among the open ones after a board first showed it to the user (TAS-21)
LEAD_FRESH = 20  # seconds: a lead mod reports every ~3 s, so older means no lead is running
ORCA_DATA = os.environ.get("TASKS_ORCA_DATA") or os.path.expanduser("~/Library/Application Support/orca/profiles/local-default/orca-data.json")
START_WAIT = 180  # ponytail: a lead started from the board counts as starting for 3 min; no seat by then, the button is back


def db():
    os.makedirs(os.path.dirname(DB), exist_ok=True)
    c = sqlite3.connect(DB, timeout=5)
    c.row_factory = sqlite3.Row
    c.executescript(SCHEMA)
    for table, cols in COLUMNS.items():
        have = {r[1] for r in c.execute(f"PRAGMA table_info({table})")}
        for name, decl in cols:
            if name not in have:
                try:
                    c.execute(f"ALTER TABLE {table} ADD COLUMN {name} {decl}")
                except sqlite3.OperationalError:  # another process added it first
                    pass
    c.commit()
    return c


def repo_of(cwd):
    """Repo name shared by every worktree of a repo: the git common dir's name."""
    try:
        p = subprocess.run(["git", "-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"],
                           capture_output=True, text=True, timeout=3).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        p = ""
    if not p:
        return os.path.basename(os.path.abspath(cwd))
    name = os.path.basename(p.rstrip("/"))
    return os.path.basename(os.path.dirname(p.rstrip("/"))) if name == ".git" else re.sub(r"\.git$", "", name)


def default_prefix(repo):
    return (re.sub(r"[^A-Za-z]", "", repo)[:3] or "TSK").upper()


def ensure_repo(c, repo, prefix=None):
    row = c.execute("SELECT * FROM repos WHERE repo=?", (repo,)).fetchone()
    if row:
        return row
    prefix = (prefix or default_prefix(repo)).upper()
    base, n = prefix, 2
    while c.execute("SELECT 1 FROM repos WHERE prefix=?", (prefix,)).fetchone():
        prefix, n = f"{base}{n}", n + 1
    c.execute("INSERT INTO repos(repo, prefix) VALUES(?,?)", (repo, prefix))
    return c.execute("SELECT * FROM repos WHERE repo=?", (repo,)).fetchone()


def event(c, task_id, kind, text):
    c.execute("INSERT INTO events(task_id, ts, kind, text) VALUES(?,?,?,?)", (task_id, time.time(), kind, text))


def get_task(c, tid):
    row = c.execute("SELECT * FROM tasks WHERE id=?", (tid.upper(),)).fetchone()
    if not row:
        sys.exit(f"no task {tid}")
    return row


def ago(ts):
    s = int(time.time() - ts)
    return f"{s // 60}m" if s < 3600 else f"{s // 3600}h" if s < 172800 else f"{s // 86400}d"


# ---- commands ---------------------------------------------------------------

def cmd_new(c, a):
    repo = a.repo or repo_of(os.getcwd())
    r = ensure_repo(c, repo)
    seq = r["seq"] + 1
    tid = f"{r['prefix']}-{seq}"
    now = time.time()
    c.execute("UPDATE repos SET seq=? WHERE repo=?", (seq, repo))
    c.execute("INSERT INTO tasks(id, repo, title, aliases, status, origin, parent, why, created, updated) "
              "VALUES(?,?,?,?,?,?,?,?,?,?)",
              (tid, repo, a.title, a.alias or "", a.status, a.origin, a.parent and a.parent.upper(), a.why or "", now, now))
    event(c, tid, "created", f"{a.title} (from {a.origin})")
    print(tid)


def cmd_set(c, a):
    t = get_task(c, a.id)
    changes = {k: v for k, v in (("title", a.title), ("status", a.status), ("why", a.why), ("done", a.done),
                                  ("next", a.next), ("verified", a.verified)) if v is not None}
    if a.stage is not None:
        changes["stage"] = a.stage
    if a.steps is not None:
        m = re.fullmatch(r"(\d+)/(\d+)", a.steps.strip())
        if not m or int(m[1]) > int(m[2]):
            sys.exit("--steps looks like 4/8 (done/total)")
        changes["steps_done"], changes["steps_total"] = int(m[1]), int(m[2])
    if a.step_label is not None:
        changes["step_label"] = a.step_label
    if a.alias:
        old = [x for x in t["aliases"].split(",") if x]
        changes["aliases"] = ",".join(old + [x for x in a.alias.split(",") if x and x not in old])
    if not changes:
        sys.exit("nothing to set")
    for k, v in changes.items():
        if k == "steps_done":
            event(c, t["id"], "progress", f"{v}/{changes['steps_total']} steps")
        elif k not in ("aliases", "steps_total"):
            event(c, t["id"], k, f"{t[k]} -> {v}" if k in ("status", "stage") else v)
    changes["updated"] = time.time()
    if a.by_user and changes.get("status") in CLOSED:
        changes["finished"] = 0  # the user ended it on the board themselves: seen, straight to Completed, even if a lead got there first (TAS-28)
    elif changes.get("status") in CLOSED and t["status"] not in CLOSED:
        changes["finished"] = changes["updated"]  # just finished: the board keeps it in place until the user has seen it
    c.execute(f"UPDATE tasks SET {', '.join(k + '=?' for k in changes)} WHERE id=?", (*changes.values(), t["id"]))
    print(t["id"])
    # A task that just finished asks the user nothing more (IGR-5.D4 sat in Needs you 4.8 h after IGR-5 was proven). Only on
    # the change: a question asked later on a proven task (one with work left, like a ramp-up) stays open.
    if changes.get("status") in FINISHED and changes["status"] != t["status"]:
        for d in c.execute("SELECT id FROM decisions WHERE task_id=? AND state='open'", (t["id"],)).fetchall():
            note = f"task reached {changes['status']} before an answer"
            c.execute("UPDATE decisions SET state='superseded', answer=?, updated=? WHERE id=?", (note, time.time(), d["id"]))
            event(c, t["id"], "superseded", f"{d['id']}: {note}")
            # stderr: leads often send `tasks set` output to /dev/null, and stdout stays the bare ID for callers that read it
            print(f"closed {d['id']} ({note}); if it still matters, ask again with tasks ask", file=sys.stderr)


def cmd_note(c, a):
    t = get_task(c, a.id)
    event(c, t["id"], a.kind, a.text)
    c.execute("UPDATE tasks SET updated=? WHERE id=?", (time.time(), t["id"]))
    print(t["id"])


def cmd_ask(c, a):
    t = get_task(c, a.id)
    if not a.option:
        sys.exit("give at least one --option")
    # Same question still open: count the re-raise instead of making a duplicate.
    dup = c.execute("SELECT id FROM decisions WHERE task_id=? AND state='open' AND question=?",
                    (t["id"], a.question)).fetchone()
    if dup:
        c.execute("UPDATE decisions SET raised=raised+1, updated=? WHERE id=?", (time.time(), dup["id"]))
        print(dup["id"])
        return
    n = t["dseq"] + 1
    did, now = f"{t['id']}.D{n}", time.time()
    c.execute("UPDATE tasks SET dseq=?, updated=? WHERE id=?", (n, now, t["id"]))
    c.execute("INSERT INTO decisions(id, task_id, question, options, recommended, created, updated, descs, multi) VALUES(?,?,?,?,?,?,?,?,?)",
              (did, t["id"], a.question, json.dumps(a.option), a.recommend, now, now, json.dumps(a.desc or []), int(a.multi)))
    event(c, t["id"], "asked", f"{did}: {a.question}")
    print(did)


def cmd_answer(c, a):
    d = c.execute("SELECT * FROM decisions WHERE id=?", (a.id.upper(),)).fetchone()
    if not d:
        sys.exit(f"no decision {a.id}")
    c.execute("UPDATE decisions SET state=?, answer=?, updated=? WHERE id=?", (a.state, a.text, time.time(), d["id"]))
    event(c, d["task_id"], a.state, f"{d['id']}: {a.text}")
    c.execute("UPDATE tasks SET updated=? WHERE id=?", (time.time(), d["task_id"]))
    print(d["id"])


def cmd_link(c, a):
    t = get_task(c, a.id)
    ref = a.ref
    if a.kind in ("report", "file"):  # local files: absolute path, registered in files
        ref = os.path.abspath(os.path.expanduser(ref))
        if a.kind == "report" and not os.path.isfile(ref):
            sys.exit(f"no file {ref}")
        if os.path.isfile(ref):
            fid = file_id(ref)
            c.execute("INSERT OR REPLACE INTO files VALUES(?,?,?,?,?)",
                      (fid, os.path.basename(ref), ref, os.path.getsize(ref), time.time()))
        if a.kind == "report":
            event(c, t["id"], "result", f"report: {ref}")
    c.execute("INSERT OR REPLACE INTO links VALUES(?,?,?,?)", (t["id"], a.kind, ref, a.label or ""))
    c.execute("UPDATE tasks SET updated=? WHERE id=?", (time.time(), t["id"]))
    print(t["id"])


def task_line(c, t):
    opens = c.execute("SELECT COUNT(*) FROM decisions WHERE task_id=? AND state='open'", (t["id"],)).fetchone()[0]
    s = f"{t['id']} [{t['status']}] {t['title']}"
    if t["aliases"]:
        s += f" (aka {t['aliases']})"
    if t["next"]:
        s += f" | next: {t['next']}"
    if opens:
        s += f" | {opens} decision(s) waiting on the user"
    return s + f" | updated {ago(t['updated'])} ago"


def open_decisions(c, repo=None):
    q = ("SELECT d.* FROM decisions d JOIN tasks t ON t.id=d.task_id WHERE d.state='open'"
         + (" AND t.repo=?" if repo else "") + " ORDER BY d.created")
    return c.execute(q, (repo,) if repo else ()).fetchall()


def decision_line(d):
    opts = json.loads(d["options"])
    parts = [f"{i + 1}) {o}{' (recommended)' if d['recommended'] == i + 1 else ''}" for i, o in enumerate(opts)]
    extra = f", raised {d['raised']}x" if d["raised"] > 1 else ""
    return f"{d['id']}: {d['question']} -> {' / '.join(parts)} [open {ago(d['created'])}{extra}]"


def cmd_list(c, a):
    repo = None if a.all else (a.repo or repo_of(os.getcwd()))
    q = "SELECT * FROM tasks" + ("" if a.closed else f" WHERE status NOT IN {CLOSED}")
    rows = [t for t in c.execute(q + " ORDER BY repo, created").fetchall() if not repo or t["repo"] == repo]
    cur = None
    for t in rows:
        if t["repo"] != cur:
            cur = t["repo"]
            print(f"\n## {cur}")
        print("- " + task_line(c, t))
    ds = open_decisions(c, repo)
    if ds:
        print("\n## Waiting on the user")
        for d in ds:
            print("- " + decision_line(d))
    since = time.time() - a.hours * 3600
    rq = " AND t.repo=?" if repo else ""
    fin = c.execute(f"SELECT * FROM tasks t WHERE status IN {CLOSED} AND updated>?{rq} ORDER BY updated",
                    (since, repo) if repo else (since,)).fetchall()
    if fin and not a.closed:
        print(f"\n## Finished in the last {a.hours}h")
        for t in fin:
            print(f"- {t['id']} [{t['status']}] {t['title']}: {t['done']}")
    calls = c.execute("SELECT e.* FROM events e JOIN tasks t ON t.id=e.task_id WHERE e.kind IN ('ruling','result','correction')"
                      f" AND e.ts>?{rq} ORDER BY e.ts", (since, repo) if repo else (since,)).fetchall()
    if calls:
        print(f"\n## Results and calls made for the user (last {a.hours}h)")
        for e in calls:
            print(f"- {e['task_id']} {e['kind']}: {e['text']}")
    took = c.execute("SELECT m.* FROM messages m JOIN tasks t ON t.id=m.task_id WHERE m.author='user' AND m.state IN "
                     f"('sending','accepted','received'){rq} ORDER BY m.id", (repo,) if repo else ()).fetchall()
    if took:
        print("\n## Board messages taken but not answered yet (carry them over in a relay)")
        for m in took:
            print(f"- {m['task_id']} m{m['id']} ({m['state']}): {m['text'][:200]}")
    if not rows and not ds and not fin:
        print("no open tasks")


def cmd_show(c, a):
    if a.json:
        return print(json.dumps(detail(c, a.id)))
    t = get_task(c, a.id)
    print(f"{t['id']} [{t['status']}] {t['title']}\nrepo: {t['repo']}  origin: {t['origin']}"
          + (f"  parent: {t['parent']}" if t["parent"] else "") + (f"\naka: {t['aliases']}" if t["aliases"] else ""))
    for k in ("why", "done", "next", "verified"):
        if t[k]:
            print(f"{k}: {t[k]}")
    if t["steps_total"] or t["stage"]:
        print(f"progress: {t['stage'] or '-'} · {t['steps_done']}/{t['steps_total']} steps" + (f" · {t['step_label']}" if t["step_label"] else ""))
    for d in c.execute("SELECT * FROM decisions WHERE task_id=? ORDER BY created", (t["id"],)):
        print(("- " + decision_line(d)) if d["state"] == "open" else f"- {d['id']} {d['state']}: {d['question']} -> {d['answer']}")
    for l in c.execute("SELECT * FROM links WHERE task_id=?", (t["id"],)):
        print(f"- {l['kind']}: {l['ref']} {l['label']}".rstrip())
    for m in c.execute("SELECT * FROM messages WHERE task_id=? ORDER BY id DESC LIMIT 6", (t["id"],)).fetchall()[::-1]:
        print(f"- m{m['id']} {m['author']} ({m['state']}): {m['text'][:300]}")
    print("timeline:")
    for e in c.execute("SELECT * FROM events WHERE task_id=? ORDER BY ts DESC LIMIT ?", (t["id"], a.n)):
        print(f"  {time.strftime('%m-%d %H:%M', time.localtime(e['ts']))} {e['kind']}: {e['text']}")


def cmd_enable(c, a):
    ensure_repo(c, a.repo, a.prefix)
    c.execute("UPDATE repos SET enabled=? WHERE repo=?", (0 if a.off else 1, a.repo))
    print(f"{a.repo}: crew-board {'off' if a.off else 'on'}")


def add_keys(c, repo, *keys):
    """Identities of a conversation registered as the repo's lead: session ids and `tok:<mod token>`."""
    for k in keys:
        if k and k != "tok:":
            c.execute("INSERT OR IGNORE INTO lead_sessions VALUES(?,?)", (repo, k))


def seat(c, repo, terminal, session, cwd, keys):
    """Register the repo's lead. A conversation the seat doesn't know yet takes it over: the former lead's
    identities retire, so it claims nothing more, even in the same terminal. The lead itself (any of its keys
    known: reload, compact, continue, resume, an id change) keeps every identity it has. The caller holds a write
    transaction (BEGIN IMMEDIATE) from before its first read of the seat, so registrations can't interleave."""
    keys = [k for k in keys if k and k != "tok:"]
    l = lead_row(c, repo)
    if keys and not (l and l["session"] in keys) and not any(
            c.execute("SELECT 1 FROM lead_sessions WHERE repo=? AND key=?", (repo, k)).fetchone() for k in keys):
        c.execute("DELETE FROM lead_sessions WHERE repo=?", (repo,))
        # a takeover (a relay): the successor's board opens once if the former lead had it open, at the same view
        c.execute("UPDATE lead_board SET reopen=view WHERE repo=?", (repo,))
    c.execute("INSERT OR REPLACE INTO leads(repo, terminal, session, cwd, updated) VALUES(?,?,?,?,?)",
              (repo, terminal, session, cwd, time.time()))
    add_keys(c, repo, *keys)


def cmd_lead(c, a):
    repo = a.repo or repo_of(os.getcwd())
    here = os.environ.get("ORCA_TERMINAL_HANDLE", "")
    keys = [a.session]
    if not a.terminal or a.terminal == here:  # registering its own seat: the calling conversation, as its mod and Bash know it
        e = os.environ.get
        mine = e("CLAUDE_CODE_SESSION_ID")
        # Bash's id is the caller's own; the mod's (equal when healthy) only stands in without it: a late write
        # during /clear can leave the cleared conversation's id behind. The token ("<session>/<random>", never reused)
        # counts only when it names that same conversation: an inherited one of the former lead must not keep it seated.
        sid, tok = mine or e("CREW_BOARD_SESSION"), e("CREW_BOARD_TOKEN", "")
        keys += [sid, "tok:" + tok if sid and tok.startswith(sid + "/") else ""]
    c.execute("BEGIN IMMEDIATE")
    seat(c, repo, a.terminal or here, a.session or "", os.getcwd(), keys)
    print(f"{repo}: lead = {a.terminal or os.environ.get('ORCA_TERMINAL_HANDLE', '?')} (store {DB})")
    if (not a.terminal or a.terminal == here) and not os.environ.get("CREW_BOARD_SESSION"):
        # a note, not a failure: right after /clear the mod sets this again within one poll (~3 s)
        print("note: the crew-board mod hasn't reached this session (not loaded here, or no poll yet), so board messages "
              "can't be delivered to it. Start Claude with the mod, then run `tasks lead` again.")


# ---- messages (the board's conversation per task) -----------------------------

def file_id(path):
    return "f" + hashlib.sha1(path.encode()).hexdigest()[:10]


def mid(ref):
    """'m12', 'M12' or '12' -> 12."""
    m = re.fullmatch(r"[mM]?(\d+)", str(ref).strip())
    if not m:
        sys.exit(f"no message {ref}")
    return int(m[1])


def envelope(c, m):
    """`[IGR-4 · m12] body`: short enough to arrive as typed input; long ones point at show-message."""
    head, body = f"[{m['task_id']} · m{m['id']}] ", m["text"]
    if m["kind"] == "new_task" and not body.startswith("New task:"):
        body = "New task: " + body
    if len(body) > 600 or json.loads(m["file_ids"] or "[]") or m["linked_task"]:
        body = body[:300] + f" … Details: tasks show-message m{m['id']}"
    return head + body


def msg_json(c, m):
    d = {k: m[k] for k in m.keys()}
    d["file_ids"] = json.loads(m["file_ids"] or "[]")
    d["envelope"] = envelope(c, m) if m["author"] == "user" else None
    return d


def raise_state(c, ids, state, note=None):
    """Monotonic: only moves a message forward (a hook's 'received' is never lowered by a later 'accepted')."""
    n = 0
    for i in ids:
        n += c.execute(f"UPDATE messages SET state=?, state_note=COALESCE(?, state_note) WHERE id=? AND {RANK_SQL} < ?",
                       (state, note, i, RANK[state])).rowcount
    return n


def start_of(pid):
    """A process's start time, the same string from every caller (C locale, UTC); "" if ps can't tell."""
    try:
        return subprocess.run(["ps", "-o", "lstart=", "-p", str(pid)], capture_output=True, text=True, timeout=3,
                              env={"PATH": os.environ.get("PATH", "/bin:/usr/bin"), "LC_ALL": "C", "TZ": "UTC"}).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return ""


def sender_gone(pid, start):
    """True only on proof the claiming Claude ended: no such process, or another process (other start) holds its pid."""
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return True
    except OSError:  # e.g. PermissionError: it exists
        return False
    now = start_of(pid) if start else ""
    return bool(now) and now != start


def lead_row(c, repo):
    return c.execute("SELECT * FROM leads WHERE repo=?", (repo,)).fetchone()


def lead_state(c, repo):
    l, s = lead_row(c, repo), c.execute("SELECT * FROM lead_state WHERE repo=?", (repo,)).fetchone()
    live = s and time.time() - s["ts"] <= LEAD_FRESH
    state = s["state"] if live else "offline"
    st = c.execute("SELECT ts, terminal FROM lead_starts WHERE repo=?", (repo,)).fetchone()
    if state == "offline" and st:  # started from the board, not seated yet; a launch Orca never confirmed stays unconfirmed
        state = "starting" if st["ts"] > time.time() - START_WAIT else "unconfirmed" if not st["terminal"] else state
    return {"state": state, "terminal": l["terminal"] if l else None, "since": s["ts"] if s else None,
            "registered": bool(l), "resumable": bool(lead_session(c, repo))}


def lead_session(c, repo):
    """The last lead's conversation (what `claude --resume` takes): the seat's session, else its newest registered id."""
    l = lead_row(c, repo)
    if l and l["session"]:
        return l["session"]
    k = c.execute("SELECT key FROM lead_sessions WHERE repo=? AND key NOT LIKE 'tok:%' ORDER BY rowid DESC", (repo,)).fetchone()
    return k["key"] if k else ""


def home_of(c, repo):
    """Where a repo's lead runs: its main checkout as Orca knows it, else the folder its last lead ran in."""
    paths = [r["path"].rstrip("/") for r in orca_repos().values()]
    p = next((p for p in paths if os.path.basename(p) == repo), None) or next(
        (p for p in paths if os.path.isdir(p) and repo_of(p) == repo), None)  # a bare repo: redditflow-v2.git
    l = lead_row(c, repo)
    return p or (l["cwd"] if l and l["cwd"] else None)


def terminal_gone(handle):
    """True only on proof: Orca's terminal list answered without it (a closed terminal leaves the list, measured)."""
    try:
        r = subprocess.run(["orca", "terminal", "list", "--json"], capture_output=True, text=True, timeout=15)
        ts = json.loads(r.stdout)["result"]["terminals"] if r.returncode == 0 else None
    except (OSError, subprocess.SubprocessError, ValueError, KeyError, TypeError):
        ts = None
    return isinstance(ts, list) and all(t.get("handle") != handle for t in ts)


def cmd_start_lead(c, a):
    """(board) Starts a Claude lead for a repo that has none, in a new Orca terminal; --resume brings back the last
    lead's conversation, in the folder it ran in. It seats itself with `tasks lead`, and the board's waiting messages
    then reach it. Never twice: refused while a lead is up or one is starting."""
    repo, l = a.repo, lead_row(c, a.repo)
    session = lead_session(c, repo) if a.resume else ""
    if a.resume and not session:
        sys.exit(f"{repo}: no earlier lead conversation to resume")
    where = (l["cwd"] if session and l and l["cwd"] else None) or home_of(c, repo)  # resolved before the lock: it runs git
    if not where:
        sys.exit(f"Don't know where {repo} lives: open it in Orca first")
    # A start that hasn't taken the seat holds until it provably can't: its terminal gone from Orca. Age alone never
    # frees it (a slow start is still a paid lead). Asked before the lock: it runs orca.
    old = c.execute("SELECT * FROM lead_starts WHERE repo=?", (repo,)).fetchone()
    gone = bool(old and old["terminal"] and terminal_gone(old["terminal"]))
    c.execute("BEGIN IMMEDIATE")  # the check and the mark in one write: two boards can't both start one
    state = lead_state(c, repo)["state"]
    if state in ("working", "idle"):
        sys.exit(f"{repo}: a lead is already up")
    held = c.execute("SELECT * FROM lead_starts WHERE repo=?", (repo,)).fetchone()
    if held and not (gone and held["ts"] == old["ts"]):
        if state == "starting":
            sys.exit(f"{repo}: a lead is already starting")
        if held["terminal"]:
            sys.exit(f"{repo}: the lead started at {time.strftime('%H:%M', time.localtime(held['ts']))} hasn't taken its seat yet. "
                     f"Look at its terminal; close it to start another")
        # Orca never answered that launch: it may have opened a terminal, and its title is the lead's own by now, so it
        # can't be found. Only the user's Start anyway, offered by the board once it shows this state, replaces it.
        if not a.anyway:
            sys.exit(f"{repo}: Orca never confirmed the lead started at {time.strftime('%H:%M', time.localtime(held['ts']))}. "
                     "If no new lead terminal opened for it, use Start anyway")
    c.execute("INSERT OR REPLACE INTO lead_starts(repo, ts, terminal) VALUES(?,?,'')", (repo, time.time()))
    c.commit()  # never hold the store across the launch: every board polls it
    brief = os.path.join(os.path.dirname(DB), "starts", f"{repo}.md")
    # the launched Claude's shell is the user's login shell: a store other than the default goes with it
    cmd = (f"TASKS_DB={shlex.quote(DB)} " if os.environ.get("TASKS_DB") else "") + "claude --dangerously-skip-permissions" \
        + (f" --resume {shlex.quote(session)}" if session else "") + " " + shlex.quote(f"Read and follow: {brief}")
    argv = ["orca", "terminal", "create", "--worktree", f"path:{where}", "--title", f"{repo} lead", "--command", cmd, "--json"]
    try:
        os.makedirs(os.path.dirname(brief), exist_ok=True)
        with open(brief, "w") as f:
            f.write(f"# Lead for {repo}, started from the Tasks board\n\n"
                    + ("The user brought this lead conversation back from their Tasks board, in a new terminal: the old one had closed.\n\n"
                       if session else f"The user started you from their Tasks board: no lead was running for {repo}. You are its crew lead.\n\n")
                    + "1. Load the crew-lead and crew-board skills.\n"
                    f"2. Run `tasks lead` from your own Bash. It must print the store {DB}; if it names another, stop and tell the user.\n"
                    f"3. Run `tasks list`. The user's board messages for {repo} that waited while no lead ran now arrive as your prompts "
                    "(`[ID · mN] …`): answer each one as crew-board says.\n")
        r = subprocess.run(argv, capture_output=True, text=True, timeout=30)
        why = "" if r.returncode == 0 else (r.stderr or r.stdout).strip().split("\n")[-1] or f"exit {r.returncode}"
    except subprocess.TimeoutExpired:  # Orca may have opened it anyway: the mark stays, so no second lead starts meanwhile
        sys.exit(f"Orca didn't answer in time. If a '{repo} lead' terminal opened, it takes the seat shortly")
    except OSError as e:  # the start file, or orca itself, failed before anything was launched
        why = str(e)
    if why:
        c.execute("DELETE FROM lead_starts WHERE repo=?", (repo,))
        c.commit()
        sys.exit(f"Couldn't open a terminal for the {repo} lead: {why}")
    handle = (re.search(r'"handle"\s*:\s*"([^"]+)"', r.stdout) or [None, ""])[1]
    c.execute("UPDATE lead_starts SET terminal=? WHERE repo=?", (handle, repo))
    print(f"{repo}: lead {'resuming' if session else 'starting'} in {handle or 'a new terminal'} ({where})")


def add_message(c, task, text, kind="message", author="user", decision_id=None, linked_task=None, turn=None):
    now = time.time()
    state = "posted" if author != "user" else "queued"
    note = ""
    if author == "user" and lead_state(c, task["repo"])["state"] == "offline":
        note = f"no lead running for {task['repo']}"
    cur = c.execute("INSERT INTO messages(task_id, kind, author, text, ts, state, state_note, decision_id, linked_task, turn) "
                    "VALUES(?,?,?,?,?,?,?,?,?,?)", (task["id"], kind, author, text, now, state, note, decision_id, linked_task, turn))
    c.execute("UPDATE tasks SET updated=? WHERE id=?", (now, task["id"]))
    return c.execute("SELECT * FROM messages WHERE id=?", (cur.lastrowid,)).fetchone()


def out(a, data, plain):
    print(json.dumps(data) if getattr(a, "json", False) else plain)


def cmd_msg(c, a):
    """The user writes on a task (from the board). Queued until the repo's lead mod submits it."""
    t = get_task(c, a.id)
    m = add_message(c, t, a.text, a.kind)
    event(c, t["id"], "message", f"m{m['id']} from the user: {a.text[:200]}")
    out(a, msg_json(c, m), f"m{m['id']}")


def cmd_say(c, a):
    """The lead posts on a task's conversation: a progress note, or with --reply its answer to the board message."""
    t = get_task(c, a.id)
    c.execute("BEGIN IMMEDIATE")  # one write transaction with turn-complete's: the reply checks and the post together
    if a.reply:
        filed = c.execute("SELECT * FROM messages WHERE task_id=? AND turn=?", (t["id"], turn_key() or "")).fetchone()
        if filed:  # this turn's answer was filed before this late reply: posting it would be a second reply
            return out(a, msg_json(c, filed), f"m{filed['id']} (this turn's answer was already filed)")
        reply_by_say(c, t)
    m = add_message(c, t, a.text, author="lead")
    out(a, msg_json(c, m), f"m{m['id']}")


def turn_key():
    """`<conversation>/<board turn>` of the caller (the mod names the running turn in CREW_BOARD_TURN); a worker that
    inherited the turn is another conversation, and no identity is no one's turn."""
    turn = os.environ.get("CREW_BOARD_TURN") or ""
    me = os.environ.get("CLAUDE_CODE_SESSION_ID") or os.environ.get("CREW_BOARD_SESSION") or ""
    return f"{me}/{turn}" if turn and me else None


def reply_by_say(c, t):
    """A deliberate reply posted on this task during the board turn it answers, by that turn's own conversation: the
    turn's final answer isn't filed as a second one (turn-complete's once-only gate, the DELETE). Only that turn: an
    earlier turn still waiting for its answer keeps its mapping. A plain say is a progress note and consumes nothing,
    so the turn's real answer is still filed after it."""
    key = turn_key()
    me, turn = key.split("/", 1) if key else ("", "")
    row = c.execute("SELECT * FROM prompt_map WHERE prompt_id=? AND session=?", (turn, me)).fetchone() if key else None
    ids = json.loads(row["message_ids"]) if row else []
    mine = [r["id"] for r in c.execute(f"SELECT id FROM messages WHERE task_id=? AND id IN ({','.join('?' * len(ids))})", (t["id"], *ids))]
    if not mine:
        return
    # A turn that took several board messages (TAS-18) keeps the others mapped: its final answer is still theirs.
    rest = [i for i in ids if i not in mine]
    if rest:
        c.execute("UPDATE prompt_map SET message_ids=? WHERE prompt_id=?", (json.dumps(rest), row["prompt_id"]))
    else:
        c.execute("DELETE FROM prompt_map WHERE prompt_id=?", (row["prompt_id"],))
    raise_state(c, mine, "replied")


def cmd_pick(c, a):
    """The user answers a decision from the board: records it and queues an answer message for the lead."""
    d = c.execute("SELECT * FROM decisions WHERE id=?", (a.id.upper(),)).fetchone()
    if not d:
        sys.exit(f"no decision {a.id}")
    opts, picked = json.loads(d["options"]), list(dict.fromkeys(a.option or []))
    if any(not 1 <= n <= len(opts) for n in picked):
        sys.exit(f"{d['id']} has options 1-{len(opts)}")
    if len(picked) > 1 and not d["multi"]:
        sys.exit(f"{d['id']} takes one option")
    choice = ", ".join(opts[n - 1] for n in picked)
    answer = ". ".join(x for x in (choice, (a.text or "").strip()) if x)
    if not answer:
        sys.exit("give --option or --text")
    if not c.execute("UPDATE decisions SET state='answered', answer=?, updated=? WHERE id=? AND state='open'",
                     (answer, time.time(), d["id"])).rowcount:
        sys.exit(f"{d['id']} is already {d['state']}" + (f": {d['answer']}" if d["answer"] else ""))
    event(c, d["task_id"], "answered", f"{d['id']}: {answer}")
    m = add_message(c, get_task(c, d["task_id"]), f"Answer to {d['id']} ({d['question']}): {answer}",
                    "answer", decision_id=d["id"])
    out(a, msg_json(c, m), f"m{m['id']}")


def cmd_show_message(c, a):
    m = c.execute("SELECT * FROM messages WHERE id=?", (mid(a.id),)).fetchone()
    if not m:
        sys.exit(f"no message {a.id}")
    print(f"m{m['id']} on {m['task_id']} · {m['kind']} from {m['author']} · {m['state']}\n\n{m['text']}")
    if m["linked_task"]:
        t = get_task(c, m["linked_task"])
        print(f"\nlinked task: {t['id']} [{t['status']}] {t['title']}" + (f" — done: {t['done']}" if t["done"] else ""))
    for fid in json.loads(m["file_ids"] or "[]"):
        f = c.execute("SELECT * FROM files WHERE file_id=?", (fid,)).fetchone()
        if f:
            print(f"attachment: {f['name']} {f['path']}")


def cmd_mark(c, a):
    n = raise_state(c, [mid(x) for x in a.ids], a.state, a.note)
    out(a, {"changed": n}, str(n))


def cmd_turn_start(c, a):
    """A board prompt began a turn: its leading `[ID · mN]` is received, and the turn maps to that message. Prompts
    queued while the lead was busy enter together as one turn that carries the last one's text (TAS-18): the messages
    this conversation, in this same Claude, submitted before it and that are still waiting came in with it, so the turn
    maps to them too. (A /clear keeps the Claude but not the conversation: what the old one took is not this turn's.)"""
    m = LEADING.match(sys.stdin.read())
    row = m and c.execute(f"SELECT * FROM messages WHERE id=? AND task_id=? AND author='user' AND {RANK_SQL} < ?",
                          (int(m[2]), m[1], RANK["replied"])).fetchone()
    if not row:
        return out(a, {"message_ids": [], "task_ids": []}, "")
    rows = c.execute("SELECT m.id, m.task_id FROM messages m JOIN tasks t ON t.id=m.task_id WHERE m.state='accepted' "
                     "AND m.sent_session=? AND m.sent_pid=? AND m.sent_start=? AND m.sent_at<? AND t.repo=(SELECT repo FROM tasks WHERE id=?) "
                     "ORDER BY m.sent_at", (a.session or None, row["sent_pid"], row["sent_start"], row["sent_at"], row["task_id"])).fetchall()
    rows = [row, *rows]  # the envelope's own task first: the turn's questions go there
    ids = [r["id"] for r in rows]
    raise_state(c, ids, "received")
    c.execute("INSERT OR REPLACE INTO prompt_map VALUES(?,?,?)", (a.turn, a.session or "", json.dumps(ids)))
    tasks = list(dict.fromkeys(r["task_id"] for r in rows))
    out(a, {"message_ids": ids, "task_ids": tasks}, " ".join(tasks))


def cmd_resend(c, a):
    """The user's Resend on a message that failed or was cut off mid-send: back in the queue (never automatic)."""
    n = c.execute("UPDATE messages SET state='queued', state_note='' WHERE id=? AND (state='failed' OR (state='sending' AND COALESCE(sent_at, ts)<?))",
                  (mid(a.id), time.time() - STUCK)).rowcount
    if not n:
        sys.exit(f"m{mid(a.id)} isn't waiting for a resend")
    print(f"m{mid(a.id)}")


def cmd_turn_complete(c, a):
    """File the lead's final answer once per mapped task; unmapped turns are ignored."""
    answer = sys.stdin.read().strip()[:20000]
    c.execute("BEGIN IMMEDIATE")  # the mapping read and its delete together: a say --reply can narrow it in between
    row = c.execute("SELECT * FROM prompt_map WHERE prompt_id=?", (a.turn,)).fetchone()
    # An ending with no text (the turn was moved to the background or cut off) keeps the mapping for the real answer.
    # Deleting the mapping is the once-only gate: a second filer for the same turn deletes nothing.
    if not row or not answer or not c.execute("DELETE FROM prompt_map WHERE prompt_id=?", (a.turn,)).rowcount:
        return out(a, {"filed": []}, "")
    ids = json.loads(row["message_ids"])
    raise_state(c, ids, "replied")
    tasks = sorted({r["task_id"] for r in c.execute(f"SELECT task_id FROM messages WHERE id IN ({','.join('?' * len(ids))})", ids)})
    for tid in tasks:  # marked with its conversation and turn, so that turn's late say can't post a second reply
        add_message(c, get_task(c, tid), answer, author="lead", turn=f"{row['session']}/{a.turn}")
    out(a, {"filed": tasks}, " ".join(tasks))


def cmd_general(c, a):
    """The repo's catch-all task for lead questions that belong to no board task."""
    t = c.execute(f"SELECT id FROM tasks WHERE repo=? AND title='General' AND status NOT IN {CLOSED}", (a.repo,)).fetchone()
    if t:
        return print(t["id"])
    a.title, a.alias, a.status, a.origin, a.parent, a.why = "General", "", "running", "lead", None, "Questions from the lead that belong to no other task"
    cmd_new(c, a)


# ---- JSON reads for the mod ----------------------------------------------------

def orca_repos():
    """Read-only: Orca's display name and badge colour per repo, keyed by folder name."""
    try:
        with open(ORCA_DATA) as f:
            repos = json.load(f).get("repos", [])
    except (OSError, ValueError):
        return {}
    # ponytail: matches by the repo folder's name (what repo_of gives for a main checkout); git common-dir match if names ever differ
    return {os.path.basename(r.get("path", "").rstrip("/")): r for r in repos if r.get("path")}


def card(c, t):
    ds = c.execute("SELECT COUNT(*) FROM decisions WHERE task_id=? AND state='open'", (t["id"],)).fetchone()[0]
    rep = report_of(c, t["id"])
    # "Result ready" means a report the user hasn't opened yet: linked (or relinked) after they last viewed its Result tab
    # (this task's own report events: a file's registration time is shared by every task that links that path)
    rep_ts = rep and c.execute("SELECT MAX(ts) FROM events WHERE task_id=? AND kind='result' AND text GLOB 'report: *'",
                               (t["id"],)).fetchone()[0]
    return {"id": t["id"], "repo": t["repo"], "title": t["title"], "status": t["status"], "stage": t["stage"],
            "steps_done": t["steps_done"] or 0, "steps_total": t["steps_total"] or 0, "step_label": t["step_label"] or "",
            "summary": t["done"] or t["next"] or t["why"] or "", "next": t["next"], "needs_you": bool(ds) or t["status"] == "blocked-on-user",
            "open_decisions": ds, "updated": t["updated"], "created": t["created"], "has_result": bool(rep) and (rep_ts or 0) > (t["seen"] or 0),
            "closed": t["status"] in CLOSED,
            # finished, and a board hasn't shown it to the user yet (or did so only HOLD seconds ago): it stays among the open
            "just_done": t["status"] in CLOSED and (t["finished"] or 0) > 0
            and ((t["finish_seen"] or 0) < t["finished"] or time.time() - t["finish_seen"] < HOLD),
            **{k + "s": [{"ref": l["ref"], "label": l["label"]} for l in c.execute(
                "SELECT ref, label FROM links WHERE task_id=? AND kind=?", (t["id"], k))] for k in ("agent", "pr")}}


def report_of(c, tid):
    r = c.execute("SELECT l.ref FROM links l LEFT JOIN files f ON f.path=l.ref WHERE l.task_id=? AND l.kind='report' "
                  "ORDER BY f.ts DESC LIMIT 1", (tid,)).fetchone()
    return r["ref"] if r else None


def decision_json(d):
    return {"id": d["id"], "task_id": d["task_id"], "question": d["question"], "options": json.loads(d["options"]),
            "descs": json.loads(d["descs"] or "[]"), "multi": bool(d["multi"]), "recommended": d["recommended"], "state": d["state"],
            "answer": d["answer"], "raised": d["raised"], "created": d["created"]}


def board(c):
    meta = orca_repos()
    repos = []
    for r in c.execute("SELECT * FROM repos ORDER BY repo"):
        o = meta.get(r["repo"], {})
        repos.append({"repo": r["repo"], "prefix": r["prefix"], "enabled": bool(r["enabled"]),
                      "display_name": o.get("displayName") or r["repo"], "badge_color": o.get("badgeColor"),
                      "lead": lead_state(c, r["repo"])})
    tasks = [card(c, t) for t in c.execute("SELECT * FROM tasks ORDER BY updated DESC")]
    return {"repos": repos, "tasks": tasks, "decisions": [decision_json(d) for d in open_decisions(c)], "updated": time.time()}


def detail(c, tid, more=None, from_m=None, from_e=None):
    """One task in full; with `more` (the board) only its latest `more` messages and events, with their totals, so a
    poll never carries a long history it doesn't show. Older ones come on request (the board's Show earlier), or reach
    back to message `from_m` / event `from_e` (a search hit's evidence, however much has been added since)."""
    t = get_task(c, tid)
    d = card(c, t)
    d.update({k: t[k] for k in ("why", "done", "next", "verified", "origin", "aliases", "parent")})
    d["decisions"] = [decision_json(x) for x in c.execute("SELECT * FROM decisions WHERE task_id=? ORDER BY created", (t["id"],))]
    d["links"] = [dict(l) for l in c.execute("SELECT * FROM links WHERE task_id=?", (t["id"],))]
    d["report"] = report_of(c, t["id"])
    count = lambda q, *args: c.execute(q, (t["id"], *args)).fetchone()[0]
    reach_m = max(more, count("SELECT COUNT(*) FROM messages WHERE task_id=? AND id>=?", from_m)) if from_m and more else more
    # events are fetched newest first by (ts, id), so the count to reach one uses that order too (ids and timestamps
    # can disagree when two writers overlap)
    e0 = from_e and more and c.execute("SELECT ts, id FROM events WHERE id=? AND task_id=?", (from_e, t["id"])).fetchone()
    reach_e = max(more, count("SELECT COUNT(*) FROM events WHERE task_id=? AND (ts>? OR (ts=? AND id>=?))", e0["ts"], e0["ts"], e0["id"])) if e0 else more
    lim = lambda n: (" LIMIT ?", (n,)) if n else ("", ())
    le, lm = lim(reach_e), lim(reach_m)
    d["events"] = [dict(e) for e in c.execute("SELECT id, ts, kind, text FROM events WHERE task_id=? ORDER BY ts DESC, id DESC" + le[0], (t["id"], *le[1]))]
    d["messages"] = [msg_json(c, m) for m in c.execute("SELECT * FROM messages WHERE task_id=? ORDER BY id DESC" + lm[0], (t["id"], *lm[1]))][::-1]
    d["events_total"] = c.execute("SELECT COUNT(*) FROM events WHERE task_id=?", (t["id"],)).fetchone()[0]
    d["messages_total"] = c.execute("SELECT COUNT(*) FROM messages WHERE task_id=?", (t["id"],)).fetchone()[0]
    d["lead"] = lead_state(c, t["repo"])
    return d


# ---- search -----------------------------------------------------------------

STOP = set("""a about after again all also am an and any are as at be been before but by can could did do does done for
from get got had has have how i if in into is it its just like me more most my no not now of on or our out over same so
some still than that the their them then there these they this those to too up us very was we were what when where which
who why will with would you your that's whats find task tasks thing things one ones""".split())
SENTENCE = re.compile(r"(?<=[.!?])\s+|\n+")


def passages(c, t):
    """Every stored text of one task, in sentences, each with where it lives (what the board opens to show it)."""
    tid = t["id"]
    out = [("field", "title", t["title"], None, None)]
    if t["aliases"]:
        out.append(("field", "aliases", t["aliases"], None, None))
    out += [("field", k, t[k], None, None) for k in ("why", "done", "next", "verified") if t[k]]
    for d in c.execute("SELECT question, answer FROM decisions WHERE task_id=?", (tid,)):
        out.append(("field", "decision", d["question"] + (f" → {d['answer']}" if d["answer"] else ""), None, None))
    ms = c.execute("SELECT id, text, ts FROM messages WHERE task_id=? ORDER BY id DESC", (tid,)).fetchall()
    out += [("message", m["id"], m["text"], i + 1, m["ts"]) for i, m in enumerate(ms)]  # pos: 1 = newest
    es = c.execute("SELECT id, text, ts FROM events WHERE task_id=? ORDER BY ts DESC", (tid,)).fetchall()
    out += [("event", e["id"], e["text"], i + 1, e["ts"]) for i, e in enumerate(es)]
    for l in c.execute("SELECT ref FROM links WHERE task_id=? AND kind='report'", (tid,)):
        try:  # only the task's own linked reports, never a crawl
            with open(l["ref"], errors="replace") as f:
                out.append(("report", l["ref"], f.read(200_000), None, None))
        except OSError:
            pass
    return [(kind, ref, s.strip(), pos, ts) for kind, ref, text, pos, ts in out
            for s in SENTENCE.split(text or "") if s.strip()]


def record(t, ps):
    """The compact text of one task the meaning search reads (the word search reads every sentence)."""
    msgs = [p[2] for p in ps if p[0] == "message"][::-1]  # oldest first
    rep = " ".join(p[2] for p in ps if p[0] == "report")
    parts = [f"{t['id']} [{t['status']}] {t['repo']} · {t['title']}"] + [f"{k}: {t[k]}" for k in ("aliases", "why", "done", "next") if t[k]]
    parts += [f"decision: {p[2]}" for p in ps if p[1] == "decision"]
    if msgs:
        parts.append("said: " + " … ".join(dict.fromkeys(m[:160] for m in msgs[:2] + msgs[-2:])))
    if rep:
        parts.append("report: " + rep[:300])
    return " | ".join(parts)


def search(c, q):
    """Task search over every task (open, done, dropped) and all of its text. Word hits ranked by how many of the
    query's words a sentence holds (stemmed); an ID or alias named in the query ranks first. `records` is one compact
    line per task for a meaning search (the board asks a model), which can find a task with no word in common."""
    tasks = c.execute("SELECT * FROM tasks ORDER BY updated DESC").fetchall()
    ql = q.lower()
    ids = re.compile(r"[A-Za-z][A-Za-z0-9]*-\d+")
    named = {x.upper() for x in ids.findall(q)}
    terms = [w for w in dict.fromkeys(re.findall(r"[a-z0-9]+", ids.sub(" ", ql))) if w not in STOP and (len(w) > 2 or w.isdigit())]
    # ponytail: an index built per search (in memory, porter-stemmed); keep one in the store if it grows past ~10k messages
    ix = sqlite3.connect(":memory:")
    ix.execute("CREATE VIRTUAL TABLE s USING fts5(text, tokenize='porter')")
    where, records = {}, []
    for t in tasks:
        ps = passages(c, t)
        records.append({"id": t["id"], "text": record(t, ps), "excerpt": t["done"] or t["why"] or t["next"] or t["title"]})
        for p in ps:
            where[ix.execute("INSERT INTO s(text) VALUES(?)", (p[2],)).lastrowid] = (t["id"], p)
    held = {}  # rowid -> the query words it holds
    for w in terms:
        for (rid,) in ix.execute("SELECT rowid FROM s WHERE s MATCH ?", ('"' + w.replace('"', "") + '"',)):
            held.setdefault(rid, set()).add(w)
    cover = {}  # task -> the query words it holds anywhere
    for rid, ws in held.items():
        cover.setdefault(where[rid][0], set()).update(ws)
    # task -> (score, passage): the most words in all, then the sentence holding most, then where it lives (an event
    # often repeats a message: the message is the evidence), then the newest
    best = {}
    rank = lambda p: {"title": 0, "aliases": 1}.get(p[1], 2) if p[0] == "field" else {"message": 3, "report": 4}.get(p[0], 5)
    for rid, ws in held.items():
        tid, p = where[rid]
        score = (len(cover[tid]), len(ws), -rank(p), -(p[3] or 0))
        if tid not in best or score > best[tid][0]:
            best[tid] = (score, p)
    exact = [t["id"] for t in tasks if t["id"] in named or any(
        a.strip() and re.search(r"(?<![\w-])" + re.escape(a.strip().lower()) + r"(?![\w-])", ql) for a in t["aliases"].split(","))]
    def hit(tid, p, is_exact):
        kind, ref, text, pos, ts = p
        return {"id": tid, "exact": is_exact, "excerpt": text[:300], "where": {"kind": kind, "ref": ref, "pos": pos, "ts": ts}}
    fallback = {r["id"]: ("field", "summary", r["excerpt"], None, None) for r in records}
    hits = [hit(tid, best[tid][1] if tid in best else fallback[tid], True) for tid in exact]
    hits += [hit(tid, p, False) for tid, (_, p) in sorted(best.items(), key=lambda x: x[1][0], reverse=True) if tid not in exact]
    return {"hits": hits, "records": records}


def cmd_search(c, a):
    r = search(c, a.query)
    if a.json:
        return print(json.dumps(r))
    for h in r["hits"]:
        w = h["where"]
        print(f"{h['id']}{' (named)' if h['exact'] else ''} [{w['kind']}{' m' + str(w['ref']) if w['kind'] == 'message' else ''}]: {h['excerpt'][:160]}")
    if not r["hits"]:
        print("no word matches (the board's search also matches by meaning)")


def cmd_board(c, a):
    print(json.dumps(board(c)))


def cmd_mod_tick(c, a):
    """One poll from a Tasks pane: who am I, the board, the open task, and (lead only) this repo's queued messages, claimed."""
    c.execute("BEGIN IMMEDIATE")  # admission, key writes and claims in one write transaction
    repo = repo_of(a.cwd)
    r = c.execute("SELECT * FROM repos WHERE repo=?", (repo,)).fetchone()
    l = lead_row(c, repo)
    # The lead is a registered conversation in the registered terminal (outside Orca: none registered). It is known by
    # its session id (kept by reload, compact and --continue) or its mod's token (kept by reload and compact, gone on
    # /clear); whichever it still has, it gets the other added. Another conversation in that terminal is not the lead.
    keys = [k for k in (a.session, a.token and "tok:" + a.token) if k]
    known = bool(l and a.session and l["session"] == a.session) or any(
        c.execute("SELECT 1 FROM lead_sessions WHERE repo=? AND key=?", (repo, k)).fetchone() for k in keys)
    is_lead = bool(r and r["enabled"] and l and (not l["terminal"] or l["terminal"] == a.terminal) and known)
    # A message submitted by a Claude that has since ended never starts its turn (measured): offer Resend.
    for m in c.execute("SELECT id, sent_pid, sent_start FROM messages WHERE state='accepted' AND sent_pid>0").fetchall():
        if sender_gone(m["sent_pid"], m["sent_start"]):
            raise_state(c, [m["id"]], "failed", "The lead's Claude closed before it read this. Resend to send it again.")
    claimed, reopen = [], ""
    if a.seen:  # any pane drawing a task's Result tab: The user has seen its result
        c.execute("UPDATE tasks SET seen=? WHERE id=?", (time.time(), a.seen.upper()))
    for tid in (a.seen_done or []) + ([a.seen] if a.seen else []):  # a drawn board showed this finished task: once
        c.execute("UPDATE tasks SET finish_seen=? WHERE id=? AND finished>0 AND finish_seen<finished", (time.time(), tid.upper()))
    if is_lead:
        add_keys(c, repo, *keys)
        c.execute("INSERT OR REPLACE INTO lead_state VALUES(?,?,?)", (repo, a.state, time.time()))
        c.execute("DELETE FROM lead_starts WHERE repo=?", (repo,))  # a lead started from the board is up
        b = c.execute("SELECT reopen FROM lead_board WHERE repo=?", (repo,)).fetchone()
        reopen = b["reopen"] if b else ""
        if a.board is not None:  # the lead's board: its view while open, '' closed (what a successor reopens)
            c.execute("INSERT INTO lead_board(repo, view) VALUES(?,?) ON CONFLICT(repo) DO UPDATE SET view=excluded.view", (repo, a.board))
        if reopen:
            c.execute("UPDATE lead_board SET reopen='' WHERE repo=?", (repo,))  # once: closing it after stays closed
        start = start_of(a.pid) if a.pid else None
        for m in c.execute("SELECT m.* FROM messages m JOIN tasks t ON t.id=m.task_id WHERE t.repo=? AND m.author='user' "
                           "AND m.state IN ('queued','held') ORDER BY m.id", (repo,)).fetchall():
            if c.execute("UPDATE messages SET state='sending', state_note='', sent_at=?, sent_pid=?, sent_start=?, sent_session=? "
                         "WHERE id=? AND state IN ('queued','held')", (time.time(), a.pid, start, a.session, m["id"])).rowcount:
                claimed.append(msg_json(c, c.execute("SELECT * FROM messages WHERE id=?", (m["id"],)).fetchone()))
    res = {"me": {"repo": repo, "enabled": bool(r and r["enabled"]), "is_lead": is_lead}, "claimed": claimed, "board": board(c)}
    if is_lead and reopen:
        res["me"]["reopen"] = reopen
    if a.open:
        res["task"] = detail(c, a.open, a.more, a.from_message, a.from_event) if c.execute("SELECT 1 FROM tasks WHERE id=?", (a.open.upper(),)).fetchone() else None
    print(json.dumps(res))


# ---- hook -------------------------------------------------------------------

def is_crew_lead(c, ev, repo):
    sid = ev.get("session_id", "")
    if sid and c.execute("SELECT 1 FROM leads WHERE repo=? AND session=?", (repo, sid)).fetchone():
        return True
    if re.match(r"/(crew:)?crew-lead\b", ev.get("prompt", "").lstrip()):
        return True
    try:  # skill already invoked earlier in this session (a mention in a prompt doesn't count)
        with open(ev["transcript_path"], "rb") as f:
            data = f.read()
        # the skill as a plugin skill is "crew:crew-lead". A regex never matches its own source text, so a session that
        # has merely read this file doesn't count
        return re.search(rb'"skill":"(crew:)?crew-lead"|<command-name>/(crew:)?crew-lead</command-name>', data) is not None
    except (OSError, KeyError):
        return False


def cmd_hook(c, a):
    """UserPromptSubmit, in sessions that look like a crew lead in an enabled repo: the registered lead gets the board;
    any other such session is only told how to register (workers load crew-lead too, so a look is never a seat)."""
    try:
        ev = json.load(sys.stdin)
        repo = repo_of(ev.get("cwd") or os.getcwd())
        r = c.execute("SELECT enabled FROM repos WHERE repo=?", (repo,)).fetchone()
        if not (r and r["enabled"]) or not is_crew_lead(c, ev, repo):
            return
        # Refresh the registered seat only (its terminal; its session outside Orca): a new crew-lead conversation in the
        # lead's own terminal takes it over (seat()). Any other session becomes the lead only by running `tasks lead`.
        sid, term = ev.get("session_id", ""), os.environ.get("ORCA_TERMINAL_HANDLE", "")
        c.execute("BEGIN IMMEDIATE")  # the seat check and the registration in one write transaction
        l = lead_row(c, repo)
        if l and (l["terminal"] == term if l["terminal"] else l["session"] in ("", sid)):
            seat(c, repo, term, sid, ev.get("cwd", ""), [sid])
        c.commit()
        l = lead_row(c, repo)
        if not (sid and l and (l["session"] == sid or c.execute(
                "SELECT 1 FROM lead_sessions WHERE repo=? AND key=?", (repo, sid)).fetchone())):
            hint = (f"crew-board is ON for repo '{repo}', and this session is not its registered lead. If you are this repo's "
                    "crew lead (you coordinate the workers and talk to the user), run `tasks lead` now, then follow the crew-board "
                    "skill. If you are a worker or a reviewer, ignore this.")
            return print(json.dumps({"hookSpecificOutput": {"hookEventName": "UserPromptSubmit", "additionalContext": hint}}))
        tasks = c.execute(f"SELECT * FROM tasks WHERE repo=? AND status NOT IN {CLOSED} ORDER BY created", (repo,)).fetchall()
        lines = [f"crew-board is ON for repo '{repo}'. Follow the crew-board skill (if it isn't loaded, load it now).",
                 "Open tasks:" if tasks else "No open tasks yet. If work is already in flight, file it now (crew-board: When you start, step 3)."]
        lines += ["- " + task_line(c, t) for t in tasks]
        ds = open_decisions(c, repo)
        if ds:
            lines += ["Decisions waiting on the user:"] + ["- " + decision_line(d) for d in ds]
        for tid in dict.fromkeys(t for t, _ in ENVELOPE.findall(ev.get("prompt", ""))):
            bt = c.execute("SELECT * FROM tasks WHERE id=?", (tid,)).fetchone()
            if bt:
                lines.append(f"Board message for {task_line(c, bt)}. Run `tasks show {tid}` for its history. "
                             + f"If it says 'New task:', {tid} already exists: adopt it with tasks set, never tasks new.")
        msg = "\n".join(lines)[:9000]
        print(json.dumps({"hookSpecificOutput": {"hookEventName": "UserPromptSubmit", "additionalContext": msg}}))
    except Exception:
        return  # never break a prompt over the board


def main():
    p = argparse.ArgumentParser(prog="tasks", description=__doc__.split("\n")[0])
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("new", help="create a task, prints its ID")
    s.add_argument("title"); s.add_argument("--why"); s.add_argument("--alias", help="comma list")
    s.add_argument("--origin", default="user", choices=["user", "lead", "worker", "relay"])
    s.add_argument("--status", default="running", choices=STATUSES); s.add_argument("--parent"); s.add_argument("--repo")
    s = sub.add_parser("set", help="update a task's fields (done/next replace the current text)")
    s.add_argument("id")
    for f in ("title", "why", "done", "next", "verified", "alias"):
        s.add_argument("--" + f)
    s.add_argument("--status", choices=STATUSES)
    s.add_argument("--stage", choices=STAGES); s.add_argument("--steps", help="done/total, e.g. 4/8")
    s.add_argument("--step-label", help="what is happening now")
    s.add_argument("--by-user", action="store_true", help="(board) the user ended it themselves: straight to Completed, no hold")
    s = sub.add_parser("note", help="add a timeline entry")
    s.add_argument("id"); s.add_argument("text")
    s.add_argument("--kind", default="note", choices=["note", "result", "ruling", "correction"])
    s = sub.add_parser("ask", help="open a decision for the user, prints its ID")
    s.add_argument("id"); s.add_argument("question"); s.add_argument("--option", action="append")
    s.add_argument("--recommend", type=int, help="1-based option number")
    s.add_argument("--desc", action="append", help="one line per option, in the same order as --option")
    s.add_argument("--multi", action="store_true", help="The user may pick several options")
    s = sub.add_parser("answer", help="record the user's answer (or close a decision another way)")
    s.add_argument("id"); s.add_argument("text")
    s.add_argument("--state", default="answered", choices=["answered", "superseded", "defaulted", "lapsed"])
    s = sub.add_parser("link", help="attach a PR, worktree, artifact or agent")
    s.add_argument("id"); s.add_argument("kind", choices=["pr", "worktree", "artifact", "agent", "file", "report"])
    s.add_argument("ref"); s.add_argument("--label")
    s = sub.add_parser("list", help="open tasks + decisions waiting on the user")
    s.add_argument("--repo"); s.add_argument("--all", action="store_true"); s.add_argument("--closed", action="store_true")
    s.add_argument("--hours", type=int, default=24, help="window for finished tasks, results and rulings")
    s = sub.add_parser("show", help="one task in full"); s.add_argument("id"); s.add_argument("-n", type=int, default=15)
    s.add_argument("--json", action="store_true")
    s = sub.add_parser("say", help="post a lead message on a task's conversation (a progress note)")
    s.add_argument("id"); s.add_argument("text"); s.add_argument("--json", action="store_true")
    s.add_argument("--reply", action="store_true", help="this is your answer to the board message that started this turn")
    s = sub.add_parser("msg", help="(board) the user writes on a task; queued for the lead")
    s.add_argument("id"); s.add_argument("text"); s.add_argument("--kind", default="message", choices=["message", "new_task"])
    s.add_argument("--json", action="store_true")
    s = sub.add_parser("pick", help="(board) the user answers a decision; queued for the lead")
    s.add_argument("id"); s.add_argument("--option", type=int, action="append", help="1-based; repeat on a multi-select decision")
    s.add_argument("--text"); s.add_argument("--json", action="store_true")
    s = sub.add_parser("show-message", help="one board message in full"); s.add_argument("id")
    s = sub.add_parser("mark", help="(mod) move messages forward to a state")
    s.add_argument("ids", nargs="+"); s.add_argument("--state", required=True, choices=list(RANK)); s.add_argument("--note")
    s.add_argument("--json", action="store_true")
    s = sub.add_parser("resend", help="(board) put a failed or cut-off message back in the queue"); s.add_argument("id")
    s = sub.add_parser("turn-start", help="(mod) a turn began with this prompt text (stdin)")
    s.add_argument("--turn", required=True); s.add_argument("--session"); s.add_argument("--json", action="store_true")
    s = sub.add_parser("turn-complete", help="(mod) a turn ended with this answer (stdin)")
    s.add_argument("--turn", required=True); s.add_argument("--json", action="store_true")
    s = sub.add_parser("general", help="(mod) the repo's General task ID, created if missing"); s.add_argument("--repo", required=True)
    sub.add_parser("board", help="(mod) every repo and task as JSON")
    s = sub.add_parser("search", help="find tasks (all repos, done ones too) by their words; --json adds meaning-search records")
    s.add_argument("query"); s.add_argument("--json", action="store_true")
    s = sub.add_parser("mod-tick", help="(mod) one pane poll as JSON")
    s.add_argument("--cwd", required=True); s.add_argument("--session", default=""); s.add_argument("--terminal", default="")
    s.add_argument("--state", default="idle", choices=["idle", "working"]); s.add_argument("--open"); s.add_argument("--more", type=int, default=40)
    s.add_argument("--token", default="", help="the mod's id for this conversation in this process")
    s.add_argument("--pid", type=int, help="the Claude process that will submit what this poll claims")
    s.add_argument("--from-message", type=int, help="with --open: reach back to this message"); s.add_argument("--from-event", type=int)
    s.add_argument("--board", help="the lead's Tasks board: its view as JSON while open, '' closed")
    s.add_argument("--seen", help="the task whose Result tab this pane is drawing")
    s.add_argument("--seen-done", action="append", help="a finished task this pane's drawn Overview showed (repeatable)")
    s = sub.add_parser("enable", help="switch crew-board on/off for a repo")
    s.add_argument("repo"); s.add_argument("--prefix"); s.add_argument("--off", action="store_true")
    s = sub.add_parser("lead", help="register this terminal as the repo's current lead")
    s.add_argument("--repo"); s.add_argument("--terminal"); s.add_argument("--session")
    s = sub.add_parser("start-lead", help="(board) start a Claude lead for a repo with none, in a new Orca terminal")
    s.add_argument("repo"); s.add_argument("--resume", action="store_true", help="bring back the last lead's conversation")
    s.add_argument("--anyway", action="store_true", help="replace a start Orca never confirmed (the board's Start anyway)")
    sub.add_parser("hook", help="UserPromptSubmit hook (reads stdin)")
    a = p.parse_args()
    c = db()
    with c:
        globals()["cmd_" + a.cmd.replace("-", "_")](c, a)


if __name__ == "__main__":
    main()
