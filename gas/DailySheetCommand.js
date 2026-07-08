/**********************************************************************
 * DailySheetCommand.gs
 *
 * QUE命令「日付シート作成」の実処理。
 *
 * ■やること
 * ・「検索結果」シートから、対象日付(targetDateStr)に一致する行を読み出す
 * ・時刻ごとにグルーピングし、既存の日別シート(親子構造)とマージする
 *   (このマージ・書き込みロジックは DailySheetIO.gs / Common.gs の
 *    既存関数をそのまま使う:
 *    getOrCreateMonthlySpreadsheet / findExistingDailySheet_ /
 *    readExistingDailySheet_ / calculatePrevPostTimes_ /
 *    buildDailyRowsAndHourlyCounts_ / rewriteDailySheetSafely_)
 * ・PV取得はここでは行わない(別命令「PV取得」に任せる)
 * ・書き込みが完了したら、後工程を3つ積む:
 *     サマリ更新   優先度30
 *     10分集計     優先度40
 *     PV取得       優先度50
 **********************************************************************/


// ============================
// 「日付シート作成」の実処理本体
// ============================

function processCreateDailySheetCommand_(targetDateStr) {
  const year = targetDateStr.substring(0, 4);
  const month = targetDateStr.substring(5, 7);
  const fileKey = `${year}年${month}月`;

  const spreadsheet = getOrCreateMonthlySpreadsheet(fileKey);

  const dateObj = new Date(`${targetDateStr}T00:00:00`);
  const mainSheet = findExistingDailySheet_(spreadsheet, dateObj);

  const dailyData = {};

  if (mainSheet) {
    readExistingDailySheet_(mainSheet, dailyData);
  }

  const searchRows = readSearchResultRowsForDate_(targetDateStr);

  let newInsertCount = 0;
  let duplicateCount = 0;

  searchRows.forEach(row => {
    const timeKey = row.time;
    const ncode = row.ncode;
    const title = row.title;

    if (!dailyData[timeKey]) {
      dailyData[timeKey] = {
        date: targetDateStr,
        items: []
      };
    }

    const block = dailyData[timeKey];
    
    const isDuplicate = block.items.some(item => item.ncode === ncode);

    if (isDuplicate) {
      duplicateCount++;
      return;
    }

    block.items.push({
      ncode: ncode,
      title: title,
      pv0: "",
      pv1: "",
      prevPostTime: "",
      errorMsg: ""
    });

    newInsertCount++;
  });

  console.log(`【日付シート作成】${targetDateStr} 新規挿入:${newInsertCount}件 / 重複スルー:${duplicateCount}件`);

  // 前回投稿時刻の計算(日またぎは前日シートを参照する。DailySheetIO.gs側の既存ロジック)

  console.log('here1');

  //calculatePrevPostTimes_(dailyData, targetDateStr, fileKey);
  console.log('here2');

  const buildResult = buildDailyRowsAndHourlyCounts_(dailyData);

  if (buildResult.rowsToWrite.length === 0) {
    console.log(`【日付シート作成】${targetDateStr} 書き込むデータが無いためスキップ`);
    return;
  }

  const sheetKey = buildSheetKeyFromDate_(dateObj);

  rewriteDailySheetSafely_(spreadsheet, sheetKey, mainSheet, buildResult.rowsToWrite);

  // 後工程を積む(サマリ更新・10分集計・PV取得)
  enqueue_(QUE_CONFIG.COMMAND.UPDATE_SUMMARY, targetDateStr, QUE_CONFIG.PRIORITY.UPDATE_SUMMARY);
  enqueue_(QUE_CONFIG.COMMAND.TEN_MINUTE, targetDateStr, QUE_CONFIG.PRIORITY.TEN_MINUTE);
  enqueue_(QUE_CONFIG.COMMAND.UPDATE_PV_SHEET, targetDateStr, QUE_CONFIG.PRIORITY.UPDATE_PV_SHEET);
}


// ============================
// 「検索結果」シートから、対象日付に一致する行だけを読み出す
// ============================

function readSearchResultRowsForDate_(targetDateStr) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SEARCH_RESULT_SHEET_NAME);

  if (!sheet) return [];

  const lastRow = sheet.getLastRow();

  if (lastRow < 2) return [];

  // 更新日|時刻|投稿数|NCODE|前回投稿時刻|PV数+0時間|PV数+1時間|作品名
  const values = sheet.getRange(2, 1, lastRow - 1, 8).getDisplayValues();

  const results = [];

  values.forEach(row => {
    const dateStr = row[0];

    if (dateStr !== targetDateStr) return;

    results.push({
      time: row[1],
      ncode: row[3],
      title: row[7]
    });
  });

  return results;
}