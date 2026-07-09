/**********************************************************************
 * TenMinuteUpdater.gs
 *
 * 10分集計シートの更新処理。
 *
 * ■シートレイアウト
 *   1行目: 各列のトリガーラベル("最新化" / "✅" / "💀")。空白列は無視。
 *   2行目: 対象日付(例: "07/06(月)")。年は含まない。
 *   3行目〜146行目: A列=00:00〜23:50の10分刻み時刻(固定・書き換えない)。
 *                    B列以降=各日付列の投稿数。
 *
 * ■トリガー
 *   ★注意: onEdit(e)というシンプルトリガーの自動認識には頼らない。
 *   シンプルトリガーはDriveApp等の認可が必要なサービスを呼べないため、
 *   updateTenMinuteColumn_内のDriveApp呼び出し(月別ファイル検索)が
 *   権限エラーで静かに失敗し、シートが更新されない不具合が起きる。
 *
 *   代わりに installedOnEdit(e) という名前にし、インストール型
 *   トリガー(ScriptApp.newTrigger)として登録する。これはフル権限で
 *   動作するため、DriveApp・UrlFetchApp等を問題なく呼び出せる。
 *
 *   トリガーの登録は、Common.gs の getOrCreateMonthlySpreadsheet が
 *   月別ファイルを開く/作成するたびに ensureTenMinuteEditTrigger_() を
 *   呼ぶことで自動的に行われる(重複作成防止つき)。
 *   もし手動でセットアップしたい場合は、対象のスプレッドシートを開いた
 *   状態でGASエディタから setupTenMinuteEditTrigger_() を1回実行する
 *   (初回は認可ダイアログが出るので許可すること)。
 *
 *   1行目のセルに "最新化" と入力された時だけ発火する。
 *
 * ■年の決定
 *   2行目の日付には年が無いため、対象月と実行時点の月を比較して判定する。
 *     対象月 ≦ 実行月 → 実行年と同じ
 *     対象月 >  実行月 → 実行年の前年(12月→1月の年またぎ)
 *
 * ■完了マーク
 *   検知直後(処理開始時)      → 1行目のセルを "◆" に上書き(処理中表示)
 *   正常に更新できた           → 1行目のセルを "✅" に上書き
 *   対象シートが無い等(失敗)  → 1行目のセルを "💀" に上書き
 **********************************************************************/


const TEN_MINUTE_TRIGGER_LABEL = "最新化";
const TEN_MINUTE_PROCESSING_MARK = "◆";
const TEN_MINUTE_SUCCESS_MARK = "✅";
const TEN_MINUTE_FAIL_MARK = "💀";
const TEN_MINUTE_HEATMAP_SHEET_NAME = "10分集計ヒートマップ";
const TEN_MINUTE_HEATMAP_RETRY_MARK = "未処理";

const TEN_MINUTE_DATE_ROW = 2;
const TEN_MINUTE_DATA_START_ROW = 3; // 00:00の行
const TEN_MINUTE_DATA_ROWS = 144;    // 00:00〜23:50


// ============================
// 10分集計シート編集ハンドラ
//
// ★重要: この関数は「onEdit」という名前にしない。
// 「onEdit」という名前の関数はGASに自動認識される「シンプルトリガー」に
// なるが、シンプルトリガーはDriveApp等の認可が必要なサービスを呼べない
// (updateTenMinuteColumn_内でDriveAppを使っているため、シンプルトリガー
//  だと権限エラーで静かに失敗し、シートが更新されない)。
// 代わりに setupTenMinuteEditTrigger_() でインストール型トリガーとして
// 登録することで、フル権限で動作させる。
// ============================

function installedOnEdit(e) {
  if (!e) return;

  const range = e.range;
  const sheet = range.getSheet();
  const sheetName = sheet.getName();

  if (sheetName === CONFIG.TEN_MINUTE_SHEET_NAME) {
    handleTenMinuteSheetEdit_(e);
    return;
  }

  if (sheetName === TEN_MINUTE_HEATMAP_SHEET_NAME) {
    handleTenMinuteHeatmapSheetEdit_(e);
  }
}

