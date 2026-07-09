/**********************************************************************
 * SummaryManualTrigger.gs
 *
 * サマリシートのA列を使った手動更新トリガー。
 * TenMinuteUpdater.gs の installedOnEdit(10分集計)と全く同じパターン。
 *
 * ■使い方
 * サマリシートの任意の行のA列(ステータス)に「未処理」と入力すると、
 * その行のB列(日付)を対象にサマリ更新(processUpdateSummaryCommand_)が
 * 実行される。
 *
 *   入力直後      → A列が「◆」(処理中)になる
 *   成功          → A列が「✅」になる
 *   失敗          → A列が「💀:エラー内容」になる
 *
 * ■なぜシンプルトリガー(onEdit)を使わないか
 * シンプルトリガーはDriveApp等の認可が必要なサービスを呼べないため、
 * processUpdateSummaryCommand_内のDriveApp呼び出し(月別ファイル検索)が
 * 権限エラーで静かに失敗する(TenMinuteUpdater.gsと同じ理由)。
 * そのため installedOnEditSummary という名前にし、インストール型
 * トリガー(ScriptApp.newTrigger)として登録する。
 *
 * ■トリガーの自動登録
 * Common.gs の getOrCreateMonthlySpreadsheet が月別ファイルを開く/作成
 * するたびに ensureSummaryEditTrigger_() を呼ぶことで自動的に行われる
 * (TenMinuteUpdater.gsのensureTenMinuteEditTrigger_と同様、重複作成防止つき)。
 **********************************************************************/


// ============================
// サマリシート編集ハンドラ(インストール型トリガーの実体)
// ============================

function installedOnEditSummary(e) {
  if (!e) return;

  const range = e.range;
  const sheet = range.getSheet();

  if (sheet.getName() !== CONFIG.SUMMARY_SHEET_NAME) return;
  if (range.getColumn() !== 1) return; // A列以外は無視
  if (range.getRow() === 1) return;    // ヘッダー行は無視

  const value = range.getValue();

  if (value !== "未処理") return;

  const row = range.getRow();

  // 検知した瞬間に「処理中」であることが分かるよう即座に上書きする
  range.setValue("◆");
  SpreadsheetApp.flush();

  try {
    const dateCellValue = sheet.getRange(row, 2).getDisplayValue(); // B列(日付)
    const dateStr = normalizeDateString_(dateCellValue);

    if (!dateStr) {
      sheet.getRange(row, 1).setValue(`💀:日付が読み取れません(値="${dateCellValue}")`);
      return;
    }

    processUpdateSummaryCommand_(dateStr);

    sheet.getRange(row, 1).setValue("✅");
  } catch (err) {
    console.log(`【サマリ手動更新】想定外のエラー: ${err.stack || err}`);
    sheet.getRange(row, 1).setValue(`💀:${err.toString()}`);
  }
}


// ============================
// この月別ファイルに、サマリ手動更新用のインストール型トリガーが
// まだ無ければ作成する(重複作成防止つき)。
// ============================

function ensureSummaryEditTrigger_(spreadsheetId) {
  const alreadyExists = ScriptApp.getProjectTriggers().some(trigger =>
    trigger.getHandlerFunction() === "installedOnEditSummary" &&
    trigger.getTriggerSourceId() === spreadsheetId
  );

  if (alreadyExists) return;

  ScriptApp.newTrigger("installedOnEditSummary")
    .forSpreadsheet(spreadsheetId)
    .onEdit()
    .create();

  console.log(`【トリガー設定】サマリonEditトリガーを作成しました: ${spreadsheetId}`);
}


// ============================
// 手動セットアップ用(初回のみ、GASエディタから直接実行する)
// アクティブなスプレッドシート(このファイルを開いた状態)に対して
// インストール型トリガーを作成する。認可ダイアログが出るので許可すること。
// ============================

function setupSummaryEditTrigger_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ensureSummaryEditTrigger_(ss.getId());
}