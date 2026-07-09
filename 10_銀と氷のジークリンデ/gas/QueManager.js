/**********************************************************************
 * QueManager.gs
 *
 * QUE方式(命令キュー)の読み書き基盤。
 *
 * ■QUEシート列構成
 *   A: ID("QUE-"+英大文字/小文字/数字8桁。例: QUE-aB3dE7gH。
 *      積んだ時点(enqueue_)に発番される。同じ行を安定して識別するために
 *      常にIDを持つことが前提となる)
 *   B: 命令種別
 *   C: 対象日付(yyyy-MM-dd。日付を持たない/絞り込まない命令は空欄)
 *   D: 優先度
 *   E: 積み元(どの処理がこの行を積んだか)
 *   F: ステータス(未処理 / 処理中 / 完了 / エラー:〜 / 待機)
 *   G: 作成日時(積まれた時)
 *   H: 処理開始日時(「処理中」になった時)
 *   I: 処理終了日時(「完了」になった時、またはエラー時)
 *   J: 監視メッセージ
 *
 * ■命令種別と優先度
 *   QUE整理            (優先度に関わらず、シート上のどこにあっても
 *                       最優先で選ばれる。pickNextQueItem_参照)
 *   検索API叩け        優先度10
 *   検索ブロック        優先度10相当(「待機」ステータスで積まれ、
 *                       通常のpickNextQueItem_からは無視される)
 *   日付シート作成      優先度20(複数ある場合、処理直前に対象日付の
 *                       降順で20,21,22...と採番し直す。積む時点では
 *                       全部20のまま積んでよい)
 *   サマリ更新          優先度30
 *   10分集計            優先度40
 *   PV取得シート更新     優先度50
 *   PV取得実行          優先度60(未処理が残れば自分自身をまた積む)
 *
 * ■QUE整理(最優先の特別な命令)
 * ・enqueueQueCleanupTrigger という専用の5分トリガーが積む
 *   (既に未処理/処理中で存在するなら重複スキップ)。
 * ・pickNextQueItem_は、シート上のどこにあっても「QUE整理」を
 *   最優先で選ぶ。「QUE整理」が処理中の間は、他の一切の命令は
 *   選ばれない(queWorkerTriggerは何もせず終了する)。
 * ・「QUE整理」が未処理/処理中の間は、enqueue_自体もブロックされ、
 *   他の命令は一切積めない(検索ブロック・QUE整理自身を除く)。
 * ・行の削除は、この「QUE整理」だけが行う(他に削除する仕組みは無い)。
 *   実際に削除する対象:
 *     - 「処理中」のまま処理開始日時(H列)から10分以上経過した行
 *     - 「待機」のまま作成日時(G列)から10分以上経過した行
 *     - 「完了」/「エラー:〜」で、処理終了日時(I列)が空、または
 *       処理終了日時から10分以上経過した行
 * ・★注意: 安全網は意図的に持たせていない。もし「QUE整理」自身が
 *   (GASの実行時間制限などで)処理中のまま固まると、削除できる者が
 *   誰もいなくなり、QUE全体が永久に詰まる。シンプルさを優先して
 *   このリスクを受け入れる、という判断で今はこの形にしている。
 *
 * ■検索ブロック(検索API叩けの間隔をあけるための仕組み)
 * ・検索API叩けの処理(processFetchApiCommand_)が完了した直後に、
 *   「検索ブロック」を最初から「待機」ステータスで積む
 *   (「未処理」を経由しない。よって通常のpickNextQueItem_からは
 *   無視され、処理中になることもない)。
 * ・enqueueFetchApiTrigger(5分ごと)は、QUEに「検索ブロック」が
 *   存在する間は検索API叩けを積まない(スキップする)。
 * ・「検索ブロック」は、作成から10分経過するとQUE整理が削除する。
 *   削除されて初めて、次の検索API叩けが積めるようになる。
 *
 * ■一意性ルール
 *   enqueue_() は、同じ「命令種別+対象日付」の組み合わせが
 *   既に「未処理」または「処理中」で存在する場合、追加をスキップする。
 *   (「完了」は判定対象に含めない=完了後は再度積んでよい)
 *
 *   第4引数 allowDuplicate に true を渡すと、この重複チェック自体を
 *   スキップして必ず積む。実行中の命令が「自分自身(処理中の行)」を
 *   続きのバッチとして再度積みたい場合(例: PV取得実行が未処理を
 *   規定件数処理した後、まだ残っていれば自分自身を再度積む)に使う。
 *
 * ■100行上限
 *   QUEシートのデータ行は最大100行までとする。
 *   101行目を追加しようとする時、既に100行あれば追加を見送る
 *   (スキップする)。行の削除は行わない(削除はQUE整理だけが行う)。
 *
 * ■QUEシートの置き場所
 *   このプロジェクトがバインドされているスプレッドシート
 *   (SpreadsheetApp.getActiveSpreadsheet())の中に置く。
 *   月別ファイルの中ではない。
 *
 * ■排他制御
 *   QUEへの読み書きは、呼び出し元(各トリガー)側で
 *   LockService.getScriptLock() を取った状態で行う想定。
 *   このファイル自体はロックの取得/解放を行わない。
 **********************************************************************/


const QUE_CONFIG = {
  SHEET_NAME: "QUE",

  STATUS: {
    PENDING: "未処理",
    IN_PROGRESS: "処理中",
    DONE: "完了",
    WAITING: "待機"
  },

  COMMAND: {
    CLEANUP: "QUE整理",
    FETCH_API: "検索API叩け",
    FETCH_API_BLOCK: "検索ブロック",
    CREATE_DAILY_SHEET: "日付シート作成",
    UPDATE_SUMMARY: "サマリ更新",
    TEN_MINUTE: "10分集計",
    UPDATE_PV_SHEET: "PV取得シート更新",
    FETCH_PV_SHEET: "PV取得実行"
  },

  PRIORITY: {
    CLEANUP: 0,
    FETCH_API: 10,
    CREATE_DAILY_SHEET_BASE: 20, // 積む時点では全部これでよい(処理直前に採番し直す)
    UPDATE_SUMMARY: 30,
    TEN_MINUTE: 40,
    UPDATE_PV_SHEET: 50,
    FETCH_PV_SHEET: 60
  }
};