function handleTenMinuteSheetEdit_(e) {
  const range = e.range;
  const sheet = range.getSheet();

  if (range.getRow() !== 1) return;

  const value = range.getValue();
  const checkboxMode = isCheckboxCell_(range);

  if (!checkboxMode && value !== TEN_MINUTE_TRIGGER_LABEL) return;
  if (checkboxMode && value !== true) return;

  // 検知した瞬間に「処理中」であることが分かるよう即座に上書きする
  if (!checkboxMode) {
    range.setValue(TEN_MINUTE_PROCESSING_MARK);
  }
  SpreadsheetApp.flush();

  try {
    updateTenMinuteColumn_(sheet, range.getColumn());
  } catch (err) {
    // 想定外の例外もセルに直接書き込む(ログだけだと気づきにくいため)
    console.log(`【10分集計】想定外のエラー: ${err.stack || err}`);
    if (checkboxMode) {
      sheet.getRange(1, range.getColumn()).setValue(false);
    } else {
      sheet.getRange(1, range.getColumn()).setValue(`💀:${err.toString()}`);
    }
  }
}

function handleTenMinuteHeatmapSheetEdit_(e) {
  const range = e.range;
  const sheet = range.getSheet();

  if (range.getColumn() !== 1) return;
  if (range.getRow() === 1) return;

  const value = range.getValue();

  if (value !== TEN_MINUTE_HEATMAP_RETRY_MARK) return;

  range.setValue(TEN_MINUTE_PROCESSING_MARK);
  SpreadsheetApp.flush();

  try {
    const row = range.getRow();
    const dateCellValue = sheet.getRange(row, 2).getDisplayValue();
    const normalizedDateStr = resolveSheetDateStr_(dateCellValue);

    if (!normalizedDateStr) {
      sheet.getRange(row, 1).setValue(`${TEN_MINUTE_FAIL_MARK}:日付が読み取れません(値="${dateCellValue}")`);
      return;
    }

    updateTenMinuteHeatmapRowByDate_(sheet.getParent(), normalizedDateStr, row);

    sheet.getRange(row, 1).setValue(TEN_MINUTE_SUCCESS_MARK);
  } catch (err) {
    console.log(`【10分集計ヒートマップ】想定外のエラー: ${err.stack || err}`);
    range.setValue(`${TEN_MINUTE_FAIL_MARK}:${err.toString()}`);
  }
}

function isCheckboxCell_(range) {
  const rule = range.getDataValidation();

  if (!rule) {
    return false;
  }

  return rule.getCriteriaType() === SpreadsheetApp.DataValidationCriteria.CHECKBOX;
}


// ============================
// この月別ファイルに、10分集計onEdit用のインストール型トリガーが
// まだ無ければ作成する(重複作成防止つき)。
// 時間主導トリガー(フル権限)から呼ばれる前提。
// ============================

function ensureTenMinuteEditTrigger_(spreadsheetId) {
  const alreadyExists = ScriptApp.getProjectTriggers().some(trigger =>
    trigger.getHandlerFunction() === "installedOnEdit" &&
    trigger.getTriggerSourceId() === spreadsheetId
  );

  if (alreadyExists) return;

  ScriptApp.newTrigger("installedOnEdit")
    .forSpreadsheet(spreadsheetId)
    .onEdit()
    .create();

  console.log(`【トリガー設定】10分集計onEditトリガーを作成しました: ${spreadsheetId}`);
}


// ============================
// 手動セットアップ用(初回のみ、GASエディタから直接実行する)
// アクティブなスプレッドシート(このファイルを開いた状態)に対して
// インストール型トリガーを作成する。認可ダイアログが出るので許可すること。
// ============================

function setupTenMinuteEditTrigger_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ensureTenMinuteEditTrigger_(ss.getId());
}


// ============================
// デバッグ用: 指定した月のファイルに対して、確実にonEditトリガーを
// (再)設定する。手動実行してIDとトリガー登録状況を確認するためのもの。
// ============================

function debugEnsureTriggerForMonth() {
  const fileKey = "2026年07月"; // ★確認したい月別ファイルに合わせて変更

  const spreadsheet = getOrCreateMonthlySpreadsheet(fileKey);

  console.log(`対象ファイルID: ${spreadsheet.getId()}`);
  console.log(`対象ファイル名: ${spreadsheet.getName()}`);

  ensureTenMinuteEditTrigger_(spreadsheet.getId());
  ensureSummaryEditTrigger_(spreadsheet.getId());

  const triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(t => {
    if (t.getHandlerFunction() === "installedOnEdit") {
      console.log(`installedOnEditトリガー → 対象ID: ${t.getTriggerSourceId()}`);
    }
    if (t.getHandlerFunction() === "installedOnEditSummary") {
      console.log(`installedOnEditSummaryトリガー → 対象ID: ${t.getTriggerSourceId()}`);
    }
  });
}


// ============================
// 指定列を最新化する
// ============================

