/**********************************************************************
 * TaskManager.gs
 *
 * TASKシートの読み書きを1カ所にまとめ、他の処理コードから
 * 直接シート操作を行わせないための抽象化レイヤー。
 *
 * ■TASKシート列構成
 *   A: ID
 *   B: 名称
 *   C: KEY
 *   D: GROUP_KEY
 *   E: TARGET
 *   F: GUARD
 *   G: TASK
 *   H: TASK_TIME
 *   I: TASK_WAIT(min)
 *   J: TASK_WAIT_TIME
 *   K: QUE
 *   L: QUE_TIME
 *
 * ■目的
 *   - TASKシートを直接読み書きするコードを分散させない
 *   - TASK列の検索・参照をkey/groupKey/targetで行う
 *   - IDへの参照はこのファイル内だけで扱う
 *
 * ■TASK整理(taskCleanupTrigger, 1分ごと・QUEを一切介さない独立トリガー)
 * ・GUARD失効解除・wait失効解除・pushed放置タイムアウト解除・reserve重複整理を、
 *   QUEシート/QUE命令に一切依存せず、TASKシートの読み書きだけで完結させる。
 * ・以前はこれら全部を「QUE整理」(QUEコマンド。10分に1回、QUE経由でしか
 *   起動できない)が担っていたが、QUE整理自身のTASK行がwait/pushedのまま
 *   詰まると「詰まりを解消できるのはQUE整理自身の実行結果だけ」という
 *   循環依存でシステム全体がデッドロックする欠陥があった。
 *   TASK整理をQUEと無関係な独立トリガーに切り出すことで、QUE整理の
 *   生死に関係なく他のtaskの詰まりは解消され続けるようにしている。
 * ・QUE整理自身の詰まりは、repairStuckTaskByKey_による自己修復
 *   (enqueueQueCleanupTrigger内で予約前に呼ばれる)で別途解消する。
 **********************************************************************/

const TASK_CONFIG = {
  SHEET_NAME: "TASK",
  HEADERS: ["ID", "名称", "KEY", "GROUP_KEY", "TARGET", "GUARD", "TASK", "TASK_TIME", "TASK_WAIT(min)", "TASK_WAIT_TIME", "QUE", "QUE_TIME"],
  HIGHLIGHT: {
    ACTIVE_COLOR: "#CCFFCC",
    WAIT_COLOR: "#CCFFFF",
    CLEAR_COLOR: "#FFFFFF"
  },
  STATUS: {
    NONE: "none",
    RESERVE: "reserve",
    WAIT: "wait"
  },
  QUE_FLAG: {
    NONE: "none",
    PUSHED: "pushed"
  },
  COLUMN: {
    ID: 1,
    NAME: 2,
    KEY: 3,
    GROUP_KEY: 4,
    TARGET: 5,
    GUARD: 6,
    TASK: 7,
    TASK_TIME: 8,
    TASK_WAIT_MIN: 9,
    TASK_WAIT_TIME: 10,
    QUE: 11,
    QUE_TIME: 12
  }
};

function normalizeTaskStatus_(value) {
  const v = String(value || "").trim().toLowerCase();

  if (!v) return TASK_CONFIG.STATUS.NONE;
  if (v === "reserve") return TASK_CONFIG.STATUS.RESERVE;
  if (v === "wait") return TASK_CONFIG.STATUS.WAIT;
  if (v === "none") return TASK_CONFIG.STATUS.NONE;

  return v;
}

function normalizeQueFlag_(value) {
  const v = String(value || "").trim().toLowerCase();

  if (!v) return TASK_CONFIG.QUE_FLAG.NONE;
  if (v === "none") return TASK_CONFIG.QUE_FLAG.NONE;
  if (v === "pushed") return TASK_CONFIG.QUE_FLAG.PUSHED;

  return v;
}

function getOrCreateTaskSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(TASK_CONFIG.SHEET_NAME);

  if (!sheet) {
    sheet = ss.insertSheet(TASK_CONFIG.SHEET_NAME);
    setTaskHeaders_(sheet);
  } else {
    ensureTaskHeaders_(sheet);
  }

  syncTaskRowHighlights_(sheet);

  return sheet;
}

function setTaskHeaders_(sheet) {
  const headers = TASK_CONFIG.HEADERS;

  sheet.getRange("A:L").setNumberFormat("@");
  const headerRange = sheet.getRange(1, 1, 1, headers.length);
  headerRange.setValues([headers]);
  headerRange.setBackground("#FFFF00");
  headerRange.setFontWeight("bold");
  headerRange.setHorizontalAlignment("center");
}

