/**
 * Chore Router — Apps Script additions
 *
 * HOW TO USE:
 * 1. Open your existing Apps Script project at script.google.com
 * 2. Copy the three functions below (createSession_, appendTasks_, jsonResponse_)
 *    and paste them at the bottom of your existing script file.
 * 3. Inside your existing doPost(e) function, find where you handle actions
 *    (the if/else or switch that checks action === 'complete_task' etc.)
 *    and add the two new blocks marked "ADD THIS" below.
 * 4. Update TASKS_SHEET_NAME to match your actual sheet tab name.
 * 5. Redeploy: Deploy → Manage Deployments → select your deployment → Edit → new version → Deploy.
 *
 * Column order assumed (1-indexed):
 *   A=session_id  B=task  C=zone  D=completed  E=sort_order  F=carry_note
 */

var TASKS_SHEET_NAME = 'sessions';

// ─────────────────────────────────────────────────────────────────────────────
// ADD THIS block inside your existing doPost(e) function, alongside your
// existing action handlers (complete_task, complete_session, etc.)
// ─────────────────────────────────────────────────────────────────────────────

function doPost_newActionsSnippet(e) {
  // NOTE: This is a standalone function only so the file parses without errors.
  // Copy the contents of this function body into your real doPost(e).

  var payload = JSON.parse(e.postData.contents);
  var action = payload.action;

  if (action === 'create_session') {
    return jsonResponse_(createSession_(payload.tasks));
  }

  if (action === 'append_tasks') {
    return jsonResponse_(appendTasks_(payload.tasks));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PASTE THESE three functions at the bottom of your Apps Script file
// ─────────────────────────────────────────────────────────────────────────────

function createSession_(tasks) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(TASKS_SHEET_NAME);

  var lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    sheet.deleteRows(2, lastRow - 1);
  }

  var sessionId = 'session_' + new Date().getTime();

  tasks.forEach(function(task) {
    sheet.appendRow([
      sessionId,
      task.task      || '',
      task.zone      || '',
      false,
      task.sort_order || 0,
      task.carry_note || ''
    ]);
  });

  return { success: true, session_id: sessionId, task_count: tasks.length };
}

function appendTasks_(tasks) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(TASKS_SHEET_NAME);

  var lastRow = sheet.getLastRow();
  var sessionId;
  if (lastRow > 1) {
    sessionId = sheet.getRange(lastRow, 1).getValue();
  } else {
    sessionId = 'session_' + new Date().getTime();
  }

  var maxSortOrder = 0;
  if (lastRow > 1) {
    sheet.getRange(2, 5, lastRow - 1, 1).getValues().forEach(function(row) {
      if (row[0] > maxSortOrder) maxSortOrder = row[0];
    });
  }

  tasks.forEach(function(task) {
    sheet.appendRow([
      sessionId,
      task.task      || '',
      task.zone      || '',
      false,
      maxSortOrder + (task.sort_order || 0),
      task.carry_note || ''
    ]);
  });

  return { success: true, session_id: sessionId, tasks_added: tasks.length };
}

function jsonResponse_(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}
