/**
 * Chore Router — Apps Script backend additions
 *
 * Add these cases to your existing doPost(e) function,
 * inside the switch/if block that checks `action`.
 *
 * IMPORTANT: Update SHEET_NAME and column indices below to match
 * your actual Google Sheet tab name and layout.
 *
 * Assumed column order (1-indexed):
 *   A=session_id, B=task, C=zone, D=completed, E=sort_order, F=carry_note
 *
 * After pasting this in, click Deploy → Manage Deployments →
 * create a New Deployment (or update the existing one) and copy
 * the new URL back into index.html and chore-dump.md.
 */

var TASKS_SHEET_NAME = 'Tasks';      // <-- update if your tab is named differently
var SESSION_SHEET_NAME = 'Sessions'; // <-- update if you track sessions separately
                                     //     (or remove if sessions are in the Tasks sheet)

// ─── ADD THESE CASES TO YOUR doPost HANDLER ────────────────────────────────

// case 'create_session':
if (action === 'create_session') {
  var result = createSession_(payload.tasks);
  return jsonResponse(result);
}

// case 'append_tasks':
if (action === 'append_tasks') {
  var result = appendTasks_(payload.tasks);
  return jsonResponse(result);
}

// ─── HELPER FUNCTIONS (add outside doPost) ──────────────────────────────────

function createSession_(tasks) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(TASKS_SHEET_NAME);

  // Clear all existing task rows (keep header row 1)
  var lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    sheet.deleteRows(2, lastRow - 1);
  }

  var sessionId = 'session_' + new Date().getTime();

  tasks.forEach(function(task) {
    sheet.appendRow([
      sessionId,
      task.task || '',
      task.zone || '',
      false,                    // completed
      task.sort_order || 0,
      task.carry_note || ''
    ]);
  });

  return { success: true, session_id: sessionId, task_count: tasks.length };
}

function appendTasks_(tasks) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(TASKS_SHEET_NAME);

  // Reuse the current session_id from the last row, or create a new one
  var lastRow = sheet.getLastRow();
  var sessionId;
  if (lastRow > 1) {
    sessionId = sheet.getRange(lastRow, 1).getValue();
  } else {
    sessionId = 'session_' + new Date().getTime();
  }

  // Offset sort_order so appended tasks come after existing ones
  var maxSortOrder = 0;
  if (lastRow > 1) {
    var sortOrders = sheet.getRange(2, 5, lastRow - 1, 1).getValues();
    sortOrders.forEach(function(row) {
      if (row[0] > maxSortOrder) maxSortOrder = row[0];
    });
  }

  tasks.forEach(function(task) {
    sheet.appendRow([
      sessionId,
      task.task || '',
      task.zone || '',
      false,
      maxSortOrder + (task.sort_order || 0),
      task.carry_note || ''
    ]);
  });

  return { success: true, session_id: sessionId, tasks_added: tasks.length };
}

function jsonResponse(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}
