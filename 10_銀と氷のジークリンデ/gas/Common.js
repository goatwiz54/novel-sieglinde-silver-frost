/**********************************************************************
 * Common.gs (旧: コード.gs)　test
 *
 * 全命令から共有される、本当に汎用的な処理だけを置く。
 * ・設定値(CONFIG)
 * ・日付/時刻の正規化
 * ・日別シート名の生成・検索
 * ・月別ファイルの取得/作成
 *
 * 「日別シートの読み書き」は DailySheetIO.gs へ、
 * 「サマリシート」は SummaryCommand.gs へ、それぞれ分離済み。
 *
 * ■処理の起点・流れはQueManager.gs以下を参照:
 *     enqueueFetchApiTrigger (15分トリガー) → QUEに「検索API叩け」を積む
 *     queWorkerTrigger       (1分トリガー)  → QUEの先頭1件を処理する
 *       検索API叩け     → SearchApiCommand.gs
 *       日付シート作成   → DailySheetCommand.gs
 *       サマリ更新       → SummaryCommand.gs
 *       10分集計         → TenMinuteQueCommand.gs / TenMinuteUpdater.gs
 *       PV取得           → PvSheetFetchCommand.gs / PvGetter.gs
 * ・旧・15分ごとの一括処理(fetchAndRecordNarouData)はQUE方式に置き換わり
 *   廃止済み(「解析」シート・AnalysisLog.gsも同様に廃止)。
 *
 * ■重要
 * ・月別ファイルは DriveApp.makeCopy()(ファイルごとコピー)ではなく、
 *   SpreadsheetApp.create() + Sheet.copyTo() でシート単位に複製して作る。
 *   makeCopy()だとテンプレートに紐づいたAppsScriptプロジェクトまで
 *   複製されてしまい、使われない不要なコピーが量産されるため。
 *
 * ■日別シート名
 *   "MM月DD日(曜)" 形式(例: 07月06日(月))。曜日は日またぎ判定にも使う
 *   前日シート名などと合わせて buildSheetKeyFromDate_() で統一生成する。
 *
 * ■シートの並び順
 *   スクリプト側では並び替えを一切行わない。サマリ・10分集計の
 *   位置はテンプレートのまま維持され、日別シートは新規作成のたびに
 *   末尾へ追加されていく(insertSheetのデフォルト挙動)。
 *
 * ■検索APIのページング方式(動的・末尾追従型)
 * ・以前は SEARCH_API_START_LIST に固定した st の並びを毎回全部叩いていたが、
 *   「検索結果」シート末尾の更新日時から取得すべき範囲(lastup)を組み立て、
 *   取得データが現在時刻の直近(SEARCH_API_CUTOFF_MINUTES分以内)に届いたら
 *   打ち切る方式に変更した。詳細は fetchSearchApiPages_() を参照。
 * ・fetchSearchApiPages_() は options でバックフィル(過去の欠損期間取得)にも
 *   対応している(fixedEndDate指定時)。詳細は同関数のコメントを参照。
 **********************************************************************/


// ============================
// 設定
// ============================

