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
 * ・データは常に時系列順(general_lastup  昇順)で記録されていくため、
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
 *
 * ■検索APIの取得範囲(末尾追従・動的打ち切り方式)
 * ・「検索結果」シート末尾(最終行)の更新日+時刻を、なろうAPI取得の
 *   lastup開始位置として使う(getSearchResultTailDateTime_())。
 * ・取得したページの中に「現在時刻からSEARCH_API_CUTOFF_MINUTES分以内」の
 *   更新日時が1件でもあれば、直近まで追いついたとみなして打ち切る。
 * ・無ければ、まだ追いついていないとみなして次ページ(st前進)を取得する。
 *   この継続は①プロセスあたりSEARCH_API_MAX_CONTINUOUS_FETCH回まで。
 * ・詳細な取得・打ち切りロジックは Common.gs の fetchSearchApiPages_() を参照。
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

  const tailDate = getSearchResultTailDateTime_();

  const fetchResult = fetchSearchApiPages_(tailDate);

  writeSearchApiFetchLogs_(fetchResult.pageResults, fetchResult.status);

  if (fetchResult.novels.length === 0) {
    console.log(`【検索API】取得データなし(status=${fetchResult.status})`);
    return;
  }

  const novelData = dedupeNovelsByNcode_(fetchResult.novels);

  novelData.sort((a, b) => {
    return new Date(a.general_lastup.replace(/-/g, "/")) -
           new Date(b.general_lastup.replace(/-/g, "/"));
  });

  // 同一の「更新日+時刻(分まで)」に何件投稿があったかを数える
  const countByDateTime = {};

  novelData.forEach(novel => {
    const dateStr = normalizeDateString_(novel.general_lastup.substring(0, 10));
    const timeStr = normalizeTimeString_(novel.general_lastup.substring(11, 16));
    const key = `${dateStr} ${timeStr}`;

    countByDateTime[key] = (countByDateTime[key] || 0) + 1;
  });

  const rows = novelData.map(novel => {
    const dateStr = normalizeDateString_(novel.general_lastup.substring(0, 10));
    const timeStr = normalizeTimeString_(novel.general_lastup.substring(11, 16));
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

  console.log(`【検索API】完了: ${rows.length}件 / 対象日付${uniqueDates.length}件 / TASK予約${reservedCount}件 / status=${fetchResult.status} / 打ち切り理由=${fetchResult.stopReason}`);

  // 検索APIタスクをwait状態へ遷移させる。待機時間はTASK_WAIT(min)列を参照する。
  const setWait = setTaskWaitByKey_(TASK_TRIGGER_KEY.FETCH_SEARCH_API);

  if (!setWait) {
    console.log("【検索API】TASK wait設定に失敗しました(検索間隔制御が効かない可能性があります)");
  }
}

function dedupeNovelsByNcode_(novels) {
  const byNcode = new Map();

  novels.forEach(novel => {
    const ncode = String(novel.ncode || "").trim();

    if (!ncode) {
      return;
    }

    const current = byNcode.get(ncode);

    if (!current) {
      byNcode.set(ncode, novel);
      return;
    }

    const currentDate = parseNarouUpdatedAt_(current.general_lastup);
    const nextDate = parseNarouUpdatedAt_(novel.general_lastup);

    if (!currentDate && nextDate) {
      byNcode.set(ncode, novel);
      return;
    }

    if (currentDate && nextDate && nextDate.getTime() > currentDate.getTime()) {
      byNcode.set(ncode, novel);
    }
  });

  return Array.from(byNcode.values());
}


// ============================
// 「検索結果」シート末尾(最終行)の「更新日+時刻」をDateオブジェクトで返す。
// ・シートが無い/データ行が無い/末尾の日付時刻が不正な場合は null。
// ・呼び出し側(fetchSearchApiPages_)は null の場合、
//   SEARCH_API_INITIAL_LOOKBACK_MINUTES分前を起点として扱う。
// ============================

function getSearchResultTailDateTime_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SEARCH_RESULT_SHEET_NAME);

  if (!sheet) {
    return null;
  }

  const lastRow = sheet.getLastRow();

  if (lastRow < 2) {
    return null;
  }

  const values = sheet.getRange(lastRow, 1, 1, 2).getDisplayValues()[0];
  const dateStr = values[0];
  const timeStr = values[1];

  if (!dateStr || !timeStr) {
    return null;
  }

  const dateObj = new Date(`${dateStr} ${timeStr}:00`.replace(/-/g, "/"));

  if (isNaN(dateObj.getTime())) {
    return null;
  }

  return dateObj;
}

function getOrCreateSearchApiFetchLogSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheetName = CONFIG.SEARCH_API_FETCH_LOG_SHEET_NAME || "検索API取得ログ";
  let sheet = ss.getSheetByName(sheetName);

  if (!sheet) {
    sheet = ss.insertSheet(sheetName);
    const headers = ["取得日時", "st", "取得件数", "最古更新日時", "最新更新日時", "status"];

    const headerRange = sheet.getRange(1, 1, 1, headers.length);
    sheet.getRange("A:F").setNumberFormat("@");
    headerRange.setValues([headers]);
    headerRange.setBackground("#FFFF00");
    headerRange.setFontWeight("bold");
    headerRange.setHorizontalAlignment("center");
  }

  return sheet;
}

function writeSearchApiFetchLogs_(pageResults, overallStatus) {
  if (!pageResults || pageResults.length === 0) {
    return;
  }

  const sheet = getOrCreateSearchApiFetchLogSheet_();
  const rows = pageResults.map(result => [
    result.fetchedAt || "",
    String(result.st || ""),
    String(result.count || 0),
    result.oldestUpdatedAt || "",
    result.newestUpdatedAt || "",
    result.status || ""
  ]);

  const nextRow = sheet.getLastRow() + 1;
  sheet.getRange(nextRow, 1, rows.length, 6).setValues(rows);

  if (overallStatus === "PARTIAL" || overallStatus === "ERROR") {
    const lastFetchedAt = rows[rows.length - 1][0];
    sheet.getRange(nextRow + rows.length, 1, 1, 6).setValues([[
      lastFetchedAt,
      "ALL",
      String(pageResults.reduce((sum, r) => sum + Number(r.count || 0), 0)),
      "",
      "",
      overallStatus
    ]]);
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
      const targetRange = sheet.getRange(existingSheetRow, 1, 1, row.length);
      // ★書き込み直前に文字列(@)形式を強制する。これが無いと、Sheetsが
      // "08:44"のような値を時刻として自動認識し、表示・格納が「8:44」
      // (先頭ゼロなし)になってしまう。末尾ウィンドウやTASK連携の
      // 文字列比較(yyyy-MM-dd HH:mm)はゼロ埋め前提のため、これが崩れると
      // 比較結果がおかしくなる。書き込む「その行だけ」に適用するので、
      // 他の既存行(まだ矯正していない古い行)には影響しない。
      targetRange.setNumberFormat("@");
      targetRange.setValues([row]);
      updatedCount++;
    } else {
      rowsToAppend.push(row);
      // 同じバッチ内で同じキーが複数回出てきても二重追加しないよう仮登録
      tail.index.set(key, -1);
    }
  });

  if (rowsToAppend.length > 0) {
    const startRow = sheet.getLastRow() + 1;
    const appendRange = sheet.getRange(startRow, 1, rowsToAppend.length, rowsToAppend[0].length);
    // ★新規追加行も同様に、書き込み直前に文字列(@)形式を強制する。
    appendRange.setNumberFormat("@");
    appendRange.setValues(rowsToAppend);
  }

  console.log(`【検索結果】更新:${updatedCount}件 / 新規追加:${rowsToAppend.length}件 / 記録済みスキップ:${skippedOldCount}件`);
}


// ============================
// 【手動実行専用・1回でよい】既存の「検索結果」シートで、A列(更新日)・
// B列(時刻)がSheetsによって日付/時刻値として自動認識され、
// 先頭ゼロなし("8:44"等)で表示・格納されてしまっている行を、
// 正しい "yyyy-MM-dd"/"HH:mm" の文字列へ矯正する。
//
// ★実行順序が重要: 先に現在の表示値(getDisplayValues、壊れていれば
// "8:44"のような状態)を読み切ってから、列の書式を文字列(@)へ変更し、
// 最後に正規化した文字列を書き戻す。この順序を逆にする(先に書式だけ
// 変えてしまう)と、既存の時刻セルが生の シリアル値のまま表示されて
// しまい、かえって壊れる。
//
// 実行手順: Apps Scriptエディタでこの関数を選択して1回実行するだけ。
// ============================