// ============================
// QUEシートを取得する。無ければ作成しヘッダーを設定する。
// ============================

function getOrCreateQueSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(QUE_CONFIG.SHEET_NAME);

  if (!sheet) {
    sheet = ss.insertSheet(QUE_CONFIG.SHEET_NAME);
    setQueHeaders_(sheet);
  }

  return sheet;
}


// ============================
// QUEシートのヘッダーを設定する
// ============================

function setQueHeaders_(sheet) {
  const headers = ["ID", "命令種別", "対象日付", "優先度", "積み元", "ステータス", "作成日時", "処理開始日時", "処理終了日時", "監視メッセージ"];

  const headerRange = sheet.getRange(1, 1, 1, headers.length);

  sheet.getRange("A:J").setNumberFormat("@");
  headerRange.setValues([headers]);
  headerRange.setBackground("#FFFF00");
  headerRange.setFontWeight("bold");
  headerRange.setHorizontalAlignment("center");
}


// ============================
// QUE用のランダムID("QUE-"+英大文字/小文字/数字8桁)を発番する
// ============================

function generateQueId_() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let id = "";

  for (let i = 0; i < 8; i++) {
    id += chars.charAt(Math.floor(Math.random() * chars.length));
  }

  return `QUE-${id}`;
}

function collectExistingQueIds_(sheet) {
  const lastRow = sheet.getLastRow();

  if (lastRow < 2) {
    return new Set();
  }

  const idValues = sheet.getRange(2, 1, lastRow - 1, 1).getDisplayValues();
  const idSet = new Set();

  idValues.forEach(row => {
    const id = String(row[0] || "").trim();

    if (id) {
      idSet.add(id);
    }
  });

  return idSet;
}

function generateUniqueQueId_(sheet) {
  const existingIds = collectExistingQueIds_(sheet);
  let queId = generateQueId_();
  let retryCount = 0;

  while (existingIds.has(queId)) {
    retryCount++;

    // 事実上衝突しない想定だが、念のため再生成を上限付きで続ける。
    if (retryCount > 1000) {
      throw new Error("【QUE】ID衝突が解消できませんでした");
    }

    queId = generateQueId_();
  }

  return queId;
}

function getTaskRangesByGroupKeyFromQue(groupKey) {
  return getTaskRangesByGroupKey(groupKey);
}

function getTaskItemByKeyFromQue(key) {
  return getTaskItemByKey(key);
}

function getTaskItemByGroupKeyAndTargetFromQue(groupKey, target) {
  return getTaskItemByGroupKeyAndTarget(groupKey, target);
}

function getReservedTaskItemsReadyForQueueingFromQue() {
  return getReservedTaskItemsReadyForQueueing();
}

function markTaskPushed(taskKey, targetDateStr) {
  return setTaskQueuedPushedByKeyAndTarget(taskKey, targetDateStr || "");
}

function markTaskPushedByKey(taskKey) {
  return setTaskQueuedPushedByKey(taskKey);
}

function markTaskQueuedOff(taskKey) {
  return setTaskQueuedNoneByKey(taskKey);
}

function markTaskWaitAfterQue(taskKey, targetDateStr) {
  return setTaskWaitAfterQueByKeyAndTarget_(taskKey, targetDateStr || "");
}

function clearTimedOutQueuedTasksFromQue(thresholdMinutes) {
  return clearTimedOutQueuedTasks_(thresholdMinutes);
}

function clearExpiredTaskGuardsFromQue() {
  return clearExpiredTaskGuards_();
}

function clearExpiredWaitTasksFromQue() {
  return clearExpiredWaitTasks_();
}

function setTaskWaitForQue(taskKey) {
  return setTaskWaitByKey_(taskKey);
}

function dedupeReservedTasksByGroupAndTargetFromQue() {
  return dedupeReservedTasksByGroupAndTarget_();
}

function ensureTaskSheetReadyFromQue_() {
  // TaskManager側でヘッダー同期まで実施される。
  getOrCreateTaskSheet_();
}

function getTaskToQueRoutes_() {
  return [
    {
      matchType: "exact",
      taskKey: TASK_TRIGGER_KEY.FETCH_SEARCH_API,
      commandType: QUE_CONFIG.COMMAND.FETCH_API,
      priority: QUE_CONFIG.PRIORITY.FETCH_API
    },
    {
      matchType: "exact",
      taskKey: TASK_TRIGGER_KEY.FETCH_API_BLOCK,
      commandType: QUE_CONFIG.COMMAND.FETCH_API_BLOCK,
      priority: QUE_CONFIG.PRIORITY.FETCH_API,
      initialStatus: QUE_CONFIG.STATUS.WAITING
    },
    {
      matchType: "prefix",
      taskKey: TASK_TRIGGER_PREFIX.UPDATE_DAY,
      commandType: QUE_CONFIG.COMMAND.CREATE_DAILY_SHEET,
      priority: QUE_CONFIG.PRIORITY.CREATE_DAILY_SHEET_BASE
    },
    {
      matchType: "exact",
      taskKey: TASK_TRIGGER_KEY.UPDATE_SUMMARY,
      commandType: QUE_CONFIG.COMMAND.UPDATE_SUMMARY,
      priority: QUE_CONFIG.PRIORITY.UPDATE_SUMMARY
    },
    {
      matchType: "exact",
      taskKey: TASK_TRIGGER_KEY.UPDATE_TEN_MINUTE_PV,
      commandType: QUE_CONFIG.COMMAND.TEN_MINUTE,
      priority: QUE_CONFIG.PRIORITY.TEN_MINUTE
    },
    {
      matchType: "prefix",
      taskKey: TASK_TRIGGER_PREFIX.UPDATE_PV,
      commandType: QUE_CONFIG.COMMAND.UPDATE_PV_SHEET,
      priority: QUE_CONFIG.PRIORITY.UPDATE_PV_SHEET
    },
    {
      matchType: "prefix",
      taskKey: TASK_TRIGGER_PREFIX.FETCH_PV,
      commandType: QUE_CONFIG.COMMAND.FETCH_PV_SHEET,
      priority: QUE_CONFIG.PRIORITY.FETCH_PV_SHEET
    },
    {
      matchType: "exact",
      taskKey: TASK_TRIGGER_KEY.CLEAR_QUE,
      commandType: QUE_CONFIG.COMMAND.CLEANUP,
      priority: QUE_CONFIG.PRIORITY.CLEANUP
    }
  ];
}

