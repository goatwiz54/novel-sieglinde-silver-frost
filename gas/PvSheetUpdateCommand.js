/**********************************************************************
 * PvSheetUpdateCommand.gs
 *
 * QUE命令「PV取得シート更新」の実処理。
 *
 * ■やること
 * ・対象日付(targetDateStr)の日別シートを開き、子行(投稿1件ごと)を読む
 * ・投稿1件につき、その投稿時刻(HOUR)そのものをチェックポイントにする
 *   (NCODE, 投稿日, 投稿時刻のHOUR)
 *   ★「+0時間」「+1時間」への展開は行わない(今は使わない仕様のため)
 * ・「PV取得」シートに、同じ(NCODE+日付+時刻(HOUR))の行が
 *   まだ無ければ、ステータス「未処理」で追加する(既にあれば追加しない)
 * ・1行でも追加したら、「PV取得実行」をQUEへ積む
 *
 * ■「PV取得」シート列構成
 *   A: 完了日時(yyyy-MM-dd HH:mm:ss(曜))
 *   B: ステータス(未処理/完了/エラー:〜)
 *   C: Nコード
 *   D: 日付(yyyy-MM-dd)
 *   E: 時刻(HOUR)(0〜23の整数)
 *   F: PV数
 *   G: エラー原因
 **********************************************************************/


const PV_SHEET_NAME = "PV取得";


// ============================
// 「PV取得シート更新」の実処理本体
// ============================

function processUpdatePvSheetCommand_(targetDateStr) {
  const year = targetDateStr.substring(0, 4);
  const month = targetDateStr.substring(5, 7);
  const fileKey = `${year}年${month}月`;

  const spreadsheet = findMonthlySpreadsheetIfExists_(fileKey);

  if (!spreadsheet) {
    console.log(`【PV取得シート更新】月別ファイルが見つかりません: ${fileKey}`);
    return;
  }

  const dateObj = new Date(`${targetDateStr}T00:00:00`);
  const dailySheet = findExistingDailySheet_(spreadsheet, dateObj);

  if (!dailySheet) {
    console.log(`【PV取得シート更新】日別シートが見つかりません: ${targetDateStr}`);
    return;
  }

  const checkpoints = buildPvCheckpointsFromDailySheet_(dailySheet, targetDateStr);

  const ss = spreadsheet; // ★月別ファイル(日別シートと同じファイル)に書き込む。テンプレートではない。
  let pvSheet = ss.getSheetByName(PV_SHEET_NAME);

  if (!pvSheet) {
    pvSheet = ss.insertSheet(PV_SHEET_NAME);
    setupPvSheetHeaders_(pvSheet);
  }

  const existingKeys = buildPvSheetKeySet_(pvSheet);

  // ★診断用ログ(原因切り分け用。落ち着いたら消してよい)
  console.log(`【診断】日別シートから作られたチェックポイント数: ${checkpoints.length}`);
  console.log(`【診断】PV取得シートの既存キー数: ${existingKeys.size}`);
  if (checkpoints.length > 0) {
    const sample = checkpoints[checkpoints.length - 1];
    const sampleKey = buildPvCheckpointKey_(sample.ncode, sample.dateStr, sample.hourLabel);
    console.log(`【診断】最後のチェックポイント例: ${JSON.stringify(sample)} / キー=${sampleKey} / 既存に含まれる?=${existingKeys.has(sampleKey)}`);
  }

  const rowsToAppend = [];

  checkpoints.forEach(cp => {
    const key = buildPvCheckpointKey_(cp.ncode, cp.dateStr, cp.hourLabel);

    if (existingKeys.has(key)) return;

    rowsToAppend.push(["", "未処理", cp.ncode, cp.dateStr, cp.hourLabel, "", ""]);
    existingKeys.add(key); // 同じバッチ内での二重追加を防ぐ
  });

  if (rowsToAppend.length > 0) {
    const startRow = pvSheet.getLastRow() + 1;
    pvSheet.getRange(startRow, 1, rowsToAppend.length, rowsToAppend[0].length).setValues(rowsToAppend);
  }

  console.log(`【PV取得シート更新】${targetDateStr} 追加:${rowsToAppend.length}件`);

  if (rowsToAppend.length > 0) {
    reserveTaskByKeyPrefix_(TASK_TRIGGER_PREFIX.FETCH_PV, targetDateStr);
  }
}