function updateTenMinuteColumn_(sheet, col) {
  const ss = sheet.getParent();
  const statusCell = sheet.getRange(1, col);
  const checkboxMode = isCheckboxCell_(statusCell);

  const dateCellValue = sheet.getRange(TEN_MINUTE_DATE_ROW, col).getDisplayValue();
  const sheetDateStr = resolveSheetDateStr_(dateCellValue);

  if (!sheetDateStr) {
    const errMsg = `日付解釈失敗:値="${dateCellValue}"`;
    console.log(`【10分集計】${errMsg}`);
    if (checkboxMode) {
      statusCell.setValue(false);
    } else {
      statusCell.setValue(`${TEN_MINUTE_FAIL_MARK}:${errMsg}`);
    }
    return;
  }

  const year = sheetDateStr.substring(0, 4);
  const month = sheetDateStr.substring(5, 7);

  const fileKey = `${year}年${month}月`;

  const monthlySpreadsheet = findMonthlySpreadsheetIfExists_(fileKey);

  if (!monthlySpreadsheet) {
    const errMsg = `月別ファイルなし:${fileKey}`;
    console.log(`【10分集計】${errMsg}`);
    if (checkboxMode) {
      statusCell.setValue(false);
    } else {
      statusCell.setValue(`${TEN_MINUTE_FAIL_MARK}:${errMsg}`);
    }
    return;
  }

  const sourceSheet = findExistingDailySheet_(monthlySpreadsheet, new Date(`${sheetDateStr}T00:00:00`));

  if (!sourceSheet) {
    const errMsg = `日別シートなし:${sheetDateStr}`;
    console.log(`【10分集計】${errMsg}`);
    if (checkboxMode) {
      statusCell.setValue(false);
    } else {
      statusCell.setValue(`${TEN_MINUTE_FAIL_MARK}:${errMsg}`);
    }
    return;
  }

  const countByBucket = buildTenMinuteBucketCounts_(sourceSheet);

  writeTenMinuteColumnValues_(sheet, col, countByBucket);
  applyTenMinuteHeatmapForColumn_(sheet, col);
  updateTenMinuteHeatmapRowByDate_(ss, sheetDateStr);

  if (checkboxMode) {
    statusCell.setValue(false);
  } else {
    statusCell.setValue(TEN_MINUTE_SUCCESS_MARK);
  }

  ss.toast(`10分集計を更新しました: ${sheetDateStr} (列${col})`);
}

function updateTenMinuteHeatmapRowByDate_(spreadsheet, normalizedDateStr, preferredRow) {
  const tenMinuteSheet = spreadsheet.getSheetByName(CONFIG.TEN_MINUTE_SHEET_NAME);

  if (!tenMinuteSheet) {
    throw new Error(`10分集計シートが見つかりません: ${CONFIG.TEN_MINUTE_SHEET_NAME}`);
  }

  const sourceCol = findTenMinuteColumnByDate_(tenMinuteSheet, normalizedDateStr);

  if (!sourceCol) {
    throw new Error(`10分集計の対象列が見つかりません: ${normalizedDateStr}`);
  }

  const tenMinuteCounts = buildTenMinuteCountsFromTenMinuteColumn_(tenMinuteSheet, sourceCol);
  const heatmapSheet = getOrCreateTenMinuteHeatmapSheet_(spreadsheet);
  const targetRow = findOrCreateTenMinuteHeatmapRow_(heatmapSheet, normalizedDateStr, preferredRow);

  writeTenMinuteHeatmapRow_(heatmapSheet, targetRow, tenMinuteCounts);
}

function getOrCreateTenMinuteHeatmapSheet_(spreadsheet) {
  let sheet = spreadsheet.getSheetByName(TEN_MINUTE_HEATMAP_SHEET_NAME);

  if (!sheet) {
    sheet = spreadsheet.insertSheet(TEN_MINUTE_HEATMAP_SHEET_NAME);
  }

  return sheet;
}

function findTenMinuteColumnByDate_(tenMinuteSheet, normalizedDateStr) {
  const lastColumn = Math.max(tenMinuteSheet.getLastColumn(), 2);

  for (let col = 2; col <= lastColumn; col++) {
    const dateLabel = tenMinuteSheet.getRange(TEN_MINUTE_DATE_ROW, col).getDisplayValue();

    if (!dateLabel) {
      continue;
    }

    const colDateStr = resolveSheetDateStr_(dateLabel);

    if (colDateStr === normalizedDateStr) {
      return col;
    }
  }

  return null;
}

