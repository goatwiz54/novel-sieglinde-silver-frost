/**********************************************************************
 * PvSheetFetchCommand.gs
 *
 * QUE命令「PV取得実行」の実処理。
 *
 * ■やること
 * ・「PV取得」シートは日別シートと同じ月別ファイルの中にあるため、
 *   対象月のファイルを特定して開く(月の特定方法は下記参照)。
 * ・その月の「PV取得」シートから「未処理」の行を、最大
 *   PV_SHEET_FETCH_BATCH_SIZE 件処理する。
 * ・PvGetter.fetchPvForDateHour_() でPV数を取得し、更新ルールを適用する。
 *
 * ■対象日付(targetDateStr)の扱い
 * ・指定あり → その日付の行だけに絞り込んで処理する。月の特定にも使う。
 * ・null/""  → 日付で絞り込まず、シートの上から順番に処理する。
 *              月の特定は実行時点の「今日」を使う。
 *
 * ■残り件数はreturnするだけ(enqueueはしない)
 * ・この関数自体はQUEへの積み込みを行わない。処理しきれず残った件数を
 *   そのままreturnし、呼び出し元(QueManager.gs の dispatchQueCommand_)が
 *   その戻り値を見て、必要なら「PV取得実行」を再度積む。
 *
 * ■更新ルール
 *   空欄 → 書き込み、ステータス「完了」
 *   増加 → 上書き、ステータス「完了」
 *   同値 → 値はそのまま、ステータス「完了」
 *   減少 → 上書きしない、ステータス「エラー:PV減少」
 *   保存値が数値以外 → 上書きしない、ステータス「エラー:保存値不正」
 *
 * ■取得失敗時の扱い
 *   ・「PV対象外:取得可能範囲外」(2日以上前) → 確定エラー。
 *     ステータスを「エラー:PV対象外:取得可能範囲外」にして、二度と処理しない。
 *   ・それ以外(todayデータなし・取得失敗など、時間経過で解消し得る一時的な理由)
 *     → ステータスは「未処理」のまま変更しない(次回のPV取得実行で再挑戦する)。
 *     エラー原因欄には参考情報として記録する。
 **********************************************************************/


const PV_SHEET_FETCH_BATCH_SIZE = 100;


// ============================
// PV取得実行 積み込み専用トリガー(5分ごと)
//
// このトリガー自体はPV数の取得を一切行わない。「PV取得実行」を
// QUEへ積むだけ。実際の処理は、いつも通りqueWorkerTrigger経由で
// dispatchQueCommand_ が処理する。
//
// ・対象は「今日」と「前日」の2日分(かささぎが取得できる範囲と同じ)。
// ・enqueue_の通常の重複チェックにより、その日付の「PV取得実行」が
//   既に未処理/処理中で存在する場合は、何も積まずスキップされる。
// ・これにより、日付シート作成の完了時の積み込みが何らかの理由で
//   漏れても、最大5分以内には必ずQUEに載る、という安全網になる。
// ============================

// ============================
// PV取得実行 積み込み専用トリガー(5分ごと)
//
// このトリガー自体はPV数の取得を一切行わない。「PV取得実行」を
// QUEへ積むだけ。実際の処理は、いつも通りqueWorkerTrigger経由で
// dispatchQueCommand_ が処理する。
//
// ★対象日付は指定しない(null)。processFetchPvSheetCommand_は、
// 対象日付が無い場合は日付で絞り込まず、実行時点の「今日」の月の
// 「PV取得」シートを上から順番に処理する。
// enqueue_の通常の重複チェックにより、対象日付なしの「PV取得実行」が
// 既に未処理/処理中で存在する場合は、何も積まずスキップされる。
// これにより、他の積み込みが何らかの理由で漏れても、最大5分以内には
// 必ずQUEに載る、という安全網になる。
// ============================

function enqueuePvFetchSheetTrigger() {
  reserveTaskByKeyPrefix_(TASK_TRIGGER_PREFIX.FETCH_PV, "");
}

// ============================
// 「PV取得実行」の実処理本体
//
// targetDateStr:
//   ・指定あり → その日付の行だけに絞り込んで処理する
//   ・null/""  → 日付で絞り込まず、シートの上から順番に処理する
//                (ファイルは実行時点の「今日」の月を開く)
// ============================