function parseTaskWaitMinutes_(value) {
  const minutes = Number(String(value || "").trim());

  if (!isFinite(minutes) || minutes <= 0) {
    return 0;
  }

  return minutes;
}

function parseTaskDateTime_(value) {
  const s = String(value || "").trim();

  if (!s) return null;

  const d = new Date(s);

  if (isNaN(d.getTime())) return null;

  return d;
}

function isTaskGuardBlocked_(item, now) {
  const guard = String(item.guard || "").trim();
  const guardLower = guard.toLowerCase();

  if (!guard) return false;
  if (guardLower === "none") return false;
  if (guardLower === "block") return true;

  const guardTime = parseTaskDateTime_(guard);

  if (!guardTime) return true; // 不正値は安全側でblock扱い

  return now.getTime() < guardTime.getTime();
}

function isTaskWaitBlocked_(item, now) {
  const waitTime = parseTaskDateTime_(item.taskWaitTime);

  if (!waitTime) return false;

  return now.getTime() < waitTime.getTime();
}

function ensureTaskHeaders_(sheet) {
  const expected = TASK_CONFIG.HEADERS;
  const current = sheet.getRange(1, 1, 1, expected.length).getDisplayValues()[0]
    .map(v => String(v || "").trim());

  const needsUpdate = expected.some((header, idx) => current[idx] !== header);

  if (!needsUpdate) {
    return;
  }

  setTaskHeaders_(sheet);
  console.log("【TASK】ヘッダーを最新スキーマへ更新しました");
}

function buildTaskItemFromRow_(row, sheetRow) {
  const targetValue = row[4];
  const normalizedTarget = targetValue ? normalizeDateString_(targetValue) : "";

  return {
    id: String(row[0] || "").trim(),
    name: String(row[1] || "").trim(),
    key: String(row[2] || "").trim(),
    groupKey: String(row[3] || "").trim(),
    target: String(normalizedTarget || "").trim(),
    guard: String(row[5] || "").trim(),
    task: normalizeTaskStatus_(row[6]),
    taskTime: String(row[7] || "").trim(),
    taskWaitMin: String(row[8] || "").trim(),
    taskWaitTime: String(row[9] || "").trim(),
    que: normalizeQueFlag_(row[10]),
    queTime: String(row[11] || "").trim(),
    sheetRow: sheetRow
  };
}

function isTaskCellHighlightActive_(taskValue) {
  const taskLower = normalizeTaskStatus_(taskValue);

  return taskLower === TASK_CONFIG.STATUS.RESERVE || taskLower === "reserve_to_wait";
}

function isQueCellHighlightActive_(queValue) {
  const queLower = normalizeQueFlag_(queValue);
  return queLower === TASK_CONFIG.QUE_FLAG.PUSHED;
}

// ============================
// TASK列(G列)の背景色を、状態に応じて3色に振り分ける。
//   reserve / reserve_to_wait → 緑(ACTIVE_COLOR)
//   wait                      → 薄い水色(WAIT_COLOR)
//   none / それ以外           → 白(CLEAR_COLOR)
// ============================

function resolveTaskCellColor_(taskValue) {
  const taskLower = normalizeTaskStatus_(taskValue);

  if (taskLower === TASK_CONFIG.STATUS.RESERVE || taskLower === "reserve_to_wait") {
    return TASK_CONFIG.HIGHLIGHT.ACTIVE_COLOR;
  }

  if (taskLower === TASK_CONFIG.STATUS.WAIT) {
    return TASK_CONFIG.HIGHLIGHT.WAIT_COLOR;
  }

  return TASK_CONFIG.HIGHLIGHT.CLEAR_COLOR;
}

function updateTaskRowHighlight_(sheet, sheetRow) {
  if (!sheet || !sheetRow || sheetRow < 2) {
    return;
  }

  const rowValues = sheet.getRange(sheetRow, 1, 1, TASK_CONFIG.HEADERS.length).getDisplayValues()[0];
  const taskValue = rowValues[TASK_CONFIG.COLUMN.TASK - 1];
  const queValue = rowValues[TASK_CONFIG.COLUMN.QUE - 1];
  const taskColor = resolveTaskCellColor_(taskValue);
  const queColor = isQueCellHighlightActive_(queValue) ? TASK_CONFIG.HIGHLIGHT.ACTIVE_COLOR : TASK_CONFIG.HIGHLIGHT.CLEAR_COLOR;

  sheet.getRange(sheetRow, TASK_CONFIG.COLUMN.TASK).setBackground(taskColor);
  sheet.getRange(sheetRow, TASK_CONFIG.COLUMN.QUE).setBackground(queColor);
}