function buildTenMinuteCountsFromTenMinuteColumn_(tenMinuteSheet, col) {
  const values = tenMinuteSheet
    .getRange(TEN_MINUTE_DATA_START_ROW, col, TEN_MINUTE_DATA_ROWS, 1)
    .getDisplayValues();

  const tenMinuteCounts = new Array(TEN_MINUTE_DATA_ROWS).fill(0);

  for (let i = 0; i < TEN_MINUTE_DATA_ROWS; i++) {
    const n = Number(values[i][0]);
    tenMinuteCounts[i] = isNaN(n) ? 0 : n;
  }

  return tenMinuteCounts;
}

function findOrCreateTenMinuteHeatmapRow_(heatmapSheet, normalizedDateStr, preferredRow) {
  const displayLabel = buildTenMinuteDateLabel_(normalizedDateStr);

  if (preferredRow && preferredRow >= 2) {
    heatmapSheet.getRange(preferredRow, 2).setValue(displayLabel);
    return preferredRow;
  }

  const lastRow = heatmapSheet.getLastRow();

  if (lastRow >= 2) {
    const labels = heatmapSheet.getRange(2, 2, lastRow - 1, 1).getDisplayValues();

    for (let i = 0; i < labels.length; i++) {
      const existingDateStr = resolveSheetDateStr_(labels[i][0]);

      if (existingDateStr === normalizedDateStr) {
        return i + 2;
      }
    }
  }

  const newRow = Math.max(lastRow + 1, 2);
  heatmapSheet.getRange(newRow, 2).setValue(displayLabel);

  return newRow;
}

function writeTenMinuteHeatmapRow_(heatmapSheet, row, tenMinuteCounts) {
  const maxVal = tenMinuteCounts.reduce((m, v) => Math.max(m, Number(v) || 0), 0);
  const colors = tenMinuteCounts.map(value => {
    const n = Number(value) || 0;

    if (n <= 0 || maxVal <= 0) {
      return tenMinuteHeatmapColorForStep_(0);
    }

    let step = Math.ceil((n / maxVal) * 24);

    if (step < 1) step = 1;
    if (step > 24) step = 24;

    return tenMinuteHeatmapColorForStep_(step);
  });

  const targetRange = heatmapSheet.getRange(row, 3, 1, TEN_MINUTE_DATA_ROWS);

  // ヒートマップシートは背景色だけを表示する。
  targetRange.clearContent();
  targetRange.setBackgrounds([colors]);
  targetRange.setHorizontalAlignment("center");
  targetRange.setFontColor("#000000");
  targetRange.setFontWeight("bold");
}


// ============================
// 2行目の日付表記("07/06(月)"等)から yyyy-MM-dd を決定する
// 年は実行時点の年月と比較して補完する(月またぎ=年またぎ考慮)
// ============================

function resolveSheetDateStr_(rawValue) {
  const match = String(rawValue).trim().match(/(\d{1,2})\D*\/\D*(\d{1,2})/);

  if (!match) return null;

  const targetMonth = parseInt(match[1], 10);
  const targetDay = parseInt(match[2], 10);

  if (targetMonth < 1 || targetMonth > 12 || targetDay < 1 || targetDay > 31) return null;

  const now = new Date();
  const execYear = parseInt(Utilities.formatDate(now, CONFIG.TIMEZONE, "yyyy"), 10);
  const execMonth = parseInt(Utilities.formatDate(now, CONFIG.TIMEZONE, "MM"), 10);

  const targetYear = (targetMonth > execMonth) ? (execYear - 1) : execYear;

  const mm = String(targetMonth).padStart(2, "0");
  const dd = String(targetDay).padStart(2, "0");

  return `${targetYear}-${mm}-${dd}`;
}


// ============================
// 日別シートのB列(時刻)・C列(投稿数)を読み込み、
// 10分単位に「切り捨て」て集計(合算)する
// 例: 13:07, 13:09 → 13:00 の枠に合算
// ============================

function buildTenMinuteBucketCounts_(sourceSheet) {
  const countByBucket = {};

  const lastRow = sourceSheet.getLastRow();

  if (lastRow < 2) return countByBucket;

  const sourceValues = sourceSheet.getRange(2, 2, lastRow - 1, 2).getDisplayValues();

  sourceValues.forEach(row => {
    const timeRaw = row[0];
    const countRaw = row[1];

    if (timeRaw === "" || countRaw === "") return;

    const time = normalizeTimeString_(timeRaw);
    const count = Number(countRaw);

    if (isNaN(count)) return;

    const hour = parseInt(time.substring(0, 2), 10);
    const minute = parseInt(time.substring(3, 5), 10);

    const bucketMinute = Math.floor(minute / 10) * 10;
    const bucketIndex = hour * 6 + (bucketMinute / 10); // 0〜143

    countByBucket[bucketIndex] = (countByBucket[bucketIndex] || 0) + count;
  });

  return countByBucket;
}


