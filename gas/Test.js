/**********************************************************************
 * Test.gs
 *
 * 手動実行専用のデバッグ用関数集。
 * GASエディタの関数選択ドロップダウンから選んで直接実行する。
 *
 * ■ポイント
 * ・手動実行は実行者本人の認証でフル権限が使えるので、
 *   シンプルトリガーのような権限制限には引っかからない。
 * ・各関数はtry/catchで囲み、失敗時は err.stack (スタックトレース)を
 *   丸ごとログに出す。実行数タブでログを見れば、どの行で・何が
 *   原因で失敗したかがそのまま分かる。
 * ・本番のトリガー(enqueueFetchApiTrigger / queWorkerTrigger)は
 *   一切変更しない。あくまで別経路から同じ処理を直接呼ぶだけ。
 **********************************************************************/


// ============================
// QUEワーカーを手動で1回動かす
// (queWorkerTrigger をそのまま呼ぶだけ。本番と全く同じ経路)
// ============================

function testQueWorkerOnce() {
  try {
    console.log("【Test】queWorkerTrigger を手動実行します");
    queWorkerTrigger();
    console.log("【Test】queWorkerTrigger 完了(例外なし)");
  } catch (err) {
    console.log(`【Testエラー】${err.stack || err}`);
  }
}


// ============================
// 検索API叩けの積み込みを手動で1回動かす
// ============================

function testEnqueueFetchApiOnce() {
  try {
    console.log("【Test】enqueueFetchApiTrigger を手動実行します");
    enqueueFetchApiTrigger();
    console.log("【Test】enqueueFetchApiTrigger 完了(例外なし)");
  } catch (err) {
    console.log(`【Testエラー】${err.stack || err}`);
  }
}


// ============================
// 「日付シート作成」の実処理を、QUEを介さず直接呼ぶ。
// ロックの取得も、ステータス更新も行わない。
// 純粋に processCreateDailySheetCommand_ 単体の動作・エラーを見るためのもの。
//
// ★対象日付は下の TEST_TARGET_DATE_STR を書き換えてから実行する。
// ============================

const TEST_TARGET_DATE_STR = "2026-07-07"; // ★ここを対象日に合わせて変更

function testCreateDailySheetForDate() {
  try {
    console.log(`【Test】日付シート作成を直接実行します: ${TEST_TARGET_DATE_STR}`);
    processCreateDailySheetCommand_(TEST_TARGET_DATE_STR);
    console.log("【Test】日付シート作成 完了(例外なし)");
  } catch (err) {
    console.log(`【Testエラー】${err.stack || err}`);
  }
}


// ============================
// 検索API叩けの実処理を、QUEを介さず直接呼ぶ
// ============================

function testFetchApiCommand() {
  try {
    console.log("【Test】検索API叩けを直接実行します");
    processFetchApiCommand_();
    console.log("【Test】検索API叩け 完了(例外なし)");
  } catch (err) {
    console.log(`【Testエラー】${err.stack || err}`);
  }
}


// ============================
// サマリ更新の実処理を、QUEを介さず直接呼ぶ
// ============================

function testUpdateSummaryForDate() {
  try {
    console.log(`【Test】サマリ更新を直接実行します: ${TEST_TARGET_DATE_STR}`);
    processUpdateSummaryCommand_(TEST_TARGET_DATE_STR);
    console.log("【Test】サマリ更新 完了(例外なし)");
  } catch (err) {
    console.log(`【Testエラー】${err.stack || err}`);
  }
}


// ============================
// 10分集計の実処理を、QUEを介さず直接呼ぶ
// ============================

function testTenMinuteForDate() {
  try {
    console.log(`【Test】10分集計を直接実行します: ${TEST_TARGET_DATE_STR}`);
    processTenMinuteCommand_(TEST_TARGET_DATE_STR);
    console.log("【Test】10分集計 完了(例外なし)");
  } catch (err) {
    console.log(`【Testエラー】${err.stack || err}`);
  }
}