const CONFIG = {
  TARGET_FOLDER_ID: "1qyJSUQBLVuEYwpuoQr058pYJwdXdKjVN",

  // ★ここをテンプレートファイルIDに差し替える
  TEMPLATE_FILE_ID: "1oRo_dCG_JX5TvkvcCfC6BnTyto38aC7p9wExElvpP2A",

  TEMPLATE_NAME: "銀と氷のジークリンデ・なろうPV分析テンプレート",

  FILE_PREFIX: "なろう・更新日別PV解析",

  SUMMARY_SHEET_NAME: "サマリ",
  TEN_MINUTE_SHEET_NAME: "10分集計",

  LIMIT_DATE: "2026/12/31 23:59:59",

  // st・lastupは毎回 fetchSearchApiPages_() が動的に組み立てて上書きするため、
  // ここには付けない(order・lim・ofなど固定パラメータのみ)。
  API_URL: "https://api.syosetu.com/novelapi/api/?out=json&order=old&lim=500&of=n-t-gl",

  // 検索APIの1ページあたりの取得件数(なろうAPIの lim と一致させる)
  SEARCH_API_LIM: 500,

  // 「検索結果」シート末尾の更新日時から取得ページの st を進めつつ、
  // 現在時刻からSEARCH_API_CUTOFF_MINUTES分以内のデータが取れたら打ち切る。
  SEARCH_API_CUTOFF_MINUTES: 10,

  // 1回の処理(①プロセス)内で連続取得してよい最大ページ数
  SEARCH_API_MAX_CONTINUOUS_FETCH: 4,

  // 「検索結果」シートがまだ空(初回実行等)の場合の、lastup開始位置の初期値(分)
  SEARCH_API_INITIAL_LOOKBACK_MINUTES: 60,

  SEARCH_API_PAGE_INTERVAL_MS: 30000,
  SEARCH_API_FETCH_LOG_SHEET_NAME: "検索API取得ログ",

  TIMEZONE: "Asia/Tokyo",

  // 同一NCODEを「同時刻投稿(前回投稿時刻あり)」とみなす閾値(分)
  SAME_NCODE_THRESHOLD_MINUTES: 60,

  // ★PV取得(PvGetter)を一時停止したい時は false にする
  //   falseの間は検索結果の取得・日別シート更新・サマリ更新は通常通り動作し、
  //   PV(E・F列)取得だけをスキップする(既存の値・エラー表記もそのまま維持される)
  PV_FETCH_ENABLED: false,

  // ★サマリのヒートマップ配色。"blue"(白→青の単色グラデーション)か
  //   "rainbow"(青→赤の虹色グラデーション。0件=白、高いほど赤)を選べる。
  HEATMAP_STYLE: "blue"
};


// ============================
// 日付(Dateオブジェクト)から「MM月DD日(曜)」形式のシート名を作る
// ============================

function buildSheetKeyFromDate_(dateObj) {
  const month = Utilities.formatDate(dateObj, CONFIG.TIMEZONE, "MM");
  const day = Utilities.formatDate(dateObj, CONFIG.TIMEZONE, "dd");

  // "u"はISO 8601の曜日番号(1=月曜〜7=日曜)。タイムゾーンをまたぐ誤差を避けるため
  // Date#getDay()ではなくUtilities.formatDateで算出する。
  const isoDow = parseInt(Utilities.formatDate(dateObj, CONFIG.TIMEZONE, "u"), 10);
  const weekdayMap = ["月", "火", "水", "木", "金", "土", "日"];
  const weekday = weekdayMap[isoDow - 1];

  return `${month}月${day}日(${weekday})`;
}


// ============================
// 「MM月DD日」部分(曜日なし)のプレフィックスを作る
// ============================

function buildSheetKeyPrefix_(dateObj) {
  const month = Utilities.formatDate(dateObj, CONFIG.TIMEZONE, "MM");
  const day = Utilities.formatDate(dateObj, CONFIG.TIMEZONE, "dd");

  return `${month}月${day}日`;
}


// ============================
// 日付プレフィックス("MM月DD日")で既存の日別シートを探す。
// 旧命名(曜日なし)・新命名(曜日あり)のどちらでも見つけられる。
// 見つからなければ null。
// ============================

function findExistingDailySheet_(spreadsheet, dateObj) {
  const prefix = buildSheetKeyPrefix_(dateObj);
  const sheets = spreadsheet.getSheets();

  for (let i = 0; i < sheets.length; i++) {
    if (sheets[i].getName().indexOf(prefix) === 0) {
      return sheets[i];
    }
  }

  return null;
}


// ============================
// 月別ファイル取得・なければテンプレートコピー
// ============================

function getOrCreateMonthlySpreadsheet(fileKey) {
  const spreadSheetName = `${CONFIG.FILE_PREFIX} ${fileKey}`;
  const targetFolder = DriveApp.getFolderById(CONFIG.TARGET_FOLDER_ID);

  const files = targetFolder.getFilesByName(spreadSheetName);

  if (files.hasNext()) {
    const spreadsheet = SpreadsheetApp.open(files.next());
    ensureTenMinuteEditTrigger_(spreadsheet.getId());
    ensureSummaryEditTrigger_(spreadsheet.getId());
    return spreadsheet;
  }

  console.log(`月別ファイルがないためテンプレートからシート単位でコピー作成: ${spreadSheetName}`);

  const spreadsheet = createMonthlySpreadsheetFromTemplate_(spreadSheetName, targetFolder);

  ensureTenMinuteEditTrigger_(spreadsheet.getId());
  ensureSummaryEditTrigger_(spreadsheet.getId());

  return spreadsheet;
}


