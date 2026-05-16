/**
 * Chore Router — Apps Script reference
 *
 * NO CHANGES REQUIRED to your Apps Script.
 * The existing Code.gs already handles everything via the 'new_session' action.
 *
 * Expected POST payload sent by /chore-dump:
 *
 * {
 *   "action": "new_session",
 *   "date": "2026-05-16",
 *   "tasks": [
 *     { "zone": "Kitchen", "task": "Clean oven", "carry_note": "", "sort_order": 1 },
 *     { "zone": "Laundry", "task": "Start wash", "carry_note": "Carry linen from Christo's Room", "sort_order": 2 }
 *   ]
 * }
 *
 * Tasks sheet column order (A–F):
 *   A = session_id  (set by backend)
 *   B = zone
 *   C = task
 *   D = carry_note
 *   E = completed   (set to false by backend)
 *   F = sort_order
 *
 * Sessions sheet column order (A–C):
 *   A = session_id
 *   B = date
 *   C = status ('active' | 'complete')
 */