function repairSearchResultDateTimeFormat_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SEARCH_RESULT_SHEET_NAME);

  if (!sheet) {
    console.log("【検索結果】シートが見つかりません");
    return;
  }

  const lastRow = sheet.getLastRow();

  if (lastRow < 2) {
    console.log("【検索結果】データ行がありません");
    return;
  }

  const totalRows = lastRow - 1;
  const range = sheet.getRange(2, 1, totalRows, 2); // A列(更新日)・B列(時刻)

  // ①現在の表示値を先に読み切る(壊れていれば "8:44" のような状態のまま読める)
  const displayValues = range.getDisplayValues();

  // ②そのあとで列全体を文字列(@)形式へ矯正する
  sheet.getRange("A:H").setNumberFormat("@");

  // ③正規化(ゼロ埋め)した文字列を書き戻す
  const fixedValues = displayValues.map(row => [
    normalizeDateString_(row[0]),
    normalizeTimeString_(row[1])
  ]);

  range.setValues(fixedValues);

  console.log(`【検索結果】日付/時刻フォーマットを矯正しました: ${totalRows}行`);
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


// ============================
// 【バックフィル専用】過去の欠損期間のデータを、既存の「検索結果」シートの
// 正しい時系列位置へマージ挿入する。
//
// ■なぜ upsertSearchResultSheet_ を使えないか
// ・upsertSearchResultSheet_ は「末尾ウィンドウより古い日時は既に記録済み」
//   という前提でスキップする(シート肥大化対策)。バックフィルは
//   まさにその前提が成立しないケース(欠損=未記録の過去データ)なので、
//   そのまま渡すと skippedOldCount に吸われて書き込まれない。
// ・また、通常のupsertは新規行を必ず「末尾」に追加する。過去日時のデータを
//   末尾に追加すると、シート全体の時系列昇順という前提そのものが崩れ、
//   以後の末尾ウィンドウ判定が正しく機能しなくなる。
//
// ■やること
// ・行数が少ない前提の「検索結果」シート二分探索(getRowDateTimeKey_ /
//   findFirstRowWithKeyAtLeast_ / findFirstRowWithKeyGreaterThan_)で、
//   バックフィルしたい行の集合(rows。事前に日時昇順ソート済み)が
//   挿入されるべき範囲[insertStartRow, insertEndRowExclusive)を特定する。
// ・その範囲に既存行があれば(=部分的に記録済みだった場合)読み込み、
//   「更新日+時刻+NCODE」キーでマージ(一致すれば上書き、なければ新規)。
// ・マージ後の行数と元の範囲の行数の差分だけ insertRowsBefore/deleteRows
//   で行数を調整してから、まとめて書き戻す。
// ============================

function getRowDateTimeKey_(sheet, row) {
  const values = sheet.getRange(row, 1, 1, 2).getDisplayValues()[0];
  return `${values[0]} ${values[1]}`;
}

// [lowRow, highRow](1-indexed・両端含む)の範囲で、「dateStr timeStr」キーが
// targetKey 以上になる最初の行番号を二分探索で返す。
// 全部targetKeyより小さければ highRow+1 を返す(=その直後に挿入すればよい)。
function findFirstRowWithKeyAtLeast_(sheet, lowRow, highRow, targetKey) {
  let lo = lowRow;
  let hi = highRow + 1;

  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const rowKey = getRowDateTimeKey_(sheet, mid);

    if (rowKey < targetKey) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }

  return lo;
}

// targetKey より大きくなる最初の行番号を二分探索で返す。
function findFirstRowWithKeyGreaterThan_(sheet, lowRow, highRow, targetKey) {
  let lo = lowRow;
  let hi = highRow + 1;

  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const rowKey = getRowDateTimeKey_(sheet, mid);

    if (rowKey <= targetKey) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }

  return lo;
}

