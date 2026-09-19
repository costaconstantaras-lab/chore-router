# Chore Router

Talk at your phone, get a chore list in walking order.

Open the app, tap the box, dictate whatever's in your head. New chores get added in the order you'd actually walk the house. Anything you say you've done gets ticked off. Anything you say to forget gets dropped. Tap a row to tick it manually.

## How it fits together

```
index.html  (phone, GitHub Pages)
    │  GET  ?action=get_active
    │  POST { action: "dictate", text }
    ▼
apps-script/Code.gs  (Google Apps Script web app)
    │  calls Claude with the house layout + current list
    │  applies adds / completes / removes
    │  re-routes the list through the house
    ▼
Google Sheet  (Tasks, Sessions, Log)
```

The split that matters: **Claude does the language, code does the routing.** The model turns "um the oven, and put a wash on, bins are out" into `add: [Clean oven, Start wash (start_early)], complete: [Take bins out]`. The backend then sorts by the fixed zone walk order and puts anything flagged `start_early` at the top. Routing never drifts because a model felt creative.

`/chore-dump` (in `.claude/commands/`) is a second door for long pastes from Claude Code. It does the language step itself and posts the same `apply` payload, so it works even with no API key on the backend.

## Setting up the backend

1. Open the Google Sheet the app uses. Extensions → Apps Script.
2. Replace the contents of `Code.gs` with `apps-script/Code.gs` from this repo.
3. Project Settings → Script Properties. Add `ANTHROPIC_API_KEY`. Optional: `CLAUDE_MODEL` (default `claude-opus-5`), `CLAUDE_EFFORT` (default `low`).
4. Run `setup()` once from the editor. It creates or upgrades the three sheets and their headers. Existing rows are kept; old tasks without a `task_id` get a temporary one.
5. Run `testDictate()` to check the Claude call works end to end. Read the log.
6. Deploy → Manage deployments → edit the existing deployment → New version → Deploy. The URL stays the same, so the app and skill keep working.

If you ever create a brand-new deployment, paste the new `/exec` URL into `APPS_SCRIPT_URL` in `index.html` and into `.claude/commands/chore-dump.md`.

## Working on the app without touching the sheet

Open `index.html?mock` (or `file:///…/index.html?mock`). A fake backend lives in the page: it starts with a few tasks, dictation does a crude split-on-commas, and nothing hits the network. Good enough to iterate on layout and interactions.

Run a local server if you want the mic to work in Chrome:

```bash
python3 -m http.server 8080
# then http://localhost:8080/?mock
```

The mic button uses the Web Speech API and only appears where it's supported (Safari on iOS, Chrome). Everywhere else the keyboard's own dictation into the text box works exactly the same.

## Backend API

All POSTs are `Content-Type: text/plain` with a JSON body (that's what lets Apps Script skip CORS preflight). Every successful POST returns `{ success, session, tasks, changes }`.

| Call | Does |
|---|---|
| `GET ?action=get_active` | Current session and its tasks in route order |
| `GET ?action=ping` | Zones, model, whether a key is set |
| `POST { action: "dictate", text }` | Claude reads the transcript, backend applies the result |
| `POST { action: "apply", mode, add, complete, remove }` | Same, but you already did the thinking |
| `POST { action: "complete_task", task_id }` | Tick one |
| `POST { action: "uncomplete_task", task_id }` | Untick one |
| `POST { action: "remove_task", task_id }` | Drop one |
| `POST { action: "complete_session" }` | Close the session without starting a new one |

`apply` with `mode: "new"` closes the current session and starts a fresh one. `mode: "append"` with no session also creates one.

`changes` looks like `{ mode, added: [{task, zone}], completed: [task], uncompleted: [task], removed: [task], note }`. The app shows it as a toast after each dictation.

### Sheets

**Tasks**: `session_id, zone, task, carry_note, completed, sort_order, task_id, created_at, completed_at, priority`
**Sessions**: `session_id, date, status, created_at`
**Log**: `timestamp, action, input, output, ms` (last 500 requests, handy when a dictation lands somewhere odd)

## Changing the house

Zone names and walk order live in one place: the `ZONES` table at the top of `Code.gs`. The same table feeds the model's prompt, the JSON schema (so the model can't invent a zone) and the router. Keep the copy in `.claude/commands/chore-dump.md` in step if you rename anything.