function syncTaskRowHighlights_(sheet) {
  if (!sheet) {
    return;
  }

  const lastRow = sheet.getLastRow();

  if (lastRow < 2) {
    return;
  }

  const values = sheet.getRange(2, 1, lastRow - 1, TASK_CONFIG.HEADERS.length).getDisplayValues();
  const taskColors = [];
  const queColors = [];

  values.forEach((row, idx) => {
    const taskValue = row[TASK_CONFIG.COLUMN.TASK - 1];
    const queValue = row[TASK_CONFIG.COLUMN.QUE - 1];
    const taskColor = resolveTaskCellColor_(taskValue);
    const queColor = isQueCellHighlightActive_(queValue) ? TASK_CONFIG.HIGHLIGHT.ACTIVE_COLOR : TASK_CONFIG.HIGHLIGHT.CLEAR_COLOR;

    taskColors.push([taskColor]);
    queColors.push([queColor]);
  });

  sheet.getRange(2, TASK_CONFIG.COLUMN.TASK, values.length, 1).setBackgrounds(taskColors);
  sheet.getRange(2, TASK_CONFIG.COLUMN.QUE, values.length, 1).setBackgrounds(queColors);
}

function getTaskDataRows_(sheet) {
  const lastRow = sheet.getLastRow();

  if (lastRow < 2) {
    return [];
  }

  const values = sheet.getRange(2, 1, lastRow - 1, TASK_CONFIG.HEADERS.length).getValues();

  return values.map((row, idx) => buildTaskItemFromRow_(row, idx + 2));
}

function getTaskRangesByGroupKey(groupKey) {
  if (!groupKey) {
    return [];
  }

  const sheet = getOrCreateTaskSheet_();
  const lastRow = sheet.getLastRow();

  if (lastRow < 2) {
    return [];
  }

  const values = sheet.getRange(2, TASK_CONFIG.COLUMN.GROUP_KEY, lastRow - 1, 1).getDisplayValues();
  const ranges = [];

  values.forEach((row, idx) => {
    const cellValue = String(row[0] || "").trim();

    if (cellValue === groupKey) {
      ranges.push(sheet.getRange(idx + 2, 1, 1, TASK_CONFIG.HEADERS.length));
    }
  });

  return ranges;
}

function getTaskItemsByGroupKey(groupKey) {
  if (!groupKey) {
    return [];
  }

  const sheet = getOrCreateTaskSheet_();
  return getTaskDataRows_(sheet).filter(item => item.groupKey === groupKey);
}

function getTaskItemByKey(key) {
  if (!key) {
    return null;
  }

  const sheet = getOrCreateTaskSheet_();
  const rows = getTaskDataRows_(sheet);

  return rows.find(item => item.key === key) || null;
}

function getTaskItemByGroupKeyAndTarget(groupKey, target) {
  if (!groupKey || !target) {
    return null;
  }

  const sheet = getOrCreateTaskSheet_();
  const rows = getTaskDataRows_(sheet);

  return rows.find(item => item.groupKey === groupKey && item.target === target) || null;
}

function getTaskItemsByTaskAndQue(task, queFlag) {
  const sheet = getOrCreateTaskSheet_();
  const rows = getTaskDataRows_(sheet);
  const normalizedTask = normalizeTaskStatus_(task);
  const normalizedQue = normalizeQueFlag_(queFlag);

  return rows.filter(item => (
    normalizeTaskStatus_(item.task) === normalizedTask &&
    normalizeQueFlag_(item.que) === normalizedQue
  ));
}

function getReservedTaskItemsReadyForQueueing() {
  const now = new Date();
  const targets = getTaskItemsByTaskAndQue(TASK_CONFIG.STATUS.RESERVE, TASK_CONFIG.QUE_FLAG.NONE)
    .filter(item => !isTaskGuardBlocked_(item, now))
    .filter(item => !isTaskWaitBlocked_(item, now));

  // 同条件で複数行ある時の順序を安定させるため、ID昇順で返す。
  return targets.sort((a, b) => Number(a.id || 0) - Number(b.id || 0));
}