function matchTaskRoute_(taskKey, route) {
  if (route.matchType === "exact") {
    return taskKey === route.taskKey;
  }

  if (route.matchType === "prefix") {
    return taskKey.indexOf(route.taskKey) === 0;
  }

  return false;
}

function compareTaskTimeAsc_(a, b) {
  const aTime = String(a.taskTime || "").trim();
  const bTime = String(b.taskTime || "").trim();

  // yyyy-MM-dd HH:mm:ss 形式なので文字列比較で時系列順になる。
  if (aTime && bTime && aTime !== bTime) {
    return aTime.localeCompare(bTime);
  }

  if (aTime && !bTime) return -1;
  if (!aTime && bTime) return 1;

  return Number(a.id || 0) - Number(b.id || 0);
}

function sortTaskItemsForAppend_(taskItems) {
  const items = taskItems.slice();

  // グループやキー種別に関係なく、TASK_TIMEの古いものからQUEへ積む。
  items.sort(compareTaskTimeAsc_);

  return items;
}

function resolveQueCommandFromTask_(taskItem) {
  if (!taskItem || !taskItem.key) {
    return null;
  }

  const taskKey = String(taskItem.key).trim();

  const routes = getTaskToQueRoutes_();

  for (let i = 0; i < routes.length; i++) {
    const route = routes[i];

    if (matchTaskRoute_(taskKey, route)) {
      return {
        commandType: route.commandType,
        priority: route.priority,
        initialStatus: route.initialStatus
      };
    }
  }

  return null;
}

function hasActiveQueCommand_(commandType, targetDateStr) {
  if (!commandType) {
    return false;
  }

  const sheet = getOrCreateQueSheet_();
  const lastRow = sheet.getLastRow();

  if (lastRow < 2) {
    return false;
  }

  const normalizedTarget = targetDateStr ? normalizeDateString_(targetDateStr) : "";
  const values = sheet.getRange(2, 1, lastRow - 1, 6).getDisplayValues(); // ID,命令種別,対象日付,優先度,積み元,ステータス

  return values.some(row => {
    const rowCommand = String(row[1] || "").trim();
    const rowTarget = row[2] ? normalizeDateString_(row[2]) : "";
    const rowStatus = String(row[5] || "").trim();

    const isActive = (
      rowStatus === QUE_CONFIG.STATUS.PENDING ||
      rowStatus === QUE_CONFIG.STATUS.IN_PROGRESS ||
      rowStatus === QUE_CONFIG.STATUS.WAITING
    );

    return isActive && rowCommand === commandType && rowTarget === normalizedTarget;
  });
}

function appendQueTrigger() {
  ensureTaskSheetReadyFromQue_();

  const taskItems = sortTaskItemsForAppend_(getReservedTaskItemsReadyForQueueingFromQue());

  if (taskItems.length === 0) {
    console.log("【TASK→QUE】reserve/none のタスクはありません");
    return;
  }

  let appendedCount = 0;

  taskItems.forEach(taskItem => {
    const resolved = resolveQueCommandFromTask_(taskItem);

    if (!resolved) {
      console.log(`【TASK→QUE】対応するQUE命令が無いためスキップ: ${taskItem.key}`);
      return;
    }

    const targetDateStr = taskItem.target || null;
    const didEnqueue = enqueue_(resolved.commandType, targetDateStr, resolved.priority, taskItem.key, false, resolved.initialStatus);

    if (!didEnqueue) {
      if (hasActiveQueCommand_(resolved.commandType, targetDateStr)) {
        if (!markTaskPushed(taskItem.key, targetDateStr)) {
          markTaskPushedByKey(taskItem.key);
        }
      }
      return;
    }

    const marked = markTaskPushed(taskItem.key, targetDateStr) || markTaskPushedByKey(taskItem.key);

    if (marked) {
      appendedCount++;
    }
  });

  console.log(`【TASK→QUE】積み込み完了: ${appendedCount}件`);
}

function clearQueTrigger() {
  enqueueQueCleanupTrigger();
}

// 互換性維持: 既存トリガー設定が旧関数名を参照していても動作させる
function trigger_append_que() {
  appendQueTrigger();
}

// 互換性維持: 既存トリガー設定が旧関数名を参照していても動作させる
function trigger_clear_que() {
  clearQueTrigger();
}


// ============================
// QUEに命令を1件積む。
// 同じ「命令種別+対象日付」が既に未処理/処理中で存在すればスキップする。
//
// targetDateStr: 日付を持たない命令(検索API叩け等)は null または "" でよい
// ============================

const QUE_MAX_ROWS = 100;
const QUE_MANUAL_PAUSE_MARKER = "###";


// ============================
// QUEに命令を1件積む。
// 同じ「命令種別+対象日付」が既に未処理/処理中で存在すればスキップする。
//
// ■QUE整理によるブロック
// 「QUE整理」自身以外の命令は、QUEに「QUE整理」が未処理/処理中で
// 存在する間、一切積めない(スキップされる)。
//
// ■100行上限の制御
// ・既に100行あり、101行目を追加しようとする場合は、追加を見送る
//   (スキップする)。行の削除は行わない(削除はQUE整理だけが行う)。
//
// targetDateStr: 日付を持たない命令(検索API叩け等)は null または "" でよい
//
// source: 「どこから積んだか」を表す文字列(E列に記録される)。
//   例: "enqueueFetchApiTrigger", "processCreateDailySheetCommand_",
//       "processUpdatePvSheetCommand_", "enqueuePvFetchSheetTrigger",
//       "dispatchQueCommand_(自己再登板)" など。
//   どこから積まれたQUEなのかを後から追えるようにするためのもの。
//
// allowDuplicate: trueを渡すと、重複チェックをスキップして必ず積む。
//   用途: 自分自身(処理中の命令)が、続きのバッチとして自分自身を
//   再度積みたい場合(例: PV取得実行が、未処理を規定件数処理した後、
//   まだ残っていれば「PV取得実行」を再度積む)。通常の重複チェックだと
//   実行中の自分自身が「処理中」として既に存在するため、誤って
//   重複扱いされてスキップされてしまう。これを避けるためのフラグ。
//   省略時はfalse(通常通り重複チェックする)。
//
// initialStatus: 省略時は「未処理」。「検索ブロック」だけは
//   QUE_CONFIG.STATUS.WAITING(待機)を渡して、未処理を経由せず
//   最初から待機状態で積む。
// ============================

