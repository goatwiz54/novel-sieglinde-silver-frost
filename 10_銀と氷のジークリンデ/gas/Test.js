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
 * ・TestではTASK/QUEへの書き込みや参照を行わない。
 * ・実処理関数(processXxxCommand_)を直接呼んで挙動確認する。
 **********************************************************************/


// ============================
// QUEワーカーを手動で1回動かす
// (queWorkerTrigger をそのまま呼ぶだけ。本番と全く同じ経路)
// ============================

function testQueWorkerOnce() {
  console.log("【Test】無効: TestではQUEを見ません。必要ならGAS画面から queWorkerTrigger を直接実行してください。");
}


// ============================
// 検索API叩けの積み込みを手動で1回動かす
// ============================

function testEnqueueFetchApiOnce() {
  console.log("【Test】無効: TestではTASK/QUEへ積み込みません。");
}


// ============================
// TASK予約をQUEへ反映する appendQueTrigger を手動で1回動かす
// ============================

function testAppendQueOnce() {
  console.log("【Test】無効: TestではTASK/QUEへ積み込みません。");
}


// ============================
// 「日付シート作成」の実処理を直接呼ぶ。
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
// 検索API叩けの実処理を直接呼ぶ
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
// サマリ更新の実処理を直接呼ぶ
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
// 10分集計の実処理を直接呼ぶ
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
// 「PV取得シート更新」の実処理を直接呼ぶ
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
// 「PV取得実行」の実処理を直接呼ぶ
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
  console.log("【Test】無効: TestではQUEを参照しません。");
}


// ============================
// QUEシートで「処理中」または「エラー」になっている行を、
// 手動で「未処理」に戻す(再試行させたい時用)。
// 特定の行だけ戻したい場合は、下の TEST_RESET_ROW を指定する
// (0のままなら「処理中/エラー」の行を全部戻す)。
// ============================

const TEST_RESET_ROW = 0; // 未使用(互換維持)

function testResetStuckQueRows() {
  console.log("【Test】無効: TestではQUEを更新しません。");
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
// TASK予約→appendQueTrigger経由で「PV取得シート更新」をQUEへ積むテスト。
//
// 実際に本番と同じ、TASK予約→trigger_append_que→QUE積み込みの
// 経路で「PV取得シート更新」を積む。これにより、予約層の動作も
// 含めて確認できる。
//
// ★注意: QUEシートはこのプロジェクトがバインドされている
// スプレッドシート(テンプレート)側にある。ダミーデータで
// 本番のQUEを汚さないよう、必ず実在する命令種別・対象日付を使うこと。
// ============================

function testEnqueuePvSheetUpdateForTestDate() {
  console.log("【Test】無効: TestではTASK/QUEを扱いません。testUpdatePvSheetForDate を使用してください。");
}


// ============================
// QUE整理の実処理を直接呼ぶ
// ============================

function testQueCleanup() {
  try {
    console.log("【Test】QUE整理を直接実行します");
    processQueCleanupCommand_();
    console.log("【Test】QUE整理 完了(例外なし)");
  } catch (err) {
    console.log(`【Testエラー】${err.stack || err}`);
  }
}


// ============================
// 破壊的な直接操作は禁止。QUE経路以外の処理は行わない。
// ============================

function getQueDataRowCount_() {
  return 0;
}