function reserveTaskByKey_(key, target) {
  if (!key) {
    return false;
  }

  const taskItem = getTaskItemByKey(key);

  if (!taskItem) {
    return false;
  }

  // ★QUE整理時は「none → reserve」の遷移のみを許可。
  // 既に reserve 状態の TASK は上書きしない。
  if (taskItem.task !== TASK_CONFIG.STATUS.NONE) {
    return false;
  }

  return reserveTaskById_(taskItem.id, target);
}

function reserveTaskByGroupKey_(groupKey, target) {
  if (!groupKey) {
    return false;
  }

  const taskItems = getTaskItemsByGroupKey(groupKey);

  return reserveTaskByTaskItems_(taskItems, target);
}

function reserveTaskByKeyPrefix_(keyPrefix, target) {
  if (!keyPrefix) {
    return false;
  }

  const sheet = getOrCreateTaskSheet_();
  const taskItems = getTaskDataRows_(sheet)
    .filter(item => item.key.indexOf(keyPrefix) === 0);

  return reserveTaskByTaskItems_(taskItems, target);
}

function reserveTaskByTaskItems_(taskItems, target) {
  if (!taskItems || taskItems.length === 0) {
    return false;
  }

  const normalizedTarget = String(target || "").trim();

  // 既に同じTARGETで予約済みなら重複予約しない。
  const alreadyReserved = taskItems.some(item => (
    item.task === TASK_CONFIG.STATUS.RESERVE &&
    String(item.target || "").trim() === normalizedTarget
  ));

  if (alreadyReserved) {
    return false;
  }

  const candidate = taskItems
    .sort((a, b) => Number(a.id || 0) - Number(b.id || 0))
    .find(item => item.que === TASK_CONFIG.QUE_FLAG.NONE && item.task === TASK_CONFIG.STATUS.NONE);

  if (!candidate) {
    return false;
  }

  return reserveTaskById_(candidate.id, normalizedTarget);
}

function reserveTaskById_(taskId, target) {
  if (!taskId) {
    return false;
  }

  const now = Utilities.formatDate(new Date(), CONFIG.TIMEZONE, "yyyy-MM-dd HH:mm:ss");
  const normalizedTarget = target ? normalizeDateString_(target) : "";

  return updateTaskById_(taskId, {
    target: String(normalizedTarget || "").trim(),
    task: TASK_CONFIG.STATUS.RESERVE,
    taskTime: now,
    taskWaitTime: ""
  });
}

function findTaskRowById_(sheet, taskId) {
  if (!taskId) {
    return null;
  }

  const lastRow = sheet.getLastRow();

  if (lastRow < 2) {
    return null;
  }

  const ids = sheet.getRange(2, TASK_CONFIG.COLUMN.ID, lastRow - 1, 1).getDisplayValues();

  for (let idx = 0; idx < ids.length; idx++) {
    if (String(ids[idx][0] || "").trim() === taskId) {
      return idx + 2;
    }
  }

  return null;
}

function findTaskRowByKey_(sheet, key) {
  if (!key) {
    return null;
  }

  const lastRow = sheet.getLastRow();

  if (lastRow < 2) {
    return null;
  }

  const keys = sheet.getRange(2, TASK_CONFIG.COLUMN.KEY, lastRow - 1, 1).getDisplayValues();

  for (let idx = 0; idx < keys.length; idx++) {
    if (String(keys[idx][0] || "").trim() === key) {
      return idx + 2;
    }
  }

  return null;
}

