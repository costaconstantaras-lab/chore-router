/**
 * Chore Router — Apps Script backend
 *
 * One Google Sheet, one web app, one brain.
 *
 * Deploy: Apps Script editor → Deploy → New deployment → Web app
 *   Execute as: Me. Who has access: Anyone.
 *   Paste the /exec URL into index.html (APPS_SCRIPT_URL) and .claude/commands/chore-dump.md.
 *
 * Script Properties (Project Settings → Script Properties):
 *   ANTHROPIC_API_KEY   required for the `dictate` action
 *   CLAUDE_MODEL        optional, default claude-opus-5
 *   CLAUDE_EFFORT       optional, default low (low | medium | high)
 *   SHEET_ID            optional, only if the script is not bound to the sheet
 *
 * Run setup() once from the editor to create the sheets and headers.
 *
 * ---------------------------------------------------------------------------
 * HTTP contract
 *
 * GET  ?action=get_active            → { success, session, tasks }
 * GET  ?action=ping                  → { success, zones, model, has_key }
 *
 * POST (Content-Type: text/plain, JSON body)
 *   { action: "dictate", text }                       Claude reads the transcript,
 *                                                     works out adds / completes / removes,
 *                                                     backend applies and re-routes.
 *   { action: "apply", mode, add, complete, remove }  Same thing, but you already did
 *                                                     the thinking (used by /chore-dump).
 *   { action: "complete_task",   task_id }
 *   { action: "uncomplete_task", task_id }
 *   { action: "remove_task",     task_id }
 *   { action: "complete_session" }
 *   { action: "new_session", tasks }                  legacy alias for apply mode:"new"
 *
 * Every POST returns { success, session, tasks, changes } on success,
 * or { success: false, error } on failure.
 *
 * Task shape:
 *   { task_id, session_id, zone, task, carry_note, completed, sort_order,
 *     priority ("start" | ""), created_at, completed_at }
 * ---------------------------------------------------------------------------
 */

// ---------------------------------------------------------------------------
// House knowledge. Route order is the walk through the house; the model
// picks the zone, this table decides where it lands in the list.
// ---------------------------------------------------------------------------

const ZONES = [
  { name: 'Porch / Front Exterior', hint: 'front door, letterbox, front steps, front garden' },
  { name: 'Hallway',                hint: 'the corridor itself, coat hooks, inside of front door' },
  { name: "Sofia's Room",           hint: "Sofia's bedroom" },
  { name: 'Lounge',                 hint: 'couch, TV, lounge room' },
  { name: 'Kitchen / Living',       hint: 'kitchen, dining, benches, oven, fridge, dishwasher, living area' },
  { name: 'Bins',                   hint: 'bins out or in, recycling, compost, bin cleaning' },
  { name: "Christo's Room",         hint: "Christo's bedroom" },
  { name: 'My Room',                hint: "Costa's bedroom" },
  { name: 'Laundry',                hint: 'washing machine, dryer, ironing, hanging out or bringing in washing' },
  { name: 'Spare Toilet',           hint: 'the separate toilet' },
  { name: 'Bathroom',               hint: 'shower, bath, basin, bathroom toilet' },
  { name: 'Rear Verandah',          hint: 'back deck, outdoor table and chairs' },
  { name: 'Garden',                 hint: 'lawn, weeds, plants, hose, clothesline' },
  { name: 'Shed',                   hint: 'tools, storage' },
  { name: 'Errands',                hint: 'anything away from the house: shops, post office, pharmacy' }
];

const ZONE_NAMES = ZONES.map(z => z.name);

const SHEETS = { tasks: 'Tasks', sessions: 'Sessions', log: 'Log' };

const TASK_HEADERS = [
  'session_id', 'zone', 'task', 'carry_note', 'completed', 'sort_order',
  'task_id', 'created_at', 'completed_at', 'priority'
];
const SESSION_HEADERS = ['session_id', 'date', 'status', 'created_at'];
const LOG_HEADERS = ['timestamp', 'action', 'input', 'output', 'ms'];

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