// rows: [更新日, 時刻, 投稿数, NCODE, 前回投稿時刻, PV数+0時間, PV数+1時間, 作品名] の配列。
// 事前ソート済みでなくてもよい(この関数の中でソートし直す)。
function mergeRowsIntoSearchResultSheet_(rows) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SEARCH_RESULT_SHEET_NAME);

  if (!sheet) {
    sheet = ss.insertSheet(SEARCH_RESULT_SHEET_NAME);
    setupSearchResultHeaders_(sheet);
  }

  if (!rows || rows.length === 0) {
    return { updatedCount: 0, insertedCount: 0 };
  }

  const sortedRows = rows.slice().sort((a, b) => {
    const keyA = `${a[0]} ${a[1]}`;
    const keyB = `${b[0]} ${b[1]}`;
    if (keyA < keyB) return -1;
    if (keyA > keyB) return 1;
    return 0;
  });

  const firstKey = `${sortedRows[0][0]} ${sortedRows[0][1]}`;
  const lastKey = `${sortedRows[sortedRows.length - 1][0]} ${sortedRows[sortedRows.length - 1][1]}`;

  const lastRow = sheet.getLastRow();

  if (lastRow < 2) {
    // シートが空 → そのまま2行目から書き込むだけでよい
    const range = sheet.getRange(2, 1, sortedRows.length, sortedRows[0].length);
    range.setNumberFormat("@");
    range.setValues(sortedRows);
    console.log(`【検索結果マージ】シートが空だったため${sortedRows.length}件を新規書き込み`);
    return { updatedCount: 0, insertedCount: sortedRows.length };
  }

  // ①二分探索で挿入範囲[insertStartRow, insertEndRowExclusive)を特定する
  const insertStartRow = findFirstRowWithKeyAtLeast_(sheet, 2, lastRow, firstKey);
  const insertEndRowExclusive = findFirstRowWithKeyGreaterThan_(sheet, 2, lastRow, lastKey);
  const overlapCount = Math.max(0, insertEndRowExclusive - insertStartRow);

  // ②その範囲に既に存在する行(=部分的に記録済みだった行)を読み込む
  const existingOverlapRows = overlapCount > 0
    ? sheet.getRange(insertStartRow, 1, overlapCount, 8).getValues()
    : [];

  // ③「更新日+時刻+NCODE」キーでマージ: 一致すれば上書き、なければ新規追加
  const mergedByKey = new Map();

  existingOverlapRows.forEach(row => {
    const key = buildSearchResultKey_(row[0], row[1], row[3]);
    mergedByKey.set(key, row);
  });

  let updatedCount = 0;
  let insertedCount = 0;

  sortedRows.forEach(newRow => {
    const key = buildSearchResultKey_(newRow[0], newRow[1], newRow[3]);

    if (mergedByKey.has(key)) {
      updatedCount++;
    } else {
      insertedCount++;
    }

    mergedByKey.set(key, newRow);
  });

  // ④マージ後の全行を「dateStr timeStr|NCODE」キーで再ソートする
  const mergedRows = Array.from(mergedByKey.values()).sort((a, b) => {
    const keyA = `${a[0]} ${a[1]}|${a[3]}`;
    const keyB = `${b[0]} ${b[1]}|${b[3]}`;
    if (keyA < keyB) return -1;
    if (keyA > keyB) return 1;
    return 0;
  });

  // ⑤既存範囲の行数とマージ後の行数の差分だけ行を増減してから書き込む
  const diff = mergedRows.length - overlapCount;

  if (diff > 0) {
    sheet.insertRowsBefore(insertStartRow, diff);
  } else if (diff < 0) {
    sheet.deleteRows(insertStartRow, -diff);
  }

  const writeRange = sheet.getRange(insertStartRow, 1, mergedRows.length, 8);
  writeRange.setNumberFormat("@");
  writeRange.setValues(mergedRows);

  console.log(`【検索結果マージ】挿入位置=${insertStartRow}行目 / 更新:${updatedCount}件 / 新規挿入:${insertedCount}件`);

  return { updatedCount: updatedCount, insertedCount: insertedCount };
}


