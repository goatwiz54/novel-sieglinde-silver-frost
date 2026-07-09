/**********************************************************************
 * SearchApiCommand.gs
 *
 * QUE命令「検索API叩け」の実処理。
 *
 * ■やること
 * ・なろうAPIから最新更新を取得する
 * ・「検索結果」シート(親子構造ではないフラットな表)へ書き込む
 *     更新日 | 時刻 | 投稿数 | NCODE | 前回投稿時刻 | PV数+0時間 | PV数+1時間 | 作品名
 *   のうち、前回投稿時刻・PV数+0時間・PV数+1時間はこの時点では空欄
 *   (後工程の「日付シート作成」「PV取得」で埋める)。
 *   投稿数は「同じ更新日+時刻(分まで)に何件投稿があったか」を
 *   その行にそのまま複製して入れる(参考値。親子構造化は日付シート側で行う)。
 *
 * ■「検索結果」シートはDB化(クリアしない)
 * ・クリアはせず、既存データはすべて残す。
 * ・「更新日+時刻+NCODE」が一致する行が既にあれば、その行を上書きする。
 * ・一致する行が無ければ、末尾に新規追加する。
 * ・つまり「更新日+時刻+NCODE」が複合主キーの、追記型テーブルになる。
 *
 * ■末尾ウィンドウ方式(シート肥大化への対策)
 * ・データは常に時系列順(novelupdated_at昇順)で記録されていくため、
 *   シート全体をインデックス化する必要はない。
 * ・末尾の直近 SEARCH_RESULT_TAIL_WINDOW 件だけを読み、その中の
 *   最小の「更新日+時刻」を基準にする。
 * ・新規取得データのうち、その基準より古い(更新日+時刻が小さい)行は
 *   「過去の実行で必ず記録済み」とみなし、比較すらせずスキップする。
 * ・基準以上の行だけを、末尾ウィンドウのインデックスと照合して
 *   上書き/追加を判定する。
 * ・これにより、シートが何万行に増えても、1回の処理コストは
 *   ウィンドウサイズ分でほぼ一定に保たれる。
 *
 * ・取得データに含まれる対象日付ごとに「日付シート作成」をQUEへ積む
 *   (優先度は全部ベース値のまま積む。並べ替え・採番はワーカー側が行う)
 **********************************************************************/


const SEARCH_RESULT_SHEET_NAME = "検索結果";

// なろうAPIの取得件数(最大500)に対する安全マージンとして2倍を見る
const SEARCH_RESULT_TAIL_WINDOW = 1000;


// ============================
// 「検索API叩け」の実処理本体
// ============================

function processFetchApiCommand_() {
  const now = new Date();
  const limitDate = new Date(CONFIG.LIMIT_DATE);

  if (now > limitDate) {
    console.log("【検索API】運用期間終了のためスキップ");
    return;
  }

  const response = UrlFetchApp.fetch(CONFIG.API_URL);
  const json = JSON.parse(response.getContentText());

  if (json.length <= 1) {
    console.log("【検索API】取得データなし");
    return;
  }

  const novelData = json.slice(1);

  novelData.sort((a, b) => {
    return new Date(a.novelupdated_at.replace(/-/g, "/")) -
           new Date(b.novelupdated_at.replace(/-/g, "/"));
  });

  // 同一の「更新日+時刻(分まで)」に何件投稿があったかを数える
  const countByDateTime = {};

  novelData.forEach(novel => {
    const dateStr = normalizeDateString_(novel.novelupdated_at.substring(0, 10));
    const timeStr = normalizeTimeString_(novel.novelupdated_at.substring(11, 16));
    const key = `${dateStr} ${timeStr}`;

    countByDateTime[key] = (countByDateTime[key] || 0) + 1;
  });

  const rows = novelData.map(novel => {
    const dateStr = normalizeDateString_(novel.novelupdated_at.substring(0, 10));
    const timeStr = normalizeTimeString_(novel.novelupdated_at.substring(11, 16));
    const key = `${dateStr} ${timeStr}`;

    return [
      dateStr,
      timeStr,
      countByDateTime[key],
      novel.ncode,
      "", // 前回投稿時刻 → 後工程(日付シート作成)で埋める
      "", // PV数+0時間  → 後工程(PV取得)で埋める
      "", // PV数+1時間  → 後工程(PV取得)で埋める
      novel.title
    ];
  });

  upsertSearchResultSheet_(rows);

  // 対象日付ごとに「日付シート作成」を積む
  const uniqueDates = Array.from(new Set(rows.map(row => row[0])));

  let reservedCount = 0;

  uniqueDates.forEach(dateStr => {
    if (reserveTaskByKeyPrefix_(TASK_TRIGGER_PREFIX.UPDATE_DAY, dateStr)) {
      reservedCount++;
    }
  });

  console.log(`【検索API】完了: ${rows.length}件 / 対象日付${uniqueDates.length}件 / TASK予約${reservedCount}件`);

  // 検索APIタスクをwait状態へ遷移させる。待機時間はTASK_WAIT(min)列を参照する。
  const setWait = setTaskWaitByKey_(TASK_TRIGGER_KEY.FETCH_SEARCH_API);

  if (!setWait) {
    console.log("【検索API】TASK wait設定に失敗しました(検索間隔制御が効かない可能性があります)");
  }
}