// ============================
// テンプレートからシート単位でコピーして月別ファイルを作る。
//
// ★DriveApp.makeCopy()(ファイルごとコピー)は使わない。
// makeCopy()だとテンプレートに紐づいたAppsScriptプロジェクトまで
// 複製されてしまい、使われない不要なコピーが量産されるため。
//
// 代わりに SpreadsheetApp.create() で空のファイルを作り、
// テンプレートの各シートを Sheet.copyTo() で1枚ずつ複製する。
// この方法ならAppsScriptは一切付いてこない。
// ============================

function createMonthlySpreadsheetFromTemplate_(spreadSheetName, targetFolder) {
  const templateSpreadsheet = SpreadsheetApp.openById(CONFIG.TEMPLATE_FILE_ID);

  const newSpreadsheet = SpreadsheetApp.create(spreadSheetName);

  // 新規作成時にできるデフォルトシート(後で削除するため名前を覚えておく)
  const defaultSheetNames = newSpreadsheet.getSheets().map(s => s.getName());

  // テンプレートの全シートを、並び順通りに1枚ずつコピーする
  templateSpreadsheet.getSheets().forEach(sheet => {
    const originalName = sheet.getName();
    const copiedSheet = sheet.copyTo(newSpreadsheet);

    copiedSheet.setName(originalName);
  });

  // 新規作成時にできた空のデフォルトシートを削除する
  defaultSheetNames.forEach(name => {
    const defaultSheet = newSpreadsheet.getSheetByName(name);

    if (defaultSheet) {
      newSpreadsheet.deleteSheet(defaultSheet);
    }
  });

  // マイドライブ直下にできるので、目的のフォルダへ移動する
  const file = DriveApp.getFileById(newSpreadsheet.getId());
  targetFolder.addFile(file);
  DriveApp.getRootFolder().removeFile(file);

  return newSpreadsheet;
}


// ============================
// 月別ファイルが存在する場合のみ取得(作成しない)
// 前日シート参照など「無ければ何もしない」用途で使用
// ============================

function findMonthlySpreadsheetIfExists_(fileKey) {
  const spreadSheetName = `${CONFIG.FILE_PREFIX} ${fileKey}`;
  const targetFolder = DriveApp.getFolderById(CONFIG.TARGET_FOLDER_ID);

  const files = targetFolder.getFilesByName(spreadSheetName);

  if (files.hasNext()) {
    return SpreadsheetApp.open(files.next());
  }

  return null;
}


// ============================
// 日付を yyyy-MM-dd に正規化
// ============================

