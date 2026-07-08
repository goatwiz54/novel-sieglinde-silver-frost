/**********************************************************************
 * PvFetchQueCommand.gs
 *
 * QUE命令「PV取得」の実処理。
 *
 * ■スリープを使わない理由
 * ・1分ワーカーは LockService のロックを持ったまま動くため、
 *   内部でUtilities.sleep()すると他のQUE処理(15分トリガーの積み込み含む)
 *   を長時間ブロックしてしまう。
 * ・そこでPvGetter.fetchAndApplyPvDataBatch_() を使い、
 *   スリープなしで最大 PV_FETCH_BATCH_SIZE 件だけ処理する。
 * ・未処理が残っていれば、同じ「PV取得」命令を未処理で再度積む。
 *   次の1分トリガーが続きを処理する(=1分間隔がスリープの代わりになる)。
 **********************************************************************/


const PV_FETCH_BATCH_SIZE = 30;


// ============================
// 「PV取得」の実処理本体
// ============================

function processFetchPvCommand_(targetDateStr) {
  if (!CONFIG.PV_FETCH_ENABLED) {
    console.log("【PV取得】PV_FETCH_ENABLED=false のためスキップします");
    return;
  }

  const year = targetDateStr.substring(0, 4);
  const month = targetDateStr.substring(5, 7);
  const fileKey = `${year}年${month}月`;

  const spreadsheet = findMonthlySpreadsheetIfExists_(fileKey);

  if (!spreadsheet) {
    console.log(`【PV取得】月別ファイルが見つかりません: ${fileKey}`);
    return;
  }

  const dateObj = new Date(`${targetDateStr}T00:00:00`);
  const dailySheet = findExistingDailySheet_(spreadsheet, dateObj);

  if (!dailySheet) {
    console.log(`【PV取得】日別シートが見つかりません: ${targetDateStr}`);
    return;
  }

  const dailyData = {};
  readExistingDailySheet_(dailySheet, dailyData);

  const result = PvGetter.fetchAndApplyPvDataBatch_(dailyData, targetDateStr, PV_FETCH_BATCH_SIZE);

  const buildResult = buildDailyRowsAndHourlyCounts_(dailyData);

  if (buildResult.rowsToWrite.length > 0) {
    const sheetKey = buildSheetKeyFromDate_(dateObj);
    rewriteDailySheetSafely_(spreadsheet, sheetKey, dailySheet, buildResult.rowsToWrite);
  }

  console.log(`【PV取得】${targetDateStr} 処理:${result.processedCount}件 / 残り:${result.remainingCount}件`);

  if (result.remainingCount > 0) {
    // 未処理が残っているので、同じ命令を再度積む(次の1分トリガーが続きを処理)
    enqueue_(QUE_CONFIG.COMMAND.FETCH_PV, targetDateStr, QUE_CONFIG.PRIORITY.FETCH_PV);
  }
}