function updateTaskById_(taskId, updates) {
  if (!taskId || !updates || typeof updates !== "object") {
    return false;
  }

  const sheet = getOrCreateTaskSheet_();
  const sheetRow = findTaskRowById_(sheet, taskId);

  if (!sheetRow) {
    return false;
  }

  const updateEntries = [];
  Object.keys(updates).forEach(key => {
    let columnIndex = null;

    switch (key) {
      case "name":
        columnIndex = TASK_CONFIG.COLUMN.NAME;
        break;
      case "key":
        columnIndex = TASK_CONFIG.COLUMN.KEY;
        break;
      case "groupKey":
        columnIndex = TASK_CONFIG.COLUMN.GROUP_KEY;
        break;
      case "target":
        columnIndex = TASK_CONFIG.COLUMN.TARGET;
        break;
      case "guard":
        columnIndex = TASK_CONFIG.COLUMN.GUARD;
        break;
      case "task":
      case "process":
        columnIndex = TASK_CONFIG.COLUMN.TASK;
        break;
      case "taskTime":
      case "time":
        columnIndex = TASK_CONFIG.COLUMN.TASK_TIME;
        break;
      case "taskWaitMin":
      case "taskWait":
        columnIndex = TASK_CONFIG.COLUMN.TASK_WAIT_MIN;
        break;
      case "taskWaitTime":
      case "timeWait":
        columnIndex = TASK_CONFIG.COLUMN.TASK_WAIT_TIME;
        break;
      case "que":
        columnIndex = TASK_CONFIG.COLUMN.QUE;
        break;
      case "queTime":
      case "queueTime":
        columnIndex = TASK_CONFIG.COLUMN.QUE_TIME;
        break;
      default:
        break;
    }

    if (columnIndex !== null) {
      updateEntries.push({ columnIndex, value: updates[key] });
    }
  });

  updateEntries.forEach(entry => {
    sheet.getRange(sheetRow, entry.columnIndex).setValue(entry.value);
  });

  if (updateEntries.length > 0) {
    updateTaskRowHighlight_(sheet, sheetRow);
  }

  return updateEntries.length > 0;
}

function updateTaskByKey_(key, updates) {
  if (!key || !updates || typeof updates !== "object") {
    return false;
  }

  const sheet = getOrCreateTaskSheet_();
  const sheetRow = findTaskRowByKey_(sheet, key);

  if (!sheetRow) {
    return false;
  }

  const taskId = String(sheet.getRange(sheetRow, TASK_CONFIG.COLUMN.ID).getDisplayValue() || "").trim();

  if (!taskId) {
    return false;
  }

  return updateTaskById_(taskId, updates);
}

function resetTaskById_(taskId) {
  if (!taskId) {
    return false;
  }

  return updateTaskById_(taskId, {
    target: "",
    guard: "",
    task: TASK_CONFIG.STATUS.NONE,
    taskTime: "",
    taskWaitTime: "",
    que: TASK_CONFIG.QUE_FLAG.NONE,
    queTime: ""
  });
}

function setTaskWaitByKey_(key) {
  if (!key) {
    return false;
  }

  const taskItem = getTaskItemByKey(key);

  if (!taskItem) {
    return false;
  }

  const waitMinutes = parseTaskWaitMinutes_(taskItem.taskWaitMin);

  if (waitMinutes <= 0) {
    console.log(`【TASK】TASK_WAIT(min)が未設定または不正です: key=${key} / value=${taskItem.taskWaitMin}`);
    return false;
  }

  const nowDate = new Date();
  const waitUntilDate = new Date(nowDate.getTime() + waitMinutes * 60 * 1000);
  waitUntilDate.setSeconds(0, 0);
  const now = Utilities.formatDate(nowDate, CONFIG.TIMEZONE, "yyyy-MM-dd HH:mm:ss");
  const waitUntilStr = Utilities.formatDate(waitUntilDate, CONFIG.TIMEZONE, "yyyy-MM-dd HH:mm:ss");

  return updateTaskById_(taskItem.id, {
    target: "",
    task: TASK_CONFIG.STATUS.WAIT,
    taskTime: now,
    taskWaitTime: waitUntilStr,
    que: TASK_CONFIG.QUE_FLAG.NONE,
    queTime: ""
  });
}

function setTaskWaitAfterQueByKeyAndTarget_(key, target) {
  if (!key) {
    return false;
  }

  const normalizedTarget = target ? normalizeDateString_(target) : "";
  const sheet = getOrCreateTaskSheet_();
  const rows = getTaskDataRows_(sheet);

  const candidate = rows
    .filter(item => (
      item.key === key &&
      String(item.target || "").trim() === String(normalizedTarget || "").trim() &&
      item.task === TASK_CONFIG.STATUS.RESERVE &&
      item.que === TASK_CONFIG.QUE_FLAG.PUSHED
    ))
    .sort((a, b) => Number(a.id || 0) - Number(b.id || 0))[0];

  if (!candidate) {
    return false;
  }

  const waitMinutes = parseTaskWaitMinutes_(candidate.taskWaitMin);

  if (waitMinutes <= 0) {
    console.log(`【TASK】TASK_WAIT(min)が未設定または不正です: key=${key} / target=${normalizedTarget} / value=${candidate.taskWaitMin}`);
    return false;
  }

  const nowDate = new Date();
  const waitUntilDate = new Date(nowDate.getTime() + waitMinutes * 60 * 1000);
  waitUntilDate.setSeconds(0, 0);
  const now = Utilities.formatDate(nowDate, CONFIG.TIMEZONE, "yyyy-MM-dd HH:mm:ss");
  const waitUntilStr = Utilities.formatDate(waitUntilDate, CONFIG.TIMEZONE, "yyyy-MM-dd HH:mm:ss");

  return updateTaskById_(candidate.id, {
    task: TASK_CONFIG.STATUS.WAIT,
    taskTime: now,
    taskWaitTime: waitUntilStr,
    que: TASK_CONFIG.QUE_FLAG.NONE,
    queTime: ""
  });
}