function enqueue_(commandType, targetDateStr, priority, source, allowDuplicate, initialStatus) {
  const lock = LockService.getScriptLock();

  if (!lock.tryLock(30000)) {
    console.log(`【QUE】ロック取得失敗のため積み込みスキップ: ${commandType} / ${targetDateStr || ""}`);
    return false;
  }

  try {
    const sheet = getOrCreateQueSheet_();

    if (isQueManualPauseActive_(sheet)) {
      console.log(`【QUE】手動停止マーカー(${QUE_MANUAL_PAUSE_MARKER})検知のため積み込みスキップ: ${commandType} / ${targetDateStr || ""}`);
      return false;
    }

    const normalizedDateStr = targetDateStr ? normalizeDateString_(targetDateStr) : "";
    const sourceLabel = source || "(不明)";
    const status = initialStatus || QUE_CONFIG.STATUS.PENDING;

    if (commandType !== QUE_CONFIG.COMMAND.CLEANUP && isQueCleanupActive_(sheet)) {
      console.log(`【QUE】QUE整理が進行中のためスキップ: ${commandType} / ${normalizedDateStr}`);
      return false;
    }

    if (!allowDuplicate && isDuplicateInQue_(sheet, commandType, normalizedDateStr)) {
      console.log(`【QUE】重複のためスキップ: ${commandType} / ${normalizedDateStr}`);
      return false;
    }

    compactQueRows_(sheet);

    if (!hasRoom_(sheet)) {
      console.log(`【QUE】上限(${QUE_MAX_ROWS}行)に達しているため追加をスキップ: ${commandType} / ${normalizedDateStr}`);
      return false;
    }

    const now = Utilities.formatDate(new Date(), CONFIG.TIMEZONE, "yyyy-MM-dd HH:mm:ss");
    const appendRow = getQueAppendRow_(sheet);
    const queId = generateUniqueQueId_(sheet);

    const appendRange = sheet.getRange(appendRow, 1, 1, 10);
    appendRange.setNumberFormat("@");
    appendRange.setValues([[
      queId,
      commandType,
      normalizedDateStr,
      priority,
      sourceLabel, // 積み元
      status,
      now,  // 作成日時
      "",   // 処理開始日時(まだ処理されていないので空欄)
      "",   // 処理終了日時(同上)
      ""    // 監視メッセージ
    ]]);

    console.log(`【QUE】積みました: ${commandType} / ${normalizedDateStr} / ID:${queId} / 優先度${priority} / 積み元:${sourceLabel} / ステータス:${status}`);
    return true;
  } finally {
    lock.releaseLock();
  }
}


// ============================
// QUEに「QUE整理」が未処理または処理中で存在するか判定する。
// 存在する間は、他の命令の積み込みが全てブロックされる。
// ============================

function isQueCleanupActive_(sheet) {
  const lastRow = sheet.getLastRow();

  if (lastRow < 2) return false;

  const values = sheet.getRange(2, 1, lastRow - 1, 6).getDisplayValues(); // ID,命令種別,対象日付,優先度,積み元,ステータス

  return values.some(row => {
    const command = row[1];
    const status = row[5];

    return command === QUE_CONFIG.COMMAND.CLEANUP &&
      (status === QUE_CONFIG.STATUS.PENDING || status === QUE_CONFIG.STATUS.IN_PROGRESS);
  });
}


// ============================
// データ行数が上限(QUE_MAX_ROWS)未満かどうかだけを判定する。
// 削除は一切行わない(削除はQUE整理だけの仕事)。
// ============================

function getQueDataRows_(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  const values = sheet.getRange(2, 2, lastRow - 1, 9).getDisplayValues(); // B列〜J列
  return values.filter(row => row.some(cell => String(cell).trim() !== ""));
}

function compactQueRows_(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 3) return;

  const values = sheet.getRange(2, 1, lastRow - 1, 10).getValues();
  const compacted = values.filter(row => row.some(cell => String(cell).trim() !== ""));

  if (compacted.length === values.length) return;

  sheet.getRange(2, 1, compacted.length, 10).setValues(compacted);
  sheet.getRange(compacted.length + 2, 1, lastRow - compacted.length - 1, 10).clearContent();
}

function getQueAppendRow_(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return 2;

  const values = sheet.getRange(2, 2, lastRow - 1, 9).getDisplayValues(); // B列〜J列

  for (let idx = values.length - 1; idx >= 0; idx--) {
    if (values[idx].some(cell => String(cell).trim() !== "")) {
      return idx + 3; // 実データ行の最終行+1
    }
  }

  return 2;
}

function hasRoom_(sheet) {
  const dataRowCount = getQueDataRows_(sheet).length;

  return dataRowCount < QUE_MAX_ROWS;
}

function isQueManualPauseActive_(sheet) {
  const lastRow = sheet.getLastRow();

  if (lastRow < 2) return false;

  const ids = sheet.getRange(2, 1, lastRow - 1, 1).getDisplayValues();

  return ids.some(row => String(row[0] || "").indexOf(QUE_MANUAL_PAUSE_MARKER) !== -1);
}


// ============================
// 同じ「命令種別+対象日付」が、未処理または処理中で既に存在するか判定する
//
// ★getValues()ではなくgetDisplayValues()を使い、日付は normalizeDateString_
// で正規化してから比較する。日付列がシート上でDateオブジェクトとして
// 自動変換されてしまっていても(文字列と型不一致で常にfalseになる事故を
// 防ぐため)、文字列同士の比較に統一する。
// ============================

function isDuplicateInQue_(sheet, commandType, normalizedDateStr) {
  const lastRow = sheet.getLastRow();

  if (lastRow < 2) return false;

  const values = sheet.getRange(2, 1, lastRow - 1, 6).getDisplayValues(); // ID,命令種別,対象日付,優先度,積み元,ステータス

  return values.some(row => {
    const rowCommand = row[1];
    const rowDate = row[2] ? normalizeDateString_(row[2]) : "";
    const rowStatus = row[5];

    const isActiveStatus = (
      rowStatus === QUE_CONFIG.STATUS.PENDING ||
      rowStatus === QUE_CONFIG.STATUS.IN_PROGRESS
    );

    return isActiveStatus && rowCommand === commandType && rowDate === normalizedDateStr;
  });
}