// ============================
// 「PV取得シート更新」の実処理を、QUEを介さず直接呼ぶ
// ============================

function testUpdatePvSheetForDate() {
  try {
    console.log(`【Test】PV取得シート更新を直接実行します: ${TEST_TARGET_DATE_STR}`);
    processUpdatePvSheetCommand_(TEST_TARGET_DATE_STR);
    console.log("【Test】PV取得シート更新 完了(例外なし)");
  } catch (err) {
    console.log(`【Testエラー】${err.stack || err}`);
  }
}


// ============================
// 「PV取得実行」の実処理を、QUEを介さず直接呼ぶ
// (日付を問わずシート全体が対象なので、引数は不要)
// ============================

function testFetchPvSheet() {
  try {
    console.log("【Test】PV取得実行を直接実行します");
    const remainingCount = processFetchPvSheetCommand_("");
    console.log(`【Test】PV取得実行 完了(例外なし) / 残り件数: ${remainingCount}`);
  } catch (err) {
    console.log(`【Testエラー】${err.stack || err}`);
  }
}


// ============================
// QUEシートの中身を全部見て、ログに出す(現状把握用)
// ============================

function testDumpQueSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(QUE_CONFIG.SHEET_NAME);

  if (!sheet) {
    console.log("【Test】QUEシートが存在しません");
    return;
  }

  const lastRow = sheet.getLastRow();

  if (lastRow < 2) {
    console.log("【Test】QUEシートにデータ行がありません");
    return;
  }

  const values = sheet.getRange(2, 1, lastRow - 1, 10).getDisplayValues();

  values.forEach((row, idx) => {
    console.log(`行${idx + 2}: ID=${row[0]} [${row[1]}] 日付=${row[2]} 優先度=${row[3]} 積み元=${row[4]} ステータス=${row[5]} 作成=${row[6]} 開始=${row[7]} 終了=${row[8]} 監視=${row[9]}`);
  });
}


// ============================
// QUEシートで「処理中」または「エラー」になっている行を、
// 手動で「未処理」に戻す(再試行させたい時用)。
// 特定の行だけ戻したい場合は、下の TEST_RESET_ROW を指定する
// (0のままなら「処理中/エラー」の行を全部戻す)。
// ============================

const TEST_RESET_ROW = 0; // ★特定の行番号(シート上の行番号)だけ戻したい場合はここに指定。0なら全件対象

function testResetStuckQueRows() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(QUE_CONFIG.SHEET_NAME);

  if (!sheet) {
    console.log("【Test】QUEシートが存在しません");
    return;
  }

  const lastRow = sheet.getLastRow();

  if (lastRow < 2) {
    console.log("【Test】QUEシートにデータ行がありません");
    return;
  }

  const statusRange = sheet.getRange(2, 4, lastRow - 1, 1); // D列(ステータス)
  const statuses = statusRange.getDisplayValues();

  let resetCount = 0;

  statuses.forEach((row, idx) => {
    const sheetRow = idx + 2;

    if (TEST_RESET_ROW !== 0 && sheetRow !== TEST_RESET_ROW) return;

    const status = row[0];
    const isStuck = (status === QUE_CONFIG.STATUS.IN_PROGRESS || status.indexOf("エラー") === 0);

    if (!isStuck) return;

    sheet.getRange(sheetRow, 4).setValue(QUE_CONFIG.STATUS.PENDING);
    resetCount++;
  });

  console.log(`【Test】${resetCount}件を「未処理」に戻しました`);
}


// ============================
// 「PV取得」シートの中身を全部見て、ログに出す(現状把握用)
// ============================