function processFetchPvSheetCommand_(targetDateStr) {
  let fileKey;

  if (targetDateStr) {
    const year = targetDateStr.substring(0, 4);
    const month = targetDateStr.substring(5, 7);
    fileKey = `${year}年${month}月`;
  } else {
    const now = new Date();
    const year = Utilities.formatDate(now, CONFIG.TIMEZONE, "yyyy");
    const month = Utilities.formatDate(now, CONFIG.TIMEZONE, "MM");
    fileKey = `${year}年${month}月`;
  }

  const spreadsheet = findMonthlySpreadsheetIfExists_(fileKey);

  if (!spreadsheet) {
    console.log(`【PV取得実行】月別ファイルが見つかりません: ${fileKey}`);
    return 0;
  }

  const sheet = spreadsheet.getSheetByName(PV_SHEET_NAME);

  if (!sheet) {
    console.log("【PV取得実行】「PV取得」シートが見つかりません");
    return 0;
  }

  const lastRow = sheet.getLastRow();

  if (lastRow < 2) {
    console.log("【PV取得実行】データ行がありません");
    return 0;
  }

  // 読み込むのは先頭6列のみ(A:完了時刻, B:ステータス, C:NCODE, D:日付, E:時刻文字列, F:旧保存値)
  const values = sheet.getRange(2, 1, lastRow - 1, 6).getDisplayValues();

  const pendingRows = [];

  values.forEach((row, idx) => {
    if (row[1] !== "未処理") return;
    if (targetDateStr && row[3] !== targetDateStr) return; // 対象日付指定時だけ絞り込む

    pendingRows.push({
      sheetRow: idx + 2,
      ncode: row[2],
      dateStr: row[3],
      hour: parseInt(String(row[4]).substring(0, 2), 10), // "HH:00" → 整数HH
      pvRaw: row[5]
    });
  });

  if (pendingRows.length === 0) {
    console.log(`【PV取得実行】未処理の行はありません(対象日付: ${targetDateStr || "指定なし"})`);
    return 0;
  }

  const toProcess = pendingRows.slice(0, PV_SHEET_FETCH_BATCH_SIZE);
  const remainingCount = pendingRows.length - toProcess.length;

  const pvCache = {};

  const uniqueNcodes = {};
  toProcess.forEach(row => {
    uniqueNcodes[String(row.ncode).toUpperCase()] = true;
  });

  const fetchStats = {
    current: 0,
    total: Object.keys(uniqueNcodes).length
  };

  try {
    toProcess.forEach(row => {
      // 0..23時を順に取得し、G列(7)から右へ24列分に書き込む
      const hourlyValues = new Array(24).fill("");
      let hasTemporaryFailure = false;
      let permanentFailureReason = "";

      for (let h = 0; h < 24; h++) {
        const fetched = PvGetter.fetchPvForDateHour_(pvCache, row.ncode, "", row.dateStr, h, fetchStats);

        if (!fetched.ok) {
          // 永続エラーなら即時処理終了(完了扱い)
          if (PV_PERMANENT_ERROR_REASONS.indexOf(fetched.reason) !== -1) {
            permanentFailureReason = fetched.reason;
            break;
          }

          // 一時的な失敗(時間帯未経過等)は記録してリトライを許す
          hasTemporaryFailure = true;
          // 参考情報として最後の一時的理由を残す
          hourlyValues[h] = "";
        } else {
          hourlyValues[h] = fetched.value;
        }
      }

      // UrlFetch上限例外はPvGetter側で例外を投げるためキャッチする
      if (permanentFailureReason) {
        // 永続失敗: applyPvSheetRow_ に任せて完了扱い + エラー理由を記録
        applyPvSheetRow_(sheet, row, { ok: false, reason: permanentFailureReason });
        // 書き込み済みの時間帯があればそれも反映する(時間帯データはH列(8)から24列)
        sheet.getRange(row.sheetRow, 8, 1, 24).setValues([hourlyValues]);
      } else if (hasTemporaryFailure) {
        // 一時的失敗あり: 書けた時間帯だけ書き込み、ステータスは未処理のままにする
        sheet.getRange(row.sheetRow, 8, 1, 24).setValues([hourlyValues]);
        // 参考情報はG列(7)へ
        sheet.getRange(row.sheetRow, 7).setValue("時間帯未経過");
      } else {
        // 全時間帯正常取得 → 時間帯データを一括書き込みし、F列については既存の
        // 単一時間更新ロジック(applyPvSheetRow_)を流用して互換性を保つ
        sheet.getRange(row.sheetRow, 8, 1, 24).setValues([hourlyValues]);
        const newVal = hourlyValues[row.hour];
        applyPvSheetRow_(sheet, row, { ok: true, value: newVal });
      }
    });
  } catch (e) {
    if (e && e.message === "URLFETCH_QUOTA_EXCEEDED") {
      console.log("【PV取得実行】UrlFetch上限超過のため即時終了");
      return -1;
    }
    throw e;
  }

  console.log(`【PV取得実行】${fileKey} 処理:${toProcess.length}件 / 残り(次回以降):${remainingCount}件`);

  return remainingCount;
}