// ============================
// 「日付シート作成」の未処理行を、対象日付の降順(新しい日付が先)で
// 並べ替え、優先度を20,21,22...と採番し直す。
// 1分トリガーが、次の1件を選ぶ直前に毎回呼ぶ。
// ============================

function renumberDateSheetCreationPriorities_(sheet) {
  const lastRow = sheet.getLastRow();

  if (lastRow < 2) return;

  const values = sheet.getRange(2, 1, lastRow - 1, 6).getDisplayValues(); // ID,命令種別,対象日付,優先度,積み元,ステータス

  const targets = [];

  values.forEach((row, idx) => {
    const command = row[1];
    const status = row[5];

    if (command === QUE_CONFIG.COMMAND.CREATE_DAILY_SHEET && status === QUE_CONFIG.STATUS.PENDING) {
      targets.push({
        sheetRow: idx + 2, // ヘッダー分(+1)と0始まり分(+1)の補正
        dateStr: row[2] ? normalizeDateString_(row[2]) : ""
      });
    }
  });

  if (targets.length === 0) return;

  // yyyy-MM-dd 文字列同士の比較でそのまま正しく降順ソートできる(年またぎも対応)
  targets.sort((a, b) => b.dateStr.localeCompare(a.dateStr));

  targets.forEach((t, i) => {
    const priority = QUE_CONFIG.PRIORITY.CREATE_DAILY_SHEET_BASE + i; // 20, 21, 22...
    sheet.getRange(t.sheetRow, 4).setValue(priority); // D列(優先度)
  });
}


// ============================
// 未処理の中から、シート上の並び順で最初(一番上)のものを1件選ぶ。
// 優先度による選び方は一旦やめ、QUEシートの並び順通りに処理する。
// 見つからなければ null。
//
// ★getDisplayValues()を使い、対象日付は normalizeDateString_ で
// 正規化してから返す。ここでDateオブジェクトのまま返してしまうと、
// 後続の各命令処理(targetDateStr.substring(0,4)等)が例外で落ち、
// ステータスが「処理中」のまま止まる原因になるため。
// ============================

// ============================
// 未処理の中から、次に処理する1件を選ぶ。
//
// ■優先順位のルール
// 1. 「QUE整理」がシート上のどこであれ「処理中」なら → null を返す
//    (QUE整理が終わるまで、他の一切の命令を選ばない)
// 2. 「QUE整理」がシート上のどこであれ「未処理」なら → 位置に関わらず
//    最優先でそれを選ぶ
// 3. どちらも無ければ、通常通りシートの並び順(上から)で「未処理」を
//    探す。ただし「待機」ステータスの行は無視して読み飛ばす
//    (検索ブロックなど。通常の処理対象にはならない)
// ============================

function pickNextQueItem_(sheet) {
  const lastRow = sheet.getLastRow();

  if (lastRow < 2) return null;

  const values = sheet.getRange(2, 1, lastRow - 1, 6).getDisplayValues(); // ID,命令種別,対象日付,優先度,積み元,ステータス

  // 1. QUE整理が処理中なら、他の一切を選ばない
  const cleanupInProgress = values.some(row => (
    row[1] === QUE_CONFIG.COMMAND.CLEANUP && row[5] === QUE_CONFIG.STATUS.IN_PROGRESS
  ));

  if (cleanupInProgress) return null;

  // 2. QUE整理が未処理なら、位置に関わらず最優先で選ぶ
  for (let idx = 0; idx < values.length; idx++) {
    const row = values[idx];

    if (row[1] === QUE_CONFIG.COMMAND.CLEANUP && row[5] === QUE_CONFIG.STATUS.PENDING) {
      return {
        sheetRow: idx + 2,
        queId: row[0] || null,
        commandType: row[1],
        targetDateStr: row[2] ? normalizeDateString_(row[2]) : "",
        priority: Number(row[3]),
        source: String(row[4] || "").trim()
      };
    }
  }

  // 3. 通常通り、シートの並び順で「未処理」を探す。「待機」は読み飛ばす
  for (let idx = 0; idx < values.length; idx++) {
    const row = values[idx];
    const status = row[5];

    if (status === QUE_CONFIG.STATUS.WAITING) continue; // 待機は無視
    if (status !== QUE_CONFIG.STATUS.PENDING) continue;

    return {
      sheetRow: idx + 2,
      queId: row[0] || null,
      commandType: row[1],
      targetDateStr: row[2] ? normalizeDateString_(row[2]) : "",
      priority: Number(row[3]),
      source: String(row[4] || "").trim()
    };
  }

  return null;
}


// ============================
// A列(ID)から、そのIDを持つ行番号を探す。
// dispatchQueCommand_の中でenqueue_が呼ばれ、QUE満杯で先頭行が削除
// されると、処理中だった行の番号がズレることがある。処理完了/失敗時に
// 正しい行を確実に更新するため、記憶していた行番号を鵜呑みにせず、
// IDでその場で探し直す。見つからなければnull。
// ============================

function findQueRowById_(sheet, queId) {
  if (!queId) return null;

  const lastRow = sheet.getLastRow();

  if (lastRow < 2) return null;

  const ids = sheet.getRange(2, 1, lastRow - 1, 1).getDisplayValues();

  for (let idx = 0; idx < ids.length; idx++) {
    if (ids[idx][0] === queId) {
      return idx + 2;
    }
  }

  return null;
}


// ============================
// 指定行を「処理中」にする
// ============================

function markQueItemInProgress_(sheet, sheetRow) {
  const nowDate = new Date();
  const now = Utilities.formatDate(nowDate, CONFIG.TIMEZONE, "yyyy-MM-dd HH:mm:ss");
  const createdAt = String(sheet.getRange(sheetRow, 7).getDisplayValue() || "").trim();

  let createdAtToWrite = createdAt;

  if (!createdAtToWrite) {
    createdAtToWrite = now;
  } else {
    const createdDate = new Date(createdAtToWrite);

    // 作成日時が不正、または開始時刻より未来なら処理開始時刻へ寄せる。
    if (isNaN(createdDate.getTime()) || createdDate.getTime() > nowDate.getTime()) {
      createdAtToWrite = now;
    }
  }

  // 「処理中」へ遷移する時は、終了日時を必ず空にして状態矛盾を防ぐ。
  sheet.getRange(sheetRow, 6, 1, 4).setValues([[
    QUE_CONFIG.STATUS.IN_PROGRESS,
    createdAtToWrite,
    now,
    ""
  ]]);
}