// ============================
// 【手動実行用】過去の欠損期間を指定して、なろうAPIから取得し、
// 「検索結果」シートの正しい時系列位置へマージ挿入する。
//
// startDate, endDate: Dateオブジェクト。この範囲でlastupを指定して取得する
//   (endDateは固定値として使われ、通常運用のような「現在時刻」基準の
//   打ち切り判定は行わない。取得件数がlimに満たなくなったら終了する)。
// options (省略可): fetchSearchApiPages_ にそのまま渡す
//   (baseUrl / maxContinuousFetch / lim / intervalMs を上書きしたい場合)。
//   fixedEndDate は endDate から自動的に設定されるので指定不要。
// ============================

function backfillSearchResultForRange_(startDate, endDate, options) {
  if (!(startDate instanceof Date) || isNaN(startDate.getTime())) {
    throw new Error("【検索結果バックフィル】startDateが不正です");
  }

  if (!(endDate instanceof Date) || isNaN(endDate.getTime())) {
    throw new Error("【検索結果バックフィル】endDateが不正です");
  }

  if (startDate.getTime() >= endDate.getTime()) {
    throw new Error("【検索結果バックフィル】startDateはendDateより前である必要があります");
  }

  const fetchOptions = Object.assign(
    { maxContinuousFetch: 20 }, // 手動実行なので通常運用(4回)より多めに許容
    options || {},
    { fixedEndDate: endDate }
  );

  const fetchResult = fetchSearchApiPages_(startDate, fetchOptions);

  writeSearchApiFetchLogs_(fetchResult.pageResults, fetchResult.status);

  if (fetchResult.novels.length === 0) {
    console.log(`【検索結果バックフィル】取得データなし(status=${fetchResult.status} / 打ち切り理由=${fetchResult.stopReason})`);
    return { fetchedCount: 0, updatedCount: 0, insertedCount: 0, status: fetchResult.status, stopReason: fetchResult.stopReason };
  }

  const novelData = dedupeNovelsByNcode_(fetchResult.novels);

  novelData.sort((a, b) => {
    return new Date(a.general_lastup.replace(/-/g, "/")) -
           new Date(b.general_lastup.replace(/-/g, "/"));
  });

  const countByDateTime = {};

  novelData.forEach(novel => {
    const dateStr = normalizeDateString_(novel.general_lastup.substring(0, 10));
    const timeStr = normalizeTimeString_(novel.general_lastup.substring(11, 16));
    const key = `${dateStr} ${timeStr}`;

    countByDateTime[key] = (countByDateTime[key] || 0) + 1;
  });

  const rows = novelData.map(novel => {
    const dateStr = normalizeDateString_(novel.general_lastup.substring(0, 10));
    const timeStr = normalizeTimeString_(novel.general_lastup.substring(11, 16));
    const key = `${dateStr} ${timeStr}`;

    return [
      dateStr,
      timeStr,
      countByDateTime[key],
      novel.ncode,
      "",
      "",
      "",
      novel.title
    ];
  });

  const mergeResult = mergeRowsIntoSearchResultSheet_(rows);

  // 対象日付ごとに「日付シート作成」を積む(通常フローと同様)
  const uniqueDates = Array.from(new Set(rows.map(row => row[0])));
  let reservedCount = 0;

  uniqueDates.forEach(dateStr => {
    if (reserveTaskByKeyPrefix_(TASK_TRIGGER_PREFIX.UPDATE_DAY, dateStr)) {
      reservedCount++;
    }
  });

  console.log(`【検索結果バックフィル】完了: 取得${rows.length}件 / 更新${mergeResult.updatedCount}件 / 新規挿入${mergeResult.insertedCount}件 / 対象日付${uniqueDates.length}件 / TASK予約${reservedCount}件 / status=${fetchResult.status} / 打ち切り理由=${fetchResult.stopReason}`);

  return {
    fetchedCount: rows.length,
    updatedCount: mergeResult.updatedCount,
    insertedCount: mergeResult.insertedCount,
    status: fetchResult.status,
    stopReason: fetchResult.stopReason
  };
}