function normalizeDateString_(value) {
  if (value instanceof Date) {
    return Utilities.formatDate(value, CONFIG.TIMEZONE, "yyyy-MM-dd");
  }

  const s = String(value).trim();

  const match = s.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);

  if (match) {
    return `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
  }

  const d = new Date(s);

  if (!isNaN(d.getTime())) {
    return Utilities.formatDate(d, CONFIG.TIMEZONE, "yyyy-MM-dd");
  }

  return s;
}


// ============================
// 時刻を HH:mm に正規化
// ============================

function normalizeTimeString_(value) {
  if (value instanceof Date) {
    return Utilities.formatDate(value, CONFIG.TIMEZONE, "HH:mm");
  }

  const s = String(value).trim();

  const match = s.match(/^(\d{1,2}):(\d{2})/);

  if (match) {
    const h = match[1].padStart(2, "0");
    const m = match[2];
    return `${h}:${m}`;
  }

  return s;
}


// ============================
// HH:mm を分に変換
// ============================

function timeToMinute_(timeStr) {
  const time = normalizeTimeString_(timeStr);

  const hour = parseInt(time.substring(0, 2), 10);
  const minute = parseInt(time.substring(3, 5), 10);

  return hour * 60 + minute;
}


// ============================
// 検索APIのページング取得(末尾追従・動的打ち切り方式)
//
// ・「検索結果」シート末尾の更新日+時刻を起点(lastup開始)とし、
//   終了は毎回そのときの「現在時刻」までを指定して取得する。
// ・st は 1, 1+lim, 1+2*lim, ... と進め、なろうAPIのページングに従う。
// ・取得したページの中に「現在時刻から SEARCH_API_CUTOFF_MINUTES 分以内」の
//   更新日時を持つ作品が1件でもあれば、直近まで追いついたとみなして打ち切る。
// ・見つからなければ、まだ古いデータの続きとみなして次ページ(st前進)を取得する。
// ・この「見つからないので継続」は SEARCH_API_MAX_CONTINUOUS_FETCH 回まで
//   (①プロセス内での連続取得上限)。
// ・取得件数がlim未満だった場合は、その先にデータが存在しないのでそこで打ち切る。
// ============================

function stripQueryParam_(url, paramName) {
  return String(url || "")
    .replace(new RegExp(`([?&])${paramName}=[^&]*(&|$)`), "$1")
    .replace(/[?&]$/, "");
}

// baseUrlOverride: 省略時は CONFIG.API_URL を使う。バックフィル等で
// 別のベースURLを明示的に使いたい場合に渡す。
function buildSearchApiUrl_(start, lastupStartEpoch, lastupEndEpoch, baseUrlOverride) {
  let baseUrl = stripQueryParam_(baseUrlOverride || CONFIG.API_URL, "st");
  baseUrl = stripQueryParam_(baseUrl, "lastup");

  const separator = baseUrl.indexOf("?") === -1 ? "?" : "&";

  return `${baseUrl}${separator}st=${start}&lastup=${lastupStartEpoch}-${lastupEndEpoch}`;
}

function parseNarouUpdatedAt_(value) {
  const s = String(value || "").trim();

  if (!s) return null;

  const d = new Date(s.replace(/-/g, "/"));

  if (isNaN(d.getTime())) return null;

  return d;
}

function buildUpdatedAtRange_(novels) {
  if (!novels || novels.length === 0) {
    return { oldest: "", newest: "" };
  }

  let oldestDate = null;
  let newestDate = null;

  novels.forEach(novel => {
    const d = parseNarouUpdatedAt_(novel.general_lastup);

    if (!d) return;

    if (!oldestDate || d.getTime() < oldestDate.getTime()) {
      oldestDate = d;
    }

    if (!newestDate || d.getTime() > newestDate.getTime()) {
      newestDate = d;
    }
  });

  const oldest = oldestDate ? Utilities.formatDate(oldestDate, CONFIG.TIMEZONE, "yyyy-MM-dd HH:mm:ss") : "";
  const newest = newestDate ? Utilities.formatDate(newestDate, CONFIG.TIMEZONE, "yyyy-MM-dd HH:mm:ss") : "";

  return { oldest: oldest, newest: newest };
}

// start: st(表示開始位置) / lastupStartEpoch,lastupEndEpoch: lastup範囲(UNIX秒)
// baseUrlOverride: 省略時は CONFIG.API_URL
function fetchSearchApiPageByStart_(start, lastupStartEpoch, lastupEndEpoch, baseUrlOverride) {
  const fetchedAt = Utilities.formatDate(new Date(), CONFIG.TIMEZONE, "yyyy-MM-dd HH:mm:ss");
  const url = buildSearchApiUrl_(start, lastupStartEpoch, lastupEndEpoch, baseUrlOverride);

  try {
    const response = UrlFetchApp.fetch(url);
    const json = JSON.parse(response.getContentText());

    if (!Array.isArray(json)) {
      throw new Error("レスポンス形式が配列ではありません");
    }

    const novels = json.slice(1);
    const count = novels.length;
    const range = buildUpdatedAtRange_(novels);

    return {
      fetchedAt: fetchedAt,
      st: start,
      count: count,
      oldestUpdatedAt: range.oldest,
      newestUpdatedAt: range.newest,
      status: count >= 500 ? "LIMIT500" : "OK",
      novels: novels,
      error: ""
    };
  } catch (err) {
    return {
      fetchedAt: fetchedAt,
      st: start,
      count: 0,
      oldestUpdatedAt: "",
      newestUpdatedAt: "",
      status: "ERROR",
      novels: [],
      error: String(err && err.message ? err.message : err)
    };
  }
}

// tailDate: 取得開始位置(lastup開始)にするDateオブジェクト。
//           通常運用では「検索結果」シート末尾の更新日+時刻を渡す。
//           null の場合は SEARCH_API_INITIAL_LOOKBACK_MINUTES 分前を起点にする。
//
// options (省略可):
//   baseUrl             … CONFIG.API_URL の代わりに使うベースURL
//   fixedEndDate        … lastup終了を「現在時刻」ではなくこのDateに固定する。
//                          ★過去の欠損期間をバックフィル取得する時に指定する。
//                          指定した場合、現在時刻ベースの打ち切り判定(CUTOFF)は
//                          行わない(過去データには「直近に追いついたか」という
//                          概念が無いため)。取得件数がlim未満になったら
//                          (=その先にデータが無い)打ち切る。
//   maxContinuousFetch  … 1回の呼び出しで連続取得してよい最大ページ数。
//                          省略時はCONFIG.SEARCH_API_MAX_CONTINUOUS_FETCH。
//                          手動バックフィルは実行時間に余裕があるので、
//                          大きめの値を指定してよい。
//   lim                 … 1ページの取得件数。省略時はCONFIG.SEARCH_API_LIM。
//   intervalMs          … ページ間のスリープ時間(ms)。省略時はCONFIG設定値。
function fetchSearchApiPages_(tailDate, options) {
  options = options || {};

  const lim = Number(options.lim || CONFIG.SEARCH_API_LIM || 500);
  const maxContinuousFetch = Number(options.maxContinuousFetch || CONFIG.SEARCH_API_MAX_CONTINUOUS_FETCH || 4);
  const cutoffMinutes = Number(CONFIG.SEARCH_API_CUTOFF_MINUTES || 10);
  const intervalMs = Number(options.intervalMs != null ? options.intervalMs : (CONFIG.SEARCH_API_PAGE_INTERVAL_MS || 0));
  const lookbackMinutes = Number(CONFIG.SEARCH_API_INITIAL_LOOKBACK_MINUTES || 60);
  const baseUrl = options.baseUrl || null;

  const startDate = tailDate || new Date(Date.now() - lookbackMinutes * 60 * 1000);
  const lastupStartEpoch = Math.floor(startDate.getTime() / 1000);

  const isBackfillMode = options.fixedEndDate instanceof Date && !isNaN(options.fixedEndDate.getTime());
  const fixedEndEpoch = isBackfillMode ? Math.floor(options.fixedEndDate.getTime() / 1000) : null;

  const pageResults = [];
  let stopReason = "";

  for (let i = 0; i < maxContinuousFetch; i++) {
    const st = 1 + i * lim;

    // 通常運用: 「終了」は毎回そのときの現在時刻まで(取得範囲を常に最新へ追従させる)。
    // バックフィルモード: 呼び出し元が指定した固定の終了時刻を使う。
    const endEpoch = isBackfillMode ? fixedEndEpoch : Math.floor(Date.now() / 1000);

    console.log(`Fetching search API page (st=${st}, lastup=${lastupStartEpoch}-${endEpoch}${isBackfillMode ? " [backfill]" : ""})...`);
    const pageResult = fetchSearchApiPageByStart_(st, lastupStartEpoch, endEpoch, baseUrl);
    pageResults.push(pageResult);

    if (pageResult.status === "ERROR") {
      stopReason = "ERROR";
      break;
    }

    if (!isBackfillMode) {
      // 現在時刻からcutoffMinutes分以内の更新データが1件でもあれば、
      // 直近まで追いついたとみなして打ち切る(バックフィルモードでは行わない)
      const cutoffThresholdMs = Date.now() - cutoffMinutes * 60 * 1000;

      const hasRecentData = pageResult.novels.some(novel => {
        const d = parseNarouUpdatedAt_(novel.general_lastup);
        return d && d.getTime() >= cutoffThresholdMs;
      });

      if (hasRecentData) {
        stopReason = "CUTOFF";
        break;
      }
    }

    if (pageResult.count < lim) {
      // 取得件数がlim未満 = この先(次ページ)にはもうデータが無い
      stopReason = "NO_MORE_DATA";
      break;
    }

    const isLast = (i === maxContinuousFetch - 1);

    if (isLast) {
      stopReason = "MAX_CONTINUOUS_FETCH";
    } else if (intervalMs > 0) {
      Utilities.sleep(intervalMs);
    }
  }

  console.log(`【検索API】ページ取得終了: 理由=${stopReason} / 取得ページ数=${pageResults.length}`);

  const novels = [];

  pageResults.forEach(result => {
    result.novels.forEach(novel => novels.push(novel));
  });

  const hasError = pageResults.some(result => result.status === "ERROR");

  let overallStatus = "OK";

  if (hasError && novels.length === 0) {
    overallStatus = "ERROR";
  } else if (hasError) {
    overallStatus = "PARTIAL";
  }

  return {
    pageResults: pageResults,
    novels: novels,
    status: overallStatus,
    stopReason: stopReason
  };
}