// ============================
// 指定行を「完了」にする
// ============================

function markQueItemDone_(sheet, sheetRow) {
  const now = Utilities.formatDate(new Date(), CONFIG.TIMEZONE, "yyyy-MM-dd HH:mm:ss");
  const createdAt = String(sheet.getRange(sheetRow, 7).getDisplayValue() || "").trim();
  const startedAt = String(sheet.getRange(sheetRow, 8).getDisplayValue() || "").trim();

  // 完了時はF〜Iを一括更新して、部分更新や表示遅延由来の不整合を避ける。
  sheet.getRange(sheetRow, 6, 1, 4).setValues([[
    QUE_CONFIG.STATUS.DONE,
    createdAt,
    startedAt,
    now
  ]]);

  // 念のため再読込して、反映されていなければ1回だけ再書き込みする。
  const verify = sheet.getRange(sheetRow, 6, 1, 4).getDisplayValues()[0];
  const verifyStatus = String(verify[0] || "").trim();
  const verifyFinishedAt = String(verify[3] || "").trim();

  if (verifyStatus !== QUE_CONFIG.STATUS.DONE || !verifyFinishedAt) {
    sheet.getRange(sheetRow, 6, 1, 4).setValues([[
      QUE_CONFIG.STATUS.DONE,
      createdAt,
      startedAt,
      now
    ]]);
    console.log(`【QUE】完了反映を再試行: row=${sheetRow}`);
  }
}


// ============================
// QUE行の整合性を補正する。
// - 「処理中」なのに処理終了日時(I列)が入っている行は「完了」に直す
// - 作成日時(G列) > 処理開始日時(H列) の逆転があれば、作成日時を開始日時へ補正
// ============================

// ============================
// 15分トリガー: 「検索API叩け」を積むだけ
// ============================

function enqueueFetchApiTrigger() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(QUE_CONFIG.SHEET_NAME);

  // ★このシート存在チェック・検索ブロック確認は読み取りだけなので、
  // ロックは取らない(enqueue_自体が内部で自分のロックを取る)。
  if (sheet && isSearchBlockActive_(sheet)) {
    console.log("【QUE】検索ブロックが存在するためスキップ(検索API積み込み)");
    return;
  }

  reserveTaskByKey_(TASK_TRIGGER_KEY.FETCH_SEARCH_API, "");
}


// ============================
// QUEに「検索ブロック」が存在するか判定する(通常は「待機」ステータス)。
// 存在する間は、次の検索API叩けを積まない。
// ============================

function isSearchBlockActive_(sheet) {
  const lastRow = sheet.getLastRow();

  if (lastRow < 2) return false;

  const values = sheet.getRange(2, 2, lastRow - 1, 1).getDisplayValues(); // B列(命令種別)のみ

  return values.some(row => row[0] === QUE_CONFIG.COMMAND.FETCH_API_BLOCK);
}


// ============================
// 1分トリガー: QUEを見て、未処理の先頭1件だけ処理する(ワーカー)
//
// ★注意: このQueManager.gs単体では、各命令の「実処理」はスタブ(未実装)。
// 実処理(検索APIを叩く/日付シートを作る/PV取得する等)は、
// 別ファイルで実装し、dispatchQueCommand_() から呼び出す形にする。
// ============================

function queWorkerTrigger() {
  // ①事前チェック(ロックなし): QUEシートが無ければ作って初回の検索API叩けを積む。
  // enqueue_は自分でロックを取るので、ここではまだメインのロックを取らない
  // (取った状態でenqueue_を呼ぶと、同一実行内で二重にロックを取ろうとする
  //  ことになり、GASのLockServiceが同一実行内で再入可能かどうか未確認のため
  //  安全側に倒して、この時点ではロックを持たない設計にしている)。
  {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const existingSheet = ss.getSheetByName(QUE_CONFIG.SHEET_NAME);

    if (!existingSheet) {
      getOrCreateQueSheet_();
      reserveTaskByKey_(TASK_TRIGGER_KEY.FETCH_SEARCH_API, "");
    }
  }

  // ② 準備フェーズ(ロックあり): 未処理を1件選び、IDを発番し、処理中にする
  let lock = LockService.getScriptLock();

  if (!lock.tryLock(30000)) {
    console.log("【QUE】ロック取得失敗のためスキップ(ワーカー)");
    return;
  }

  let sheet;
  let nextItem;

  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    sheet = ss.getSheetByName(QUE_CONFIG.SHEET_NAME);

    if (!sheet) {
      console.log("【QUE】QUEシートがまだ準備できていません(次回に期待)");
      return;
    }

    if (isQueManualPauseActive_(sheet)) {
      console.log(`【QUE】手動停止マーカー(${QUE_MANUAL_PAUSE_MARKER})検知のため処理開始をスキップ`);
      return;
    }

    // ★優先度による並べ替えは行わない。QUEシートの並び順(上から)で処理する。
    // (ただし「QUE整理」だけは位置に関わらず最優先。pickNextQueItem_参照)
    nextItem = pickNextQueItem_(sheet);

    if (!nextItem) {
      console.log("【QUE】未処理の命令はありません(またはQUE整理が処理中のため待機)");
      return;
    }

    // ★ここでIDを発番し、A列に書き込んでから、真っ先にログ出力する。
    // (積んだ時点(enqueue_)ではまだID欄は空欄。未処理を拾って処理を
    //  始めるこの瞬間に、初めてIDが振られる)
    if (!nextItem.queId) {
      const queId = generateUniqueQueId_(sheet);
      sheet.getRange(nextItem.sheetRow, 1).setValue(queId);
      nextItem.queId = queId;
    }

    console.log(`【QUE】ID: ${nextItem.queId}`);
    console.log(`【QUE】処理開始: ${nextItem.commandType} / ${nextItem.targetDateStr} (優先度${nextItem.priority})`);

    markQueItemInProgress_(sheet, nextItem.sheetRow);

  } finally {
    lock.releaseLock();
  }

  // ③ 実処理フェーズ(ロックなし): ここが重い処理(なろうAPI・かささぎアクセス・
  // シート書き換え等)。この間、他のenqueue系トリガーは普通にQUEへ書き込める。
  let dispatchError = null;

  try {
    dispatchQueCommand_(nextItem);
  } catch (err) {
    dispatchError = err;
  }

  // ④ 記録フェーズ(ロックあり): IDで行を探し直してから、完了/エラーを記録する。
  // ★dispatchQueCommand_の中でenqueue_が呼ばれ、他の行の増減が起きている
  // 可能性があるので、記憶していた行番号を鵜呑みにせずIDで探し直す。
  lock = LockService.getScriptLock();

  if (!lock.tryLock(30000)) {
    console.log(`【QUE】ロック取得失敗のため結果を記録できませんでした: ${nextItem.queId} / ${nextItem.commandType} / ${nextItem.targetDateStr}`);
    return;
  }

  try {
    if (!dispatchError) {
      const doneRow = findQueRowById_(sheet, nextItem.queId);

      if (doneRow) {
        markQueItemDone_(sheet, doneRow);
        console.log(`【QUE】処理完了: ${nextItem.queId} / ${nextItem.commandType} / ${nextItem.targetDateStr}`);
      } else {
        console.log(`【QUE】処理完了(だが行が見つからず更新できず): ${nextItem.queId} / ${nextItem.commandType} / ${nextItem.targetDateStr}`);
      }

      // TASKのQUEフラグを pushed → none に戻し、task=waitとtask_wait_timeをセット
      if (nextItem.source) {
        const updated = markTaskWaitAfterQue(nextItem.source, nextItem.targetDateStr);
        if (!updated) {
          console.log(`【TASK】完了後更新対象なし: key=${nextItem.source} / target=${nextItem.targetDateStr}`);
        }
      }
    } else {
      const now = Utilities.formatDate(new Date(), CONFIG.TIMEZONE, "yyyy-MM-dd HH:mm:ss");
      const errorRow = findQueRowById_(sheet, nextItem.queId);

      if (errorRow) {
        sheet.getRange(errorRow, 6).setValue(`エラー:${dispatchError.message}`); // F列(ステータス)
        sheet.getRange(errorRow, 9).setValue(now); // I列(処理終了日時)
      }

      console.log(`【QUE】処理失敗: ${nextItem.queId} / ${nextItem.commandType} / ${nextItem.targetDateStr} - ${dispatchError.stack || dispatchError}`);
    }
  } finally {
    lock.releaseLock();
  }
}