function testDumpPvSheet() {
  const year = TEST_TARGET_DATE_STR.substring(0, 4);
  const month = TEST_TARGET_DATE_STR.substring(5, 7);
  const fileKey = `${year}年${month}月`;

  const ss = findMonthlySpreadsheetIfExists_(fileKey);

  if (!ss) {
    console.log(`【Test】月別ファイルが見つかりません: ${fileKey}`);
    return;
  }

  const sheet = ss.getSheetByName(PV_SHEET_NAME);

  if (!sheet) {
    console.log("【Test】「PV取得」シートが存在しません");
    return;
  }

  const lastRow = sheet.getLastRow();

  if (lastRow < 2) {
    console.log("【Test】「PV取得」シートにデータ行がありません");
    return;
  }

  const values = sheet.getRange(2, 1, lastRow - 1, 6).getDisplayValues();

  const summary = { 未処理: 0, 完了: 0, その他: 0 };

  values.forEach((row, idx) => {
    console.log(`行${idx + 2}: [${row[0]}] Nコード=${row[1]} 日付=${row[2]} 時刻=${row[3]} PV数=${row[4]} エラー=${row[5]}`);

    if (row[0] === "未処理") summary.未処理++;
    else if (row[0] === "完了") summary.完了++;
    else summary.その他++;
  });

  console.log(`【Test】集計: 未処理=${summary.未処理} / 完了=${summary.完了} / その他(エラー等)=${summary.その他} / 合計=${values.length}`);
}


// ============================
// QUEシートの「30行上限」動作を、本物の命令で確認するテスト。
//
// ダミー命令ではなく、実際に本番と同じ「PV取得シート更新」を
// TEST_TARGET_DATE_STR に対してQUE経由(未処理→ワーカーが拾う)で
// 積んで実行する。これにより、findMonthlySpreadsheetIfExists_ が
// 実際に該当月のスプレッドシートを読みに行く、本番と同じ経路を確認できる。
//
// ★注意: QUEシートはこのプロジェクトがバインドされている
// スプレッドシート(テンプレート)側にある。ダミーデータで
// 本番のQUEを汚さないよう、必ず実在する命令種別・対象日付を使うこと。
// ============================

function testEnqueuePvSheetUpdateForTestDate() {
  console.log(`【Test】「PV取得シート更新」を未処理でQUEへ積みます: ${TEST_TARGET_DATE_STR}`);

  enqueue_(
    QUE_CONFIG.COMMAND.UPDATE_PV_SHEET,
    TEST_TARGET_DATE_STR,
    QUE_CONFIG.PRIORITY.UPDATE_PV_SHEET,
    "手動テスト(Test.gs)"
  );

  console.log("【Test】積み込み完了。この後 testQueWorkerOnce を実行すると、");
  console.log("　　　　優先度が最も若ければこの命令が選ばれて処理されます。");
  console.log("　　　　(他にもっと優先度の高い未処理があれば、そちらが先に処理されます)");
}


// ============================
// 「PV取得」シートのデータ行を全部消して、ヘッダーだけの状態に戻す。
// 過去のバージョン違いのデータが混在してしまった時の、やり直し用。
// ============================

function testClearPvSheet() {
  const year = TEST_TARGET_DATE_STR.substring(0, 4);
  const month = TEST_TARGET_DATE_STR.substring(5, 7);
  const fileKey = `${year}年${month}月`;

  const ss = findMonthlySpreadsheetIfExists_(fileKey);

  if (!ss) {
    console.log(`【Test】月別ファイルが見つかりません: ${fileKey}`);
    return;
  }

  const sheet = ss.getSheetByName(PV_SHEET_NAME);

  if (!sheet) {
    console.log("【Test】「PV取得」シートが存在しません(何もしません)");
    return;
  }

  const lastRow = sheet.getLastRow();

  if (lastRow < 2) {
    console.log("【Test】「PV取得」シートは既にデータ行がありません");
    return;
  }

  sheet.deleteRows(2, lastRow - 1);
  console.log(`【Test】「PV取得」シートのデータ行(${lastRow - 1}行)を削除しました`);
}

function getQueDataRowCount_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(QUE_CONFIG.SHEET_NAME);

  if (!sheet) return 0;

  return Math.max(sheet.getLastRow() - 1, 0);
}