function doGet(e) {
  const action = (e && e.parameter && e.parameter.action) || 'get_active';
  try {
    if (action === 'get_active') {
      return json(Object.assign({ success: true }, getActiveState()));
    }
    if (action === 'ping') {
      return json({
        success: true,
        zones: ZONE_NAMES,
        model: modelName(),
        effort: effortLevel(),
        has_key: !!apiKey()
      });
    }
    return json({ success: false, error: 'Unknown action: ' + action });
  } catch (err) {
    return json({ success: false, error: errorText(err) });
  }
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(25000);
  const started = Date.now();
  let body = {};
  try {
    body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const result = handle(body);
    writeLog(body.action, body, result, Date.now() - started);
    return json(result);
  } catch (err) {
    const result = { success: false, error: errorText(err) };
    writeLog(body.action || '?', body, result, Date.now() - started);
    return json(result);
  } finally {
    lock.releaseLock();
  }
}

function handle(body) {
  switch (body.action) {
    case 'dictate':
      return dictate(body.text);
    case 'apply':
      return apply(body);
    case 'complete_task':
      return apply({ mode: 'append', complete: [body.task_id] });
    case 'uncomplete_task':
      return apply({ mode: 'append', uncomplete: [body.task_id] });
    case 'remove_task':
      return apply({ mode: 'append', remove: [body.task_id] });
    case 'complete_session':
      return completeSession();
    case 'new_session':
      return apply({ mode: 'new', add: body.tasks || [] });
    default:
      throw new Error('Unknown action: ' + body.action);
  }
}

// ---------------------------------------------------------------------------
// Dictate: transcript in, applied changes out
// ---------------------------------------------------------------------------

function dictate(text) {
  text = String(text || '').trim();
  if (!text) throw new Error('Nothing to work with. Say or type something first.');

  const state = getActiveState();
  const plan = askClaude(text, state.tasks);

  const result = apply({
    mode: plan.mode,
    add: plan.add,
    complete: plan.complete,
    remove: plan.remove
  });
  result.changes.note = plan.note || '';
  result.changes.transcript = text;
  return result;
}

function askClaude(transcript, tasks) {
  const key = apiKey();
  if (!key) {
    throw new Error(
      'No ANTHROPIC_API_KEY set. In the Apps Script editor go to Project Settings → Script Properties and add it.'
    );
  }

  const listForModel = tasks.map(t => ({
    id: t.task_id,
    zone: t.zone,
    task: t.task,
    done: !!t.completed
  }));

  const userMessage =
    'Current list (JSON):\n' + JSON.stringify(listForModel, null, 0) +
    '\n\nToday: ' + todayISO() +
    '\n\nTranscript:\n' + transcript;

  const body = {
    model: modelName(),
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userMessage }],
    output_config: {
      effort: effortLevel(),
      format: { type: 'json_schema', schema: PLAN_SCHEMA }
    },
    fallbacks: 'default'
  };

  const res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'server-side-fallback-2026-07-01'
    },
    payload: JSON.stringify(body),
    muteHttpExceptions: true
  });

  const status = res.getResponseCode();
  const raw = res.getContentText();
  if (status < 200 || status >= 300) {
    let detail = raw;
    try { detail = JSON.parse(raw).error.message; } catch (_) {}
    throw new Error('Claude API ' + status + ': ' + detail);
  }

  const msg = JSON.parse(raw);
  if (msg.stop_reason === 'refusal') {
    throw new Error('Claude declined that one. Try rephrasing.');
  }
  if (msg.stop_reason === 'max_tokens') {
    throw new Error('That dump was too long for one go. Split it in two.');
  }

  const textBlock = (msg.content || []).find(b => b.type === 'text');
  if (!textBlock) throw new Error('Claude returned no text.');

  let plan;
  try {
    plan = JSON.parse(textBlock.text);
  } catch (err) {
    throw new Error('Claude returned something that was not JSON: ' + textBlock.text.slice(0, 200));
  }

  return {
    mode: plan.mode === 'new' ? 'new' : 'append',
    add: Array.isArray(plan.add) ? plan.add : [],
    complete: Array.isArray(plan.complete) ? plan.complete : [],
    remove: Array.isArray(plan.remove) ? plan.remove : [],
    note: plan.note || ''
  };
}