// ============================
// 「QUE整理」の実処理本体。
//
// 削除する対象:
// ・「処理中」のまま処理開始日時(H列)から10分以上経過した行
// ・「待機」のまま作成日時(G列)から10分以上経過した行(検索ブロックの期限切れ)
// ・「完了」/「エラー:〜」で、処理終了日時(I列)が空、または
//   処理終了日時から10分以上経過した行
//
// ★下(末尾)から上に向かって処理する。上から削除すると、削除の
// たびに後続の行番号がズレるため。
// ============================

const QUE_CLEANUP_THRESHOLD_MINUTES = 10;

/**
 * 「処理中」で10分未満のQUEが存在するかチェック。
 * QUE整理を実施すべきか判定に使う。
 * 
 * @returns {boolean} 「処理中」で10分未満のQUEが存在する場合 true
 */
function hasActiveInProgressQueItems_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(QUE_CONFIG.SHEET_NAME);

  if (!sheet) {
    return false;
  }

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    return false;
  }

  const values = sheet.getRange(2, 1, lastRow - 1, 10).getValues();
  const now = new Date();

  for (let idx = 0; idx < values.length; idx++) {
    const row = values[idx];
    const status = row[5]; // F列: ステータス

    if (status !== QUE_CONFIG.STATUS.IN_PROGRESS) {
      continue;
    }

    const startedAt = row[7]; // H列: 処理開始日時
    const elapsedMinutes = (now.getTime() - new Date(startedAt).getTime()) / (1000 * 60);

    if (elapsedMinutes < QUE_CLEANUP_THRESHOLD_MINUTES) {
      return true; // 10分未満のアクティブ「処理中」が存在
    }
  }

  return false; // 「処理中」は存在しない、またはすべて10分以上経過
}