// ============================
// 取得結果を「PV取得」シートの該当行へ反映する
//
// ■ステータスは「未処理」「完了」の2種類だけ
// 確定した(=もう再挑戦しない)行はすべて「完了」にする。
// 成功か失敗かは、E列(PV数。空欄なら未取得)とF列(エラー原因。
// 空欄ならエラーなし)を見れば分かるので、ステータス自体に
// 「エラー:〜」という接頭辞は付けない。
//
// ■確定扱い(ステータスを「完了」にする)になるケース
// ・正常に取得できた(空欄→書込み/増加→上書き/同値→そのまま)
// ・「PV対象外:取得可能範囲外」(2日以上前)
// ・「作品が存在しません(削除済みの可能性)」
// ・PV減少(異常値なので値は上書きしないが、確定扱いにする)
// ・保存値が数値以外(異常値なので値は触らないが、確定扱いにする)
//
// ■「未処理」のまま維持するケース(一時的な失敗、次回リトライ)
// ・todayデータなし / yesterdayデータなし / PV取得失敗 / 時間帯未経過
// ============================

const PV_PERMANENT_ERROR_REASONS = [
  "PV対象外:取得可能範囲外",
  "作品が存在しません(削除済みの可能性)"
];

function buildCompletionTimestamp_() {
  const now = new Date();
  const formatted = Utilities.formatDate(now, CONFIG.TIMEZONE, "yyyy-MM-dd HH:mm:ss");
  const weekday = ["日", "月", "火", "水", "木", "金", "土"][now.getDay()];
  return `${formatted}(${weekday})`;
}

function applyPvSheetRow_(sheet, row, fetched) {
  if (!fetched.ok) {
    if (PV_PERMANENT_ERROR_REASONS.indexOf(fetched.reason) !== -1) {
      // 確定エラー → 完了扱いにして、二度と処理しない
      sheet.getRange(row.sheetRow, 1).setValue(buildCompletionTimestamp_());
      sheet.getRange(row.sheetRow, 2).setValue("完了");
      sheet.getRange(row.sheetRow, 7).setValue(fetched.reason);
    } else {
      // 一時的な失敗 → ステータスは「未処理」のまま(次回リトライ)。
      // エラー原因欄にだけ参考情報を記録する。
      sheet.getRange(row.sheetRow, 7).setValue(fetched.reason);
    }
    return;
  }

  const newVal = fetched.value;
  const savedRaw = row.pvRaw;

  if (savedRaw === "") {
    sheet.getRange(row.sheetRow, 1).setValue(buildCompletionTimestamp_());
    sheet.getRange(row.sheetRow, 2).setValue("完了");
    sheet.getRange(row.sheetRow, 6).setValue(newVal);
    sheet.getRange(row.sheetRow, 7).setValue("");
    return;
  }

  const savedVal = Number(savedRaw);

  if (isNaN(savedVal)) {
    sheet.getRange(row.sheetRow, 1).setValue(buildCompletionTimestamp_());
    sheet.getRange(row.sheetRow, 2).setValue("完了");
    sheet.getRange(row.sheetRow, 7).setValue("保存値不正");
    return;
  }

  if (newVal > savedVal) {
    sheet.getRange(row.sheetRow, 1).setValue(buildCompletionTimestamp_());
    sheet.getRange(row.sheetRow, 2).setValue("完了");
    sheet.getRange(row.sheetRow, 6).setValue(newVal);
    sheet.getRange(row.sheetRow, 7).setValue("");
  } else if (newVal === savedVal) {
    sheet.getRange(row.sheetRow, 1).setValue(buildCompletionTimestamp_());
    sheet.getRange(row.sheetRow, 2).setValue("完了");
    sheet.getRange(row.sheetRow, 7).setValue("");
  } else {
    sheet.getRange(row.sheetRow, 1).setValue(buildCompletionTimestamp_());
    sheet.getRange(row.sheetRow, 2).setValue("完了");
    sheet.getRange(row.sheetRow, 7).setValue("PV減少");
  }
}