// ============================
// 集計結果を対象列の3〜146行目に書き込む(A列の時刻順に対応)
// ============================

function writeTenMinuteColumnValues_(sheet, col, countByBucket) {
  const values = [];

  for (let i = 0; i < TEN_MINUTE_DATA_ROWS; i++) {
    values.push([countByBucket[i] || 0]);
  }

  sheet.getRange(TEN_MINUTE_DATA_START_ROW, col, TEN_MINUTE_DATA_ROWS, 1)
    .setNumberFormat("@")
    .setValues(values);
}

// ============================
// 10分集計の1日分(1列=144セル)に対してヒートマップを適用する。
// 0件は白、1件以上はその列内の最大値を基準に24段階で着色する。
// ============================

function applyTenMinuteHeatmapForColumn_(sheet, col) {
  const range = sheet.getRange(TEN_MINUTE_DATA_START_ROW, col, TEN_MINUTE_DATA_ROWS, 1);
  const values = range.getDisplayValues();

  let maxVal = 0;

  values.forEach(row => {
    const n = Number(row[0]);

    if (!isNaN(n) && n > maxVal) {
      maxVal = n;
    }
  });

  const backgrounds = values.map(row => {
    const n = Number(row[0]);

    if (isNaN(n) || n <= 0 || maxVal <= 0) {
      return [tenMinuteHeatmapColorForStep_(0)];
    }

    let step = Math.ceil((n / maxVal) * 24);

    if (step < 1) step = 1;
    if (step > 24) step = 24;

    return [tenMinuteHeatmapColorForStep_(step)];
  });

  range.setBackgrounds(backgrounds);
  range.setFontColor("#000000");
  range.setFontWeight("bold");
  range.setHorizontalAlignment("center");
}

function tenMinuteHeatmapColorForStep_(step) {
  if (CONFIG.HEATMAP_STYLE === "rainbow") {
    return tenMinuteRainbowColorForStep_(step);
  }

  return TEN_MINUTE_HEATMAP_COLORS_BLUE[step];
}

const TEN_MINUTE_HEATMAP_COLORS_BLUE = [
  "#FFFFFF", "#EBF5FF", "#DCEEFF", "#CDE6FF", "#BEDCFF", "#AAD2FF",
  "#96C6FA", "#82B9F5", "#6EAAF0", "#5FA0EB", "#5096E6", "#4691E1",
  "#3C8CDC", "#3787D7", "#3282D2", "#2D7DCD", "#2878C8", "#2373C3",
  "#1E6EBE", "#1969B9", "#1464B4", "#0F5FAF", "#0A5AAA", "#0555A5", "#0050A0"
];

function tenMinuteRainbowColorForStep_(step) {
  if (step <= 0) return "#FFFFFF";

  const t = (step - 1) / 23;
  const hue = 240 - t * 240;

  return tenMinuteHslToHex_(hue, 85, 55);
}

function tenMinuteHslToHex_(h, s, l) {
  const sNorm = s / 100;
  const lNorm = l / 100;

  const c = (1 - Math.abs(2 * lNorm - 1)) * sNorm;
  const hPrime = h / 60;
  const x = c * (1 - Math.abs((hPrime % 2) - 1));
  const m = lNorm - c / 2;

  let r1 = 0;
  let g1 = 0;
  let b1 = 0;

  if (hPrime >= 0 && hPrime < 1) {
    r1 = c; g1 = x; b1 = 0;
  } else if (hPrime >= 1 && hPrime < 2) {
    r1 = x; g1 = c; b1 = 0;
  } else if (hPrime >= 2 && hPrime < 3) {
    r1 = 0; g1 = c; b1 = x;
  } else if (hPrime >= 3 && hPrime < 4) {
    r1 = 0; g1 = x; b1 = c;
  } else if (hPrime >= 4 && hPrime < 5) {
    r1 = x; g1 = 0; b1 = c;
  } else {
    r1 = c; g1 = 0; b1 = x;
  }

  const toHex = (v) => {
    const n = Math.round((v + m) * 255);
    return n.toString(16).padStart(2, "0").toUpperCase();
  };

  return `#${toHex(r1)}${toHex(g1)}${toHex(b1)}`;
}