function setTaskQueuedPushedById_(taskId) {
  if (!taskId) {
    return false;
  }

  const now = Utilities.formatDate(new Date(), CONFIG.TIMEZONE, "yyyy-MM-dd HH:mm:ss");

  return updateTaskById_(taskId, {
    que: TASK_CONFIG.QUE_FLAG.PUSHED,
    queTime: now
  });
}

function setTaskQueuedNoneById_(taskId) {
  if (!taskId) {
    return false;
  }

  return updateTaskById_(taskId, {
    que: TASK_CONFIG.QUE_FLAG.NONE,
    queTime: ""
  });
}

function setTaskQueuedPushedByKey(key) {
  if (!key) {
    return false;
  }

  const now = Utilities.formatDate(new Date(), CONFIG.TIMEZONE, "yyyy-MM-dd HH:mm:ss");

  return updateTaskByKey_(key, {
    que: TASK_CONFIG.QUE_FLAG.PUSHED,
    queTime: now
  });
}

function setTaskQueuedPushedByKeyAndTarget(key, target) {
  if (!key) {
    return false;
  }

  const normalizedTarget = target ? normalizeDateString_(target) : "";
  const sheet = getOrCreateTaskSheet_();
  const rows = getTaskDataRows_(sheet);

  const candidate = rows
    .filter(item => (
      item.key === key &&
      String(item.target || "").trim() === String(normalizedTarget || "").trim() &&
      item.task === TASK_CONFIG.STATUS.RESERVE &&
      item.que === TASK_CONFIG.QUE_FLAG.NONE
    ))
    .sort((a, b) => Number(a.id || 0) - Number(b.id || 0))[0];

  if (!candidate) {
    return false;
  }

  return setTaskQueuedPushedById_(candidate.id);
}

function setTaskQueuedNoneByKey(key) {
  if (!key) {
    return false;
  }

  return updateTaskByKey_(key, {
    que: TASK_CONFIG.QUE_FLAG.NONE,
    queTime: ""
  });
}

function clearTimedOutQueuedTasks_(thresholdMinutes) {
  const minutes = Number(thresholdMinutes);

  if (!minutes || minutes <= 0) {
    return 0;
  }

  const sheet = getOrCreateTaskSheet_();
  const rows = getTaskDataRows_(sheet);
  const now = new Date();
  let clearedCount = 0;

  rows.forEach(item => {
    if (item.que !== TASK_CONFIG.QUE_FLAG.PUSHED) {
      return;
    }

    if (!item.queTime) {
      return;
    }

    const queueTime = new Date(item.queTime);

    if (isNaN(queueTime.getTime())) {
      return;
    }

    const diffMinutes = (now.getTime() - queueTime.getTime()) / (1000 * 60);

    if (diffMinutes < minutes) {
      return;
    }

    if (resetTaskById_(item.id)) {
      clearedCount++;
    }
  });

  return clearedCount;
}

function clearExpiredTaskGuards_() {
  const sheet = getOrCreateTaskSheet_();
  const rows = getTaskDataRows_(sheet);
  const now = new Date();
  let clearedCount = 0;

  rows.forEach(item => {
    const guard = String(item.guard || "").trim();

    if (!guard || guard.toLowerCase() === "block") {
      return;
    }

    const guardTime = parseTaskDateTime_(guard);

    if (!guardTime) {
      return;
    }

    if (now.getTime() < guardTime.getTime()) {
      return;
    }

    if (updateTaskById_(item.id, { guard: "" })) {
      clearedCount++;
    }
  });

  return clearedCount;
}