function processQueCleanupCommand_() {
  // ★「処理中」で10分未満のQUEが存在する場合はスキップ
  if (hasActiveInProgressQueItems_()) {
    console.log("【QUE整理】処理中のQUEが存在するためQUE整理をスキップします");
    return;
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(QUE_CONFIG.SHEET_NAME);
  let deletedCount = 0;

  if (!sheet) {
    console.log("【QUE整理】QUEシートが見つからないためQUE削除はスキップします");
  } else {
    const lastRow = sheet.getLastRow();

    if (lastRow < 2) {
      console.log("【QUE整理】QUEデータ行がないためQUE削除はスキップします");
    } else {
      const values = sheet.getRange(2, 1, lastRow - 1, 10).getValues(); // ID,命令種別,対象日付,優先度,積み元,ステータス,作成日時,処理開始日時,処理終了日時,監視メッセージ
      const now = new Date();

      for (let idx = values.length - 1; idx >= 0; idx--) {
        const row = values[idx];
        const commandType = row[1];
        const status = row[5];

        // 「QUE整理」自身の行(今まさに処理中の自分)は絶対に消さない
        // ただし、過去に完了した「QUE整理」は10分経過後に削除してよい。
        if (commandType === QUE_CONFIG.COMMAND.CLEANUP && status === QUE_CONFIG.STATUS.IN_PROGRESS) continue;

        let shouldDelete = false;

        if (status === QUE_CONFIG.STATUS.IN_PROGRESS) {
          const startedAt = row[7];
          shouldDelete = isOlderThanMinutes_(startedAt, now, QUE_CLEANUP_THRESHOLD_MINUTES);

        } else if (status === QUE_CONFIG.STATUS.WAITING) {
          const createdAt = row[6];
          shouldDelete = isOlderThanMinutes_(createdAt, now, QUE_CLEANUP_THRESHOLD_MINUTES);

        } else if (status === QUE_CONFIG.STATUS.DONE || status.indexOf("エラー") === 0) {
          const finishedAt = row[8];

          if (!finishedAt) {
            shouldDelete = true; // 処理終了日時が空 → 削除対象
          } else {
            shouldDelete = isOlderThanMinutes_(finishedAt, now, QUE_CLEANUP_THRESHOLD_MINUTES);
          }
        }

        if (!shouldDelete) continue;

        const sheetRow = idx + 2;
        sheet.deleteRow(sheetRow);
        deletedCount++;
      }
    }
  }

  const clearedGuards = clearExpiredTaskGuardsFromQue();
  const clearedWaitTasks = clearExpiredWaitTasksFromQue();
  const resetTimedOutTasks = clearTimedOutQueuedTasksFromQue(QUE_CLEANUP_THRESHOLD_MINUTES);
  const dedupedTasks = dedupeReservedTasksByGroupAndTargetFromQue();
  const setCleanupWait = setTaskWaitForQue(TASK_TRIGGER_KEY.CLEAR_QUE);
  const clearedExpiredLocks = clearExpiredLocks(QUE_CLEANUP_THRESHOLD_MINUTES);

  console.log(`【QUE整理】完了: QUE削除${deletedCount}件 / TASK_GUARD解除${clearedGuards}件 / TASK_WAIT解除${clearedWaitTasks}件 / TASKタイムアウト解除${resetTimedOutTasks}件 / TASK重複整理${dedupedTasks}件 / Lock期限切れ削除${clearedExpiredLocks}件 / QUE整理WAIT設定=${setCleanupWait}`);
}


// ============================
// 日時セルの値(Dateオブジェクトまたは文字列)が、指定した分数より
// 古いかどうかを判定する。空欄/不正な値の場合はfalse(古いとはみなさない)。
// ============================

function isOlderThanMinutes_(dateValue, now, thresholdMinutes) {
  if (!dateValue) return false;

  const targetDate = (dateValue instanceof Date) ? dateValue : new Date(dateValue);

  if (isNaN(targetDate.getTime())) return false;

  const diffMinutes = (now.getTime() - targetDate.getTime()) / (1000 * 60);

  return diffMinutes >= thresholdMinutes;
}


// ============================
// 「QUE整理」積み込み専用トリガー(5分ごと)
//
// 既に未処理/処理中の「QUE整理」が存在する場合は、enqueue_の通常の
// 重複チェックによりスキップされる(多重登録されない)。
// ============================

function enqueueQueCleanupTrigger() {
  reserveTaskByKey_(TASK_TRIGGER_KEY.CLEAR_QUE, "");
}


// ============================
// QUE膠着監視トリガー(1時間ごと)
//
// QUEシートの一番古い行(2行目)の作成日時が、1時間以上前のままなら、
// QUE全体が止まっている(処理が進んでいない)ことを意味する。
// 通常なら、次々に処理されて2行目の中身は入れ替わり続けるはずなので、
// 1時間も同じ行が残っているのは異常事態。
//
// あえて例外を投げてこのトリガー自体を失敗させる。GAS側の
// 「トリガー失敗時に通知」設定を有効にしておけば、自動でメールが飛ぶ。
// ============================

const QUE_STUCK_THRESHOLD_MINUTES = 60;

function checkQueStuckTrigger() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(QUE_CONFIG.SHEET_NAME);

  if (!sheet) {
    console.log("【QUE膠着監視】QUEシートがまだ存在しません(正常)");
    return;
  }

  const lastRow = sheet.getLastRow();

  if (lastRow < 2) {
    console.log("【QUE膠着監視】データ行がありません(正常)");
    return;
  }

  const createdAt = sheet.getRange(2, 7).getValue(); // G列(作成日時)
  const createdAtDate = (createdAt instanceof Date) ? createdAt : new Date(createdAt);

  if (isNaN(createdAtDate.getTime())) {
    console.log("【QUE膠着監視】2行目の作成日時が読み取れません(スキップ)");
    return;
  }

  const now = new Date();
  const diffMinutes = (now.getTime() - createdAtDate.getTime()) / (1000 * 60);

  if (diffMinutes < QUE_STUCK_THRESHOLD_MINUTES) {
    console.log(`【QUE膠着監視】正常(2行目の作成から${Math.floor(diffMinutes)}分)`);
    return;
  }

  const message = `【QUE膠着監視】QUEの2行目が作成から${Math.floor(diffMinutes)}分経過しても処理されていません。QUE全体が止まっている可能性があります。`;

  console.log(message);
  throw new Error(message);
}
// ============================
// 命令種別に応じて実処理へ振り分ける
// ============================

function dispatchQueCommand_(item) {
  switch (item.commandType) {
    case QUE_CONFIG.COMMAND.CLEANUP:
      processQueCleanupCommand_();
      break;

    case QUE_CONFIG.COMMAND.FETCH_API:
      processFetchApiCommand_();
      break;

    case QUE_CONFIG.COMMAND.CREATE_DAILY_SHEET:
      processCreateDailySheetCommand_(item.targetDateStr);
      break;

    case QUE_CONFIG.COMMAND.UPDATE_SUMMARY:
      processUpdateSummaryCommand_(item.targetDateStr);
      break;

    case QUE_CONFIG.COMMAND.TEN_MINUTE:
      processTenMinuteCommand_(item.targetDateStr);
      break;

    case QUE_CONFIG.COMMAND.UPDATE_PV_SHEET:
      processUpdatePvSheetCommand_(item.targetDateStr);
      break;

    case QUE_CONFIG.COMMAND.FETCH_PV_SHEET: {
      const remainingCount = processFetchPvSheetCommand_(item.targetDateStr);

      if (remainingCount === -1) {
        console.log("【PV取得実行】UrlFetch上限超過のため即時終了。再enqueueしません。");
        break;
      }

      if (remainingCount > 0) {
        // 自分自身(現在「処理中」の行)がまだ存在するため、通常の重複チェックだと
        // スキップされてしまう。allowDuplicate=true で強制的に積む。
        enqueue_(QUE_CONFIG.COMMAND.FETCH_PV_SHEET, item.targetDateStr, QUE_CONFIG.PRIORITY.FETCH_PV_SHEET, "dispatchQueCommand_(自己再登板)", false);
      }

      break;
    }

    default:
      console.log(`【QUE】不明な命令種別: ${item.commandType}`);
  }
}