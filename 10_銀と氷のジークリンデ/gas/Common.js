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

//  API_URL: "https://api.syosetu.com/novelapi/api/?out=json&order=new&lim=500",
  API_URL: "https://api.syosetu.com/novelapi/api/?out=json&order=old&lim=500&lastup=1783568400-1783609199&of=n-t-gl",
  SEARCH_API_START_LIST: [1, 500, 1000, 1501, 2001, 2501, 3001, 3501],
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
// 検索APIのページング取得
// st=1,251,501,751 などを順番に取得し、ページごとの状態を返す
// ============================

function buildSearchApiUrlByStart_(start) {
  const baseUrl = String(CONFIG.API_URL || "").replace(/([?&])st=\d+(&|$)/, "$1").replace(/[?&]$/, "");
  const separator = baseUrl.indexOf("?") === -1 ? "?" : "&";

  return `${baseUrl}${separator}st=${start}`;
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

function fetchSearchApiPageByStart_(start) {
  const fetchedAt = Utilities.formatDate(new Date(), CONFIG.TIMEZONE, "yyyy-MM-dd HH:mm:ss");
  const url = buildSearchApiUrlByStart_(start);

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

function fetchSearchApiPages_() {
  const starts = (CONFIG.SEARCH_API_START_LIST && CONFIG.SEARCH_API_START_LIST.length > 0)
    ? CONFIG.SEARCH_API_START_LIST
    : [1, 501, 1001, 1501, 2001, 2501, 3001, 3501];
  const intervalMs = Number(CONFIG.SEARCH_API_PAGE_INTERVAL_MS || 0);
  const pageResults = [];

  for (let i = 0; i < starts.length; i++) {
    const start = starts[i];
    console.log(`Fetching search API page starting at ${start}...`);
    pageResults.push(fetchSearchApiPageByStart_(start));

    const isLast = (i === starts.length - 1);

    if (!isLast && intervalMs > 0) {
      Utilities.sleep(intervalMs);
    }
  }

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
    status: overallStatus
  };
}