const SYSTEM_PROMPT = [
  "You turn Costa's spoken brain dumps about housework into changes to his chore list.",
  'The house is at Collier Crescent, Brunswick West.',
  '',
  'You get the current list (each task has an id, zone, text and whether it is done) and a new transcript.',
  'Dictation is messy: filler words, repeats, self-corrections, asides. Work out what he means.',
  '',
  'Return:',
  '- mode: "new" only when he clearly wants to start over ("new session", "start fresh", "clear the list", "scrap all that"). Otherwise "append".',
  '- add: genuinely new tasks. Short imperatives in UK English ("Clean oven", "Change Christo\'s sheets"). One entry per physical job.',
  '  Do not add anything already on the list, done or not, unless he clearly wants it done again.',
  '  If something is moved between rooms, put the task in the pickup zone with carry_note like "Carry towels → Laundry",',
  '  and add a separate task in the destination zone only if there is work to do there.',
  '- complete: ids of existing tasks he says are done ("did the oven", "bins are out", "bathroom is sorted"). Match on meaning, not wording.',
  '  If he says something is done and it is not on the list, do not add it.',
  '- remove: ids of tasks he wants dropped ("forget the oven", "don\'t worry about the shed"). Only when it is clearly a removal, never a guess.',
  '- start_early: true on anything that runs unattended and should kick off first (washing machine, dishwasher, soaking, slow cooker).',
  '- note: one short line when something was ambiguous or you made a call (for example which room). Otherwise an empty string.',
  '',
  'Zones and what belongs in them:',
  ZONES.map(z => '- ' + z.name + ': ' + z.hint).join('\n'),
  '',
  '"Clean the whole house" means one surfaces-and-vacuum task per indoor room, plus mop for Kitchen / Living, Bathroom, Spare Toilet and Laundry.',
  'Anything away from the house goes in Errands.'
].join('\n');

const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    mode: { type: 'string', enum: ['append', 'new'] },
    add: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          task: { type: 'string' },
          zone: { type: 'string', enum: ZONE_NAMES },
          carry_note: { type: 'string' },
          start_early: { type: 'boolean' }
        },
        required: ['task', 'zone', 'carry_note', 'start_early'],
        additionalProperties: false
      }
    },
    complete: { type: 'array', items: { type: 'string' } },
    remove: { type: 'array', items: { type: 'string' } },
    note: { type: 'string' }
  },
  required: ['mode', 'add', 'complete', 'remove', 'note'],
  additionalProperties: false
};

// ---------------------------------------------------------------------------
// Apply: the one place the list changes
// ---------------------------------------------------------------------------

function apply(input) {
  const mode = input.mode === 'new' ? 'new' : 'append';
  const add = Array.isArray(input.add) ? input.add : [];
  const complete = new Set(Array.isArray(input.complete) ? input.complete : []);
  const uncomplete = new Set(Array.isArray(input.uncomplete) ? input.uncomplete : []);
  const remove = new Set(Array.isArray(input.remove) ? input.remove : []);

  let { session, tasks } = getActiveState();
  const changes = { mode, added: [], completed: [], uncompleted: [], removed: [] };
  const now = new Date().toISOString();

  if (mode === 'new' || !session) {
    if (session) setSessionStatus(session.session_id, 'complete');
    session = createSession();
    tasks = [];
  }

  for (const t of tasks) {
    if (complete.has(t.task_id) && !t.completed) {
      t.completed = true;
      t.completed_at = now;
      changes.completed.push(t.task);
    }
    if (uncomplete.has(t.task_id) && t.completed) {
      t.completed = false;
      t.completed_at = '';
      changes.uncompleted.push(t.task);
    }
  }

  tasks = tasks.filter(t => {
    if (remove.has(t.task_id)) {
      changes.removed.push(t.task);
      return false;
    }
    return true;
  });

  const existingKeys = new Set(tasks.map(t => normalise(t.task)));
  add.forEach((a, i) => {
    const text = String(a.task || '').trim();
    if (!text) return;
    const key = normalise(text);
    if (existingKeys.has(key)) return;
    existingKeys.add(key);
    tasks.push({
      session_id: session.session_id,
      zone: normaliseZone(a.zone),
      task: text,
      carry_note: String(a.carry_note || '').trim(),
      completed: false,
      sort_order: 100000 + i,
      task_id: newId(),
      created_at: now,
      completed_at: '',
      priority: a.start_early ? 'start' : ''
    });
    changes.added.push({ task: text, zone: normaliseZone(a.zone) });
  });

  tasks = resequence(tasks);
  writeTasks(session.session_id, tasks);

  return { success: true, session, tasks, changes };
}