function clearExpiredWaitTasks_() {
  const sheet = getOrCreateTaskSheet_();
  const rows = getTaskDataRows_(sheet);
  const now = new Date();
  let clearedCount = 0;

  rows.forEach(item => {
    if (item.task !== TASK_CONFIG.STATUS.WAIT) {
      return;
    }

    const waitTime = parseTaskDateTime_(item.taskWaitTime);

    if (!waitTime) {
      return;
    }

    if (now.getTime() < waitTime.getTime()) {
      return;
    }

    if (resetTaskById_(item.id)) {
      clearedCount++;
    }
  });

  return clearedCount;
}

function dedupeReservedTasksByGroupAndTarget_() {
  const sheet = getOrCreateTaskSheet_();
  const rows = getTaskDataRows_(sheet);
  const keepByKey = new Map();
  const resetTargets = [];

  rows.forEach(item => {
    if (!item.groupKey || !item.target) {
      return;
    }

    const compositeKey = `${item.groupKey}||${item.target}`;

    if (!keepByKey.has(compositeKey)) {
      keepByKey.set(compositeKey, item);
      return;
    }

    const current = keepByKey.get(compositeKey);
    const currentId = Number(current.id || 0);
    const nextId = Number(item.id || 0);

    if (nextId < currentId) {
      resetTargets.push(current.id);
      keepByKey.set(compositeKey, item);
    } else {
      resetTargets.push(item.id);
    }
  });

  let resetCount = 0;

  resetTargets.forEach(taskId => {
    if (resetTaskById_(taskId)) {
      resetCount++;
    }
  });

  return resetCount;
}


// ============================
// 指定キーのTASK行が「詰まっている」状態かを判定し、詰まっていれば
// 強制的に全列をリセットする(resetTaskById_と同じ内容: none/空欄に戻す)。
//
// 「詰まっている」の定義(どちらか一方でも該当すれば詰まりとみなす):
// ・QUE=pushedのまま、QUE_TIME(積み込み時刻)からthresholdMinutes分以上経過
//   (QUEに積まれたはずが、処理完了/エラーの記録が返ってこないまま放置された。
//    典型例: GASの実行時間制限などで、処理の完了処理まで辿り着けずに
//    実行が強制終了した場合)
// ・TASK=waitのまま、TASK_WAIT_TIMEを過ぎている
//   (通常はTASK整理(clearExpiredWaitTasks_)がここを解除するが、
//    「wait解除の担当自身がこのキーだった」場合、他に解除できる者がいない)
//
// 通常のreserveTaskByKey_(task===none必須)では、この2状態のどちらでも
// 予約に失敗し続けてしまう。QUE整理(CLEAR_QUE)のように「自分自身の実行
// でしか自分の詰まりを解消できない」taskについては、予約を試みる直前に
// これを呼んで強制的に立て直す(enqueueQueCleanupTrigger参照)。
//
// ★force reset + reserveを1つの関数にまとめていない理由:
//   状態が壊れていない通常時は、この関数は何もしない(false を返すだけ)。
//   後続の通常のreserveTaskByKey_(task===none必須)がそのまま機能するので、
//   通常の予約ロジック自体には手を入れずに済む。
// ============================

function repairStuckTaskByKey_(key, thresholdMinutes) {
  if (!key) {
    return false;
  }

  const minutes = Number(thresholdMinutes);

  if (!minutes || minutes <= 0) {
    return false;
  }

  const taskItem = getTaskItemByKey(key);

  if (!taskItem) {
    return false;
  }

  const now = new Date();
  let stuck = false;
  let reason = "";

  if (taskItem.que === TASK_CONFIG.QUE_FLAG.PUSHED) {
    const queTime = parseTaskDateTime_(taskItem.queTime);

    if (queTime && (now.getTime() - queTime.getTime()) / (1000 * 60) >= minutes) {
      stuck = true;
      reason = `QUE=pushedのまま放置(QUE_TIME=${taskItem.queTime}から${minutes}分以上経過)`;
    }
  }

  if (!stuck && taskItem.task === TASK_CONFIG.STATUS.WAIT) {
    const waitTime = parseTaskDateTime_(taskItem.taskWaitTime);

    if (waitTime && now.getTime() >= waitTime.getTime()) {
      stuck = true;
      reason = `TASK=waitのまま期限切れ(TASK_WAIT_TIME=${taskItem.taskWaitTime}を経過)`;
    }
  }

  if (!stuck) {
    return false;
  }

  const repaired = resetTaskById_(taskItem.id);

  if (repaired) {
    console.log(`【TASK】自己修復: key=${key} / 理由=${reason}`);
  }

  return repaired;
}