// ============================
// 「検索結果」シートへUPSERTする(クリアしない・DB化)。
//
// ・「更新日+時刻+NCODE」が一致する既存行があれば、その行を上書き
// ・無ければ末尾に新規追加
// ・比較対象は末尾ウィンドウ(直近 SEARCH_RESULT_TAIL_WINDOW 件)だけ。
//   それより古い時刻のデータは「既に記録済み」とみなしスキップする。
// ============================

function upsertSearchResultSheet_(rows) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SEARCH_RESULT_SHEET_NAME);

  if (!sheet) {
    sheet = ss.insertSheet(SEARCH_RESULT_SHEET_NAME);
    setupSearchResultHeaders_(sheet);
  }

  const tail = buildSearchResultTailIndex_(sheet);

  const rowsToAppend = [];
  let updatedCount = 0;
  let skippedOldCount = 0;

  rows.forEach(row => {
    const dateTimeKey = `${row[0]} ${row[1]}`; // "yyyy-MM-dd HH:mm" は文字列比較でそのまま時系列順になる

    if (tail.minDateTimeKey !== null && dateTimeKey < tail.minDateTimeKey) {
      // 末尾ウィンドウの最小時刻より古い → 過去の実行で必ず記録済み。
      // 比較すら行わずスキップする(シートが大きくなっても遅くならない)。
      skippedOldCount++;
      return;
    }

    const key = buildSearchResultKey_(row[0], row[1], row[3]);
    const existingSheetRow = tail.index.get(key);

    if (existingSheetRow) {
      sheet.getRange(existingSheetRow, 1, 1, row.length).setValues([row]);
      updatedCount++;
    } else {
      rowsToAppend.push(row);
      // 同じバッチ内で同じキーが複数回出てきても二重追加しないよう仮登録
      tail.index.set(key, -1);
    }
  });

  if (rowsToAppend.length > 0) {
    const startRow = sheet.getLastRow() + 1;
    sheet.getRange(startRow, 1, rowsToAppend.length, rowsToAppend[0].length).setValues(rowsToAppend);
  }

  console.log(`【検索結果】更新:${updatedCount}件 / 新規追加:${rowsToAppend.length}件 / 記録済みスキップ:${skippedOldCount}件`);
}


// ============================
// 「検索結果」シートのヘッダーを設定する(シート新規作成時のみ呼ばれる)
// ============================

function setupSearchResultHeaders_(sheet) {
  const headers = [
    "更新日", "時刻", "投稿数", "NCODE",
    "前回投稿時刻", "PV数+0時間", "PV数+1時間", "作品名"
  ];

  sheet.getRange("A:H").setNumberFormat("@");

  const headerRange = sheet.getRange(1, 1, 1, headers.length);
  headerRange.setValues([headers]);
  headerRange.setBackground("#FFFF00");
  headerRange.setFontWeight("bold");
  headerRange.setHorizontalAlignment("center");
}


// ============================
// 「検索結果」シートの末尾ウィンドウ(直近SEARCH_RESULT_TAIL_WINDOW件)だけを
// 読み込み、「更新日+時刻+NCODE」→ シート行番号 のインデックスと、
// そのウィンドウ内の最小「更新日+時刻」を作る。
//
// シート全体を読まないので、シートがどれだけ大きくなっても
// 処理コストはウィンドウサイズ分でほぼ一定に保たれる。
// ============================

function buildSearchResultTailIndex_(sheet) {
  const lastRow = sheet.getLastRow();

  if (lastRow < 2) {
    return { minDateTimeKey: null, index: new Map() };
  }

  const totalDataRows = lastRow - 1;
  const windowSize = Math.min(totalDataRows, SEARCH_RESULT_TAIL_WINDOW);
  const windowStartRow = lastRow - windowSize + 1;

  const values = sheet.getRange(windowStartRow, 1, windowSize, 8).getDisplayValues();

  const index = new Map();
  let minDateTimeKey = null;

  values.forEach((row, idx) => {
    const dateTimeKey = `${row[0]} ${row[1]}`;
    const key = buildSearchResultKey_(row[0], row[1], row[3]);

    index.set(key, windowStartRow + idx);

    if (minDateTimeKey === null || dateTimeKey < minDateTimeKey) {
      minDateTimeKey = dateTimeKey;
    }
  });

  return { minDateTimeKey: minDateTimeKey, index: index };
}


// ============================
// 「更新日+時刻+NCODE」から複合キーを作る
// ============================

function buildSearchResultKey_(dateStr, timeStr, ncode) {
  return `${dateStr}|${timeStr}|${ncode}`;
}