function resequence(tasks) {
  const rank = t => (t.priority === 'start' ? -1 : zoneRank(t.zone));
  const sorted = tasks.slice().sort((a, b) => {
    const r = rank(a) - rank(b);
    if (r !== 0) return r;
    return Number(a.sort_order) - Number(b.sort_order);
  });
  sorted.forEach((t, i) => { t.sort_order = i + 1; });
  return sorted;
}

function completeSession() {
  const state = getActiveState();
  if (state.session) setSessionStatus(state.session.session_id, 'complete');
  return Object.assign({ success: true, changes: { mode: 'append', added: [], completed: [], uncompleted: [], removed: [] } }, getActiveState());
}

// ---------------------------------------------------------------------------
// Sheet I/O
// ---------------------------------------------------------------------------

function getActiveState() {
  const sessions = readRows(sheet(SHEETS.sessions, SESSION_HEADERS), SESSION_HEADERS);
  const active = sessions.filter(s => String(s.status).toLowerCase() === 'active').pop();
  if (!active) return { session: null, tasks: [] };

  const tasks = readRows(sheet(SHEETS.tasks, TASK_HEADERS), TASK_HEADERS)
    .filter(t => String(t.session_id) === String(active.session_id))
    .map(t => ({
      session_id: String(t.session_id),
      zone: String(t.zone || ''),
      task: String(t.task || ''),
      carry_note: String(t.carry_note || ''),
      completed: t.completed === true || String(t.completed).toLowerCase() === 'true',
      sort_order: Number(t.sort_order) || 0,
      task_id: String(t.task_id || '') || ('legacy_' + t.sort_order),
      created_at: String(t.created_at || ''),
      completed_at: String(t.completed_at || ''),
      priority: String(t.priority || '')
    }))
    .sort((a, b) => a.sort_order - b.sort_order);

  return {
    session: {
      session_id: String(active.session_id),
      date: String(active.date),
      status: String(active.status)
    },
    tasks
  };
}

function writeTasks(sessionId, tasks) {
  const s = sheet(SHEETS.tasks, TASK_HEADERS);
  const others = readRows(s, TASK_HEADERS).filter(r => String(r.session_id) !== String(sessionId));
  const rows = others.concat(tasks).map(t => TASK_HEADERS.map(h => t[h] === undefined ? '' : t[h]));
  s.clearContents();
  s.getRange(1, 1, 1, TASK_HEADERS.length).setValues([TASK_HEADERS]);
  if (rows.length) s.getRange(2, 1, rows.length, TASK_HEADERS.length).setValues(rows);
}

function createSession() {
  const s = sheet(SHEETS.sessions, SESSION_HEADERS);
  const session = {
    session_id: newId(),
    date: todayISO(),
    status: 'active',
    created_at: new Date().toISOString()
  };
  s.appendRow(SESSION_HEADERS.map(h => session[h]));
  return { session_id: session.session_id, date: session.date, status: session.status };
}

function setSessionStatus(sessionId, status) {
  const s = sheet(SHEETS.sessions, SESSION_HEADERS);
  const values = s.getDataRange().getValues();
  const idCol = values[0].indexOf('session_id');
  const statusCol = values[0].indexOf('status');
  for (let r = 1; r < values.length; r++) {
    if (String(values[r][idCol]) === String(sessionId)) {
      s.getRange(r + 1, statusCol + 1).setValue(status);
    }
  }
}