// ============================
// TASK整理: 1分ごとの独立トリガー。
//
// ★QUEシート・QUE命令には一切依存しない。TASKシートの読み書きだけで
//   完結するシステムメンテナンス処理であることを、関数名(system処理だと
//   分かるラッパー)と、この位置(TaskManager.gs = TASKシート専用ファイル)
//   の両方で明示している。
//
// ・GUARD失効解除(clearExpiredTaskGuards_)
// ・wait失効解除(clearExpiredWaitTasks_) ※全task共通
// ・pushed放置タイムアウト解除(clearTimedOutQueuedTasks_) ※全task共通
// ・reserve重複整理(dedupeReservedTasksByGroupAndTarget_)
//
// 以前はこれら全部を「QUE整理」(QUE経由・10分に1回)が担っていたが、
// QUE整理自身が詰まると誰も解除できなくなる循環依存があったため、
// QUEと無関係なこの独立トリガーに切り出した。
// ============================

const TASK_CLEANUP_THRESHOLD_MINUTES = 10;

// ============================
// 複数のTASK行を、まとめて「pushed」にする(RangeListで一括書き込み)。
//
// ・対象行がシート上でバラバラの位置にあっても、RangeListを使えば
//   API呼び出し3回(QUE値・QUE_TIME値・ハイライト)だけで済む。
// ・1行ずつ updateTaskById_ 経由で処理すると、1行につき最低5回の
//   Sheets API呼び出しになる(QUE値・QUE_TIME値・ハイライト用の行読み込み・
//   背景色2箇所)。件数が増えるほど差が大きくなるため、appendQueTrigger の
//   ような「複数行をまとめてpushed化したい」場面ではこちらを使う。
//
// taskIds: TASKのID配列(getReservedTaskItemsReadyForQueueing等で
//          取得済みのitem.idをそのまま渡せる)。
// 戻り値: 実際に更新できた件数。
// ============================

function markTasksPushedBulk_(taskIds) {
  if (!taskIds || taskIds.length === 0) {
    return 0;
  }

  const sheet = getOrCreateTaskSheet_();

  const sheetRows = taskIds
    .map(id => findTaskRowById_(sheet, id))
    .filter(row => row !== null);

  if (sheetRows.length === 0) {
    return 0;
  }

  const now = Utilities.formatDate(new Date(), CONFIG.TIMEZONE, "yyyy-MM-dd HH:mm:ss");

  const queA1Refs = sheetRows.map(row => sheet.getRange(row, TASK_CONFIG.COLUMN.QUE).getA1Notation());
  const queTimeA1Refs = sheetRows.map(row => sheet.getRange(row, TASK_CONFIG.COLUMN.QUE_TIME).getA1Notation());

  // ①QUE列を全行まとめて "pushed" に
  sheet.getRangeList(queA1Refs).setValue(TASK_CONFIG.QUE_FLAG.PUSHED);
  // ②QUE_TIME列を全行まとめて現在時刻に
  sheet.getRangeList(queTimeA1Refs).setValue(now);
  // ③QUE列のハイライトを全行まとめて緑に
  sheet.getRangeList(queA1Refs).setBackground(TASK_CONFIG.HIGHLIGHT.ACTIVE_COLOR);

  return sheetRows.length;
}


function taskCleanupTrigger() {
  const lock = LockService.getScriptLock();

  if (!lock.tryLock(30000)) {
    console.log("【TASK整理】ロック取得失敗のためスキップ");
    return;
  }

  try {
    const clearedGuards = clearExpiredTaskGuards_();
    const clearedWaitTasks = clearExpiredWaitTasks_();
    const resetTimedOutTasks = clearTimedOutQueuedTasks_(TASK_CLEANUP_THRESHOLD_MINUTES);
    const dedupedTasks = dedupeReservedTasksByGroupAndTarget_();

    console.log(`【TASK整理】完了: GUARD解除${clearedGuards}件 / WAIT解除${clearedWaitTasks}件 / pushedタイムアウト解除${resetTimedOutTasks}件 / 重複整理${dedupedTasks}件`);
  } finally {
    lock.releaseLock();
  }
}