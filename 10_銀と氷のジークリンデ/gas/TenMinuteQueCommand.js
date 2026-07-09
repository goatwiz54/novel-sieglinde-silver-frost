/**********************************************************************
 * TenMinuteQueCommand.gs
 *
 * QUE命令「10分集計」の実処理。
 *
 * ■手動口との処理共有
 * ・実際の集計・書き込みロジックは TenMinuteUpdater.gs の
 *   updateTenMinuteColumn_(sheet, col) をそのまま呼び出す。
 *   (手動:「最新化」編集トリガー → installedOnEdit → updateTenMinuteColumn_
 *    QUE :10分集計命令          → processTenMinuteCommand_ → updateTenMinuteColumn_
 *   という形で、実処理本体を完全に共有する)
 *
 * ■列の決定ロジック
 * ・「10分集計」シートの2行目(日付表示 "MM/DD(曜)")を見て、
 *   対象日付(targetDateStr)と一致する列が既にあれば、その列を更新する。
 * ・一致する列が無ければ、空いている列(1行目・2行目とも空欄)を探して
 *   自動的にセットアップする。空きも無ければ、末尾に新しい列を追加する。
 **********************************************************************/


// ============================
// 「10分集計」の実処理本体
// ============================

function processTenMinuteCommand_(targetDateStr) {
  const year = targetDateStr.substring(0, 4);
  const month = targetDateStr.substring(5, 7);
  const fileKey = `${year}年${month}月`;

  const spreadsheet = findMonthlySpreadsheetIfExists_(fileKey);

  if (!spreadsheet) {
    console.log(`【10分集計】月別ファイルが見つかりません: ${fileKey}`);
    return;
  }

  const sheet = spreadsheet.getSheetByName(CONFIG.TEN_MINUTE_SHEET_NAME);

  if (!sheet) {
    console.log(`【10分集計】シートが見つかりません: ${CONFIG.TEN_MINUTE_SHEET_NAME}`);
    return;
  }

  const displayLabel = buildTenMinuteDateLabel_(targetDateStr);
  const targetCol = findOrPrepareTenMinuteColumn_(sheet, displayLabel);

  updateTenMinuteColumn_(sheet, targetCol);

  console.log(`【10分集計】完了: ${targetDateStr} (列${targetCol})`);
}


// ============================
// yyyy-MM-dd から、10分集計シートの2行目表示形式 "MM/DD(曜)" を作る
// ============================

function buildTenMinuteDateLabel_(dateStr) {
  const dateObj = new Date(`${dateStr}T00:00:00`);

  const mm = Utilities.formatDate(dateObj, CONFIG.TIMEZONE, "MM");
  const dd = Utilities.formatDate(dateObj, CONFIG.TIMEZONE, "dd");

  const isoDow = parseInt(Utilities.formatDate(dateObj, CONFIG.TIMEZONE, "u"), 10);
  const weekdayMap = ["月", "火", "水", "木", "金", "土", "日"];
  const weekday = weekdayMap[isoDow - 1];

  return `${mm}/${dd}(${weekday})`;
}


// ============================
// 対象日付の表示ラベルに一致する列を探す。
// 無ければ空いている列を探して日付をセットする。空きも無ければ末尾に追加する。
// ============================

function findOrPrepareTenMinuteColumn_(sheet, displayLabel) {
  const lastColumn = Math.max(sheet.getLastColumn(), 1);

  // 既に同じ日付の列があれば、それを使う
  for (let col = 2; col <= lastColumn; col++) {
    const existingLabel = sheet.getRange(TEN_MINUTE_DATE_ROW, col).getDisplayValue();

    if (existingLabel === displayLabel) {
      return col;
    }
  }

  // 空いている列(1行目・2行目とも空欄)を探す
  for (let col = 2; col <= lastColumn; col++) {
    const rowOne = sheet.getRange(1, col).getDisplayValue();
    const rowTwo = sheet.getRange(TEN_MINUTE_DATE_ROW, col).getDisplayValue();

    if (rowOne === "" && rowTwo === "") {
      sheet.getRange(TEN_MINUTE_DATE_ROW, col).setValue(displayLabel);
      return col;
    }
  }

  // 空きが無ければ末尾に新しい列を追加する
  const newCol = lastColumn + 1;
  sheet.getRange(TEN_MINUTE_DATE_ROW, newCol).setValue(displayLabel);

  return newCol;
}