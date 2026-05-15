---
description: "Paste a voice transcript or brain dump of household tasks. Claude will extract, sequence, and route them through the house in the most efficient order, then push the session to the Chore Router app."
---

# Chore Dump

Process a voice transcript or freeform brain dump of household tasks into a sequenced chore run for Costa's home at Collier Crescent, Brunswick West.

---

## Step 1 — Read the input

The user has pasted a transcript or brain dump. It may be rambling, unstructured, repetitive, or contain filler words. Work with it as-is.

Detect session mode from the text:
- If it contains "new session" → `action = create_session` (replaces existing tasks in the app)
- Otherwise → `action = append_tasks` (adds to the current session)

---

## Step 2 — Extract tasks

Pull out every discrete task mentioned. Apply these rules:
- Ignore filler words ("um", "uh", "like", "yeah", "you know")
- Collapse duplicates — if the same task is mentioned twice, list it once
- Ignore non-task content (thinking out loud, asides, greetings)
- Write each task as a clean imperative: "Clean oven", "Take out recycling", "Change Christo's sheets"
- If a task involves moving something between rooms, split it into a pickup note and a drop-off note, and flag as a **carry**

---

## Step 3 — Assign zones and sequence tasks

Use the house layout below. Assign each task to its zone, then sequence zones in the default routing order. Assign `sort_order` values as sequential integers across all zones (1, 2, 3...) following the route.

### House Layout: Collier Crescent, Brunswick West

The house runs front (south, Collier Crescent) to rear (north, garden). A central **Hallway** is the main spine connecting all rooms.

**Zone routing order (default — adjust for dependencies):**

| # | Zone | Notes |
|---|------|-------|
| 1 | Porch / Front Exterior | Front entry, letterbox |
| 2 | Hallway | Central corridor |
| 3 | Sofia's Room | Front-right |
| 4 | Lounge | Connects to Hallway and Kitchen |
| 5 | Kitchen / Living | Open plan; connects to Lounge and Rear Verandah |
| 6 | Bins | Right-side exterior, near Kitchen |
| 7 | Christo's Room | Mid-left off Hallway |
| 8 | My Room | Front-left off Hallway (Costa's room) |
| 9 | Laundry | Mid-left; flag if a wash should start early |
| 10 | Spare Toilet | Left side |
| 11 | Bathroom | Rear-left |
| 12 | Rear Verandah | Connects Kitchen to Garden |
| 13 | Garden | Rear exterior |
| 14 | Shed | Rear, accessed via Garden |
| 15 | Errands | Off-site tasks |

**Routing adjustments to apply:**
- If Task B requires Task A's output (e.g. strip Christo's bed → carry linen to Laundry → start wash), keep them in dependency order even if that means revisiting a zone
- Wet/cleaning tasks go last in a zone (don't walk back through a wet floor)
- Bins run is best combined with a Kitchen pass
- If laundry needs a full cycle, flag it at the START of the run so the wash runs while other chores happen — even if the Laundry zone comes later in the route

**Carry items:**
Any item picked up in one zone and dropped in another should be noted as a carry in `carry_note` on the pickup task (e.g. "Carry linen → Laundry"). The app displays these in a Carry Summary at the end.

---

## Step 4 — Build the task list

Produce a JSON array of tasks:

```json
[
  {
    "task": "Strip Christo's bed",
    "zone": "Christo's Room",
    "sort_order": 7,
    "carry_note": "Carry linen → Laundry"
  },
  {
    "task": "Start bed linen wash",
    "zone": "Laundry",
    "sort_order": 9
  }
]
```

Fields:
- `task` — clean imperative string
- `zone` — must match one of the zone names from the table above exactly
- `sort_order` — integer, sequential across all tasks in route order
- `carry_note` — optional string, only when something needs to be carried to another zone

---

## Step 5 — Display the organised plan

Show the chore run to the user in this format before attempting to push it:

```
Chore Run: [today's date]
Mode: [New Session / Appending to current]

[Zone Name]
1. Task
2. Task (carry: item → destination)

[Next Zone]
3. Task
...

--- Carry Summary ---
• Pick up [item] from [Zone] → drop at [Zone]
```

Ask the user to confirm the list looks right before pushing. If they say yes or give the go-ahead, proceed to Step 6.

---

## Step 6 — Push to the Chore Router app

Use the Bash tool to POST the task list to the Apps Script backend:

```bash
curl -s -L -X POST \
  -H "Content-Type: text/plain" \
  -d '<JSON_PAYLOAD>' \
  "https://script.google.com/macros/s/AKfycbw1D0d7ZWbNowpXZpuvmz2VFbZpBlo0leDdfjyUgmc2sNgOnmNXBNQWcDz1ia17JzxsKw/exec"
```

The full payload JSON:
```json
{
  "action": "create_session",
  "tasks": [ ... ]
}
```

(Use `append_tasks` instead of `create_session` if mode is append.)

**If the POST succeeds** (response contains `success: true` or `session_id`): tell the user the tasks are live in the Chore Router app.

**If the POST returns an error or unknown action**: the Apps Script doesn't yet support this endpoint. Tell the user:
> The Chore Router backend needs a one-time update to accept new task sessions. The organised task list is shown above. See `apps-script-handler.gs` in the repo for the code to add to your Apps Script — paste it in and redeploy, then this will push automatically next time.

---

## Edge Cases

- **"Clean the whole house"** — expand to a full sweep in route order: surfaces + vacuum each room, mop wet areas last. Confirm with the user whether it's a quick blitz or deep clean.
- **Task with no clear room** — ask Costa to clarify rather than guess.
- **Laundry dependency** — always check if a wash should start at the beginning of the run. If so, set its `sort_order` to 1 even though Laundry is zone 9 in the route.
- **Outside tasks (Bins, Garden, Shed, Errands)** — always group at the end unless there's a specific time dependency (e.g. bins out before the truck).
