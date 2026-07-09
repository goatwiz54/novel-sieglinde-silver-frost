/**********************************************************************
 * PvFetchQueCommand.gs
 *
 * 旧「PV取得」経路の互換ラッパー。
 * 現行実装は QUE命令「PV取得実行」(FETCH_PV_SHEET) に一本化済みのため、
 * ここでは processFetchPvSheetCommand_ へ委譲する。
 **********************************************************************/


// ============================
// 旧「PV取得」実行の互換エントリポイント
// ============================

function processFetchPvCommand_(targetDateStr) {
  console.log("【PV取得(旧)】互換経路で実行します。現行のPV取得実行へ委譲します。");

  const remainingCount = processFetchPvSheetCommand_(targetDateStr || "");

  if (remainingCount === -1) {
    console.log("【PV取得(旧)】UrlFetch上限超過のため再enqueueしません。");
    return;
  }

  if (remainingCount > 0) {
    enqueue_(
      QUE_CONFIG.COMMAND.FETCH_PV_SHEET,
      targetDateStr || null,
      QUE_CONFIG.PRIORITY.FETCH_PV_SHEET,
      "processFetchPvCommand_(互換再登板)",
      false
    );
  }
}