// ============================
// 日別シートの子行(投稿)から、必要なPVチェックポイント一覧を作る。
//
// ■手順
// 1. まず「日付+時刻+NCODE」をキーにしたハッシュマップ(buff)を作り、
//    日別シート内でのユニークな(投稿日時, NCODE)の組み合わせを確定する。
//    (親行の直後にまた親行が来る=その時間帯は投稿0件、というケースは
//     子レコードが空なのでcontinueする)
// 2. buffの各エントリを、そのまま1件のチェックポイントとして使う。
//
// ★「+0時間」「+1時間」への展開は行わない(今は使わない仕様のため)。
//   投稿の実時刻(HOUR)そのものが、そのままチェックポイントになる。
// ============================

function buildPvCheckpointsFromDailySheet_(dailySheet, sheetDateStr) {
  const lastRow = dailySheet.getLastRow();

  if (lastRow < 2) return [];

  const values = dailySheet.getRange(2, 1, lastRow - 1, 9).getDisplayValues();

  // 1. 日付+時刻+NCODEでユニークな一覧(buff)を作る
  const buff = {};
  let currentTime = "";

  values.forEach(row => {
    const colB = row[1]; // 時刻
    const colD = row[3]; // NCODE

    const isParentRow = (colB !== "" && colD === "");

    if (isParentRow) {
      currentTime = normalizeTimeString_(colB);
      return; // continue相当: 次の行を見るためここで終わる
    }

    if (colD === "" || currentTime === "") return; // 子レコードが空 → continue相当

    const ncode = colD;
    const key = `${sheetDateStr}|${currentTime}|${ncode}`;

    if (!buff[key]) {
      buff[key] = { dateStr: sheetDateStr, time: currentTime, ncode: ncode };
    }
  });

  // 2. buffの各エントリを、そのまま1件のチェックポイントにする
  const checkpoints = [];

  Object.keys(buff).forEach(key => {
    const entry = buff[key];
    const hour = parseInt(entry.time.substring(0, 2), 10);

    checkpoints.push({ ncode: entry.ncode, dateStr: entry.dateStr, hourLabel: buildHourLabel_(hour) });
  });

  return checkpoints;
}


// ============================
// 「PV取得」シートのヘッダーを設定する(シート新規作成時のみ)
// ============================

function setupPvSheetHeaders_(sheet) {
  const headers = ["完了日時", "ステータス", "Nコード", "日付", "時刻(HOUR)", "PV数", "エラー原因"];

  sheet.getRange("A:G").setNumberFormat("@");

  const headerRange = sheet.getRange(1, 1, 1, headers.length);
  headerRange.setValues([headers]);
  headerRange.setBackground("#FFFF00");
  headerRange.setFontWeight("bold");
  headerRange.setHorizontalAlignment("center");
}


// ============================
// 既存の「PV取得」シート全行を読み、(NCODE+日付+時刻)のキー集合を作る。
// 既に同じチェックポイントが(どのステータスであれ)存在すれば、
// 重複して追加しないための判定に使う。
// ============================

function buildPvSheetKeySet_(sheet) {
  const set = new Set();

  const lastRow = sheet.getLastRow();

  if (lastRow < 2) return set;

  const values = sheet.getRange(2, 1, lastRow - 1, 5).getDisplayValues(); // 完了日時,ステータス,Nコード,日付,時刻(HOUR)

  values.forEach(row => {
    const key = buildPvCheckpointKey_(row[2], row[3], row[4]);
    set.add(key);
  });

  return set;
}


// ============================
// (NCODE+日付+時刻)から複合キーを作る
// 時刻は "HH:00" 形式の文字列(hourLabel)を使う
// ============================

function buildPvCheckpointKey_(ncode, dateStr, hourLabel) {
  return `${ncode}|${dateStr}|${hourLabel}`;
}


// ============================
// 時間(0〜23の整数)から "HH:00" 形式のラベルを作る。
// 実投稿時刻は13:10や13:11など分単位でバラバラだが、
// PVチェックポイントは「時間帯」だけを表すため、分は00に統一する。
// ============================

function buildHourLabel_(hour) {
  return `${String(hour).padStart(2, "0")}:00`;
}