---
description: "Paste a voice transcript or brain dump of household tasks. Claude extracts new chores, things already done, and things to drop, then pushes the changes to the Chore Router app, which routes them through the house."
---

# Chore Dump

Turn a rambling transcript into changes to Costa's chore list at Collier Crescent, Brunswick West, then push them to the app.

The app can do this itself now (there is a dictation box in it). This command is the second door: for long pastes, or when you're already at the keyboard.

There are two places the list can live. Ask which one only if it isn't obvious from context; the artifact is the default.

- **Artifact (default):** https://claude.ai/artifact/B1Lwp7aPAe9BgZEbcA7cZE. The list is one document at `list/current` in the artifact's store. Read it with the `ArtifactData` tool (`action: "get"`, `collection: "list"`, `doc_id: "current"`), write it back with `action: "set"`.
- **Apps Script:** `https://script.google.com/macros/s/AKfycbw1D0d7ZWbNowpXZpuvmz2VFbZpBlo0leDdfjyUgmc2sNgOnmNXBNQWcDz1ia17JzxsKw/exec`. Use the HTTP steps below.

---

## Step 1 — Fetch the current list

Artifact: `ArtifactData` get on `list/current`. The document is `{ session_id, started_at, updated_at, tasks: [...] }` and each task is `{ task_id, zone, task, carry_note, completed, priority, due, sort_order }`.

Apps Script:

```bash
curl -s "https://script.google.com/macros/s/AKfycbw1D0d7ZWbNowpXZpuvmz2VFbZpBlo0leDdfjyUgmc2sNgOnmNXBNQWcDz1ia17JzxsKw/exec?action=get_active"
```

Either way, each task has a `task_id`. You need the ids to complete or remove things.

## Step 2 — Read the transcript and decide the changes

The transcript is messy: filler, repeats, corrections, asides. Work out what Costa means.

- **mode** — `"new"` only if he clearly wants to start over ("new session", "start fresh", "clear the list"). Otherwise `"append"`.
- **add** — genuinely new tasks. Short imperatives, UK English ("Clean oven", "Change Christo's sheets"). One entry per physical job. Don't add anything already on the list. If something moves between rooms, put the task in the pickup zone with `carry_note` like `"Carry linen → Laundry"`, and add a task in the destination only if there's work there. Set `start_early: true` on anything that runs unattended and should kick off first (washing machine, dishwasher, soaking).
- **complete** — ids of existing tasks he says are done. Match on meaning. If it's not on the list, don't add it.
- **remove** — ids he clearly wants dropped ("forget the oven"). Never a guess.

Zones (must match exactly):

| Zone | What's in it |
|---|---|
| Porch / Front Exterior | front door, letterbox, front steps, front garden |
| Hallway | the corridor itself, coat hooks |
| Sofia's Room | |
| Lounge | couch, TV |
| Kitchen / Living | kitchen, dining, benches, oven, fridge, dishwasher, living area |
| Bins | bins out or in, recycling, compost |
| Christo's Room | |
| My Room | Costa's bedroom |
| Laundry | washing machine, dryer, ironing, hanging out washing |
| Spare Toilet | |
| Bathroom | shower, bath, basin |
| Rear Verandah | back deck, outdoor furniture |
| Garden | lawn, weeds, plants, clothesline |
| Shed | |
| Errands | anything away from the house |

You don't sequence anything. The backend walks the house in the order above, puts `start_early` tasks at the top, and keeps existing order within a zone. If Costa gives a real dependency the zone order doesn't capture, say so in the summary rather than fighting the router.

"Clean the whole house" means one surfaces-and-vacuum task per indoor room plus a mop for Kitchen / Living, Bathroom, Spare Toilet and Laundry. Ask whether it's a blitz or a deep clean if it matters.

## Step 3 — Show the plan, briefly

```
Adding (4): Clean oven · Kitchen / Living, ...
Done (2): Take bins out, ...
Dropping (0)
Mode: append
```

If the transcript was unambiguous, push straight away. Ask only when a task has no obvious room or a removal is a guess.

## Step 4 — Push

**Artifact:** apply the plan yourself and write the whole document back with `ArtifactData` set on `list/current`:

1. Mark completed ids `completed: true`. Drop removed ids. Append new tasks with a fresh 12-character `task_id`, `completed: false`, `sort_order: 0`.
2. Re-sort: `priority: "start"` first, then `"urgent"`, then by the zone order above; keep existing order within a group. Renumber `sort_order` from 1.
3. If mode is `new`, first copy the old document to `history/<old session_id>` (set), then write a fresh document with a new `session_id` and `started_at`.
4. Set `updated_at` to now (ISO string).

The page is subscribed to the document, so it updates on his phone the moment the write lands.

**Apps Script:**

```bash
cat > /tmp/chore_payload.json << 'PAYLOAD'
{
  "action": "apply",
  "mode": "append",
  "add": [
    { "zone": "Kitchen / Living", "task": "Clean oven", "carry_note": "", "start_early": false }
  ],
  "complete": ["abc123def456"],
  "remove": []
}
PAYLOAD

curl -s -L -X POST -H "Content-Type: text/plain" \
  --data-binary @/tmp/chore_payload.json \
  "https://script.google.com/macros/s/AKfycbw1D0d7ZWbNowpXZpuvmz2VFbZpBlo0leDdfjyUgmc2sNgOnmNXBNQWcDz1ia17JzxsKw/exec"
```

The response includes the full routed `tasks` list and a `changes` object. Show the list in route order, grouped by zone, with carry notes inline. If `success` is false, show the error and the plan so nothing is lost.