function writeLog(action, input, output, ms) {
  try {
    const s = sheet(SHEETS.log, LOG_HEADERS);
    s.appendRow([
      new Date().toISOString(),
      action || '',
      JSON.stringify(input).slice(0, 5000),
      JSON.stringify(output && output.changes ? output.changes : output).slice(0, 5000),
      ms
    ]);
    const max = 500;
    const extra = s.getLastRow() - 1 - max;
    if (extra > 0) s.deleteRows(2, extra);
  } catch (_) {
    // Logging must never break a request.
  }
}

/** Returns the sheet, creating it and its header row if missing. */
function sheet(name, headers) {
  const book = spreadsheet();
  let s = book.getSheetByName(name);
  if (!s) s = book.insertSheet(name);
  const first = s.getLastRow() ? s.getRange(1, 1).getValue() : '';
  if (String(first) !== headers[0]) {
    s.insertRowBefore(1);
    s.getRange(1, 1, 1, headers.length).setValues([headers]);
  } else if (s.getLastColumn() < headers.length) {
    s.getRange(1, 1, 1, headers.length).setValues([headers]);
  }
  return s;
}

/** Reads every data row as an object keyed by the sheet's own header row. */
function readRows(s, fallbackHeaders) {
  const values = s.getDataRange().getValues();
  if (values.length < 2) return [];
  const headers = values[0].map(h => String(h || '').trim());
  return values.slice(1)
    .filter(row => row.some(cell => cell !== '' && cell !== null))
    .map(row => {
      const obj = {};
      headers.forEach((h, i) => { if (h) obj[h] = row[i]; });
      fallbackHeaders.forEach((h, i) => { if (obj[h] === undefined) obj[h] = row[i]; });
      return obj;
    });
}

function spreadsheet() {
  const id = prop('SHEET_ID');
  return id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function zoneRank(zone) {
  const i = ZONE_NAMES.indexOf(zone);
  return i === -1 ? ZONE_NAMES.length : i;
}

function normaliseZone(zone) {
  const z = String(zone || '').trim();
  if (ZONE_NAMES.includes(z)) return z;
  const lower = z.toLowerCase();
  const hit = ZONE_NAMES.find(n => n.toLowerCase() === lower) ||
    ZONE_NAMES.find(n => n.toLowerCase().includes(lower) || lower.includes(n.toLowerCase().split(' / ')[0]));
  return hit || (z || 'Hallway');
}

function normalise(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
}

function newId() {
  return Utilities.getUuid().replace(/-/g, '').slice(0, 12);
}

function todayISO() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

function prop(name) {
  return PropertiesService.getScriptProperties().getProperty(name);
}

function apiKey() { return prop('ANTHROPIC_API_KEY'); }
function modelName() { return prop('CLAUDE_MODEL') || 'claude-opus-5'; }
function effortLevel() { return prop('CLAUDE_EFFORT') || 'low'; }

function errorText(err) {
  return String((err && err.message) || err);
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ---------------------------------------------------------------------------
// Run these from the editor
// ---------------------------------------------------------------------------

/** One-off: creates sheets and headers, reports config. */
function setup() {
  sheet(SHEETS.tasks, TASK_HEADERS);
  sheet(SHEETS.sessions, SESSION_HEADERS);
  sheet(SHEETS.log, LOG_HEADERS);
  Logger.log('Sheets ready. Model: %s, effort: %s, API key set: %s', modelName(), effortLevel(), !!apiKey());
}

/** Smoke test for the Claude call without touching the phone. */
function testDictate() {
  const out = dictate('um so the oven needs doing, put a wash on first, and I already took the bins out. Also grab milk.');
  Logger.log(JSON.stringify(out.changes, null, 2));
  Logger.log(out.tasks.map(t => t.sort_order + '. [' + t.zone + '] ' + t.task + (t.completed ? ' ✓' : '')).join('\n'));
}
