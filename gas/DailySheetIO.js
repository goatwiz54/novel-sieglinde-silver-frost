/**********************************************************************
 * DailySheetIO.gs
 *
 * 日別シートの読み込み・前回投稿時刻の計算・書き込みをまとめたもの。
 * 呼び出し元: DailySheetCommand.gs, PvFetchQueCommand.gs
 *
 * ■日別シート列構成(全9列・親行/子行で列を兼用しない)
 *   親行: A=更新日, B=時刻, C=投稿数, D〜I=空欄
 *   子行: A,B,C=空欄, D=NCODE, E=前回投稿時刻, F=PV+0h, G=PV+1h, H=作品名, I=エラー
 *
 * ■前回投稿時刻(E列・子行)
 * ・同一NCODEの直前の投稿(実時刻ベース、日またぎも考慮)から
 *   60分以内であれば、その直前投稿の時刻を入れる。60分超なら空欄。
 **********************************************************************/


// ============================
// 既存の日別シート読み込み
// 列構成: A更新日 B時刻 C投稿数 D NCODE E前回投稿時刻 F PV0 G PV1 H作品名 I エラー
// ============================

function readExistingDailySheet_(mainSheet, dailyData) {
  const lastRow = mainSheet.getLastRow();

  if (lastRow <= 1) return;

  const existingValues = mainSheet.getRange(2, 1, lastRow - 1, 9).getDisplayValues();

  let currentDate = "";
  let currentTime = "";

  existingValues.forEach(row => {
    const colA = row[0];
    const colB = row[1];
    const colD = row[3]; // NCODE
    const colF = row[5]; // PV+0h
    const colG = row[6]; // PV+1h
    const colH = row[7]; // 作品名
    const colI = row[8]; // エラー(既存値。対象時間外はこれを維持する)

    const isParentRow = (colB !== "" && colD === "");

    if (isParentRow) {
      currentDate = normalizeDateString_(colA);
      currentTime = normalizeTimeString_(colB);

      if (!dailyData[currentTime]) {
        dailyData[currentTime] = {
          date: currentDate,
          items: []
        };
      }
    } else if (colD !== "" && currentTime !== "") {
      dailyData[currentTime].items.push({
        ncode: colD,
        title: colH,
        pv0: colF,
        pv1: colG,
        prevPostTime: "",
        errorMsg: colI
      });
    }
  });
}


// ============================
// 前回投稿時刻(C列・子行)の計算
// 同一NCODEの直前投稿(実時刻ベース)からの差が
// CONFIG.SAME_NCODE_THRESHOLD_MINUTES 以内なら、その時刻を入れる。
// 日をまたぐ場合は前日シートの最終投稿も参照する。
//
// ★前日シートの検索・オープン(Driveアクセス)は、この関数の実行中
// 最初の1回だけ行い、キャッシュして使い回す。
// (対象が「当日最初の60分以内」の投稿すべてで毎回Driveを叩くと、
//  該当件数が多い時に極端に遅くなるため)
// ============================

function calculatePrevPostTimes_(dailyData, sheetDateStr, fileKey) {
  const threshold = CONFIG.SAME_NCODE_THRESHOLD_MINUTES;

  // 当日内の全アイテムをフラットにして時系列順に並べる
  const flatItems = [];

  Object.keys(dailyData).sort().forEach(time => {
    dailyData[time].items.forEach(item => {
      flatItems.push({
        time: time,
        minuteOfDay: timeToMinute_(time),
        item: item
      });
    });
  });

  const lastSeenByNcode = {}; // ncode -> {time, minuteOfDay}

  // undefined = まだ前日シートを探していない。null = 探したが無かった。
  let prevDaySheetCache;

  flatItems.forEach(entry => {
    const ncode = entry.item.ncode;
    const prev = lastSeenByNcode[ncode];

    if (prev) {
      const diff = entry.minuteOfDay - prev.minuteOfDay;

      if (diff >= 0 && diff <= threshold) {
        entry.item.prevPostTime = prev.time;
      } else {
        entry.item.prevPostTime = "";
      }
    } else {
      // 当日内に直前投稿がない → 前日シートをまたぐ可能性を確認
      // (60分以内なら日またぎの可能性があるのは、当日の最初の60分だけ)
      if (entry.minuteOfDay < threshold) {
        if (prevDaySheetCache === undefined) {
          prevDaySheetCache = loadPreviousDaySheet_(sheetDateStr);
        }

        const crossDayTime = findLastOccurrenceInSheet_(prevDaySheetCache, ncode, entry.minuteOfDay, threshold);
        entry.item.prevPostTime = crossDayTime || "";
      } else {
        entry.item.prevPostTime = "";
      }
    }

    lastSeenByNcode[ncode] = { time: entry.time, minuteOfDay: entry.minuteOfDay };
  });
}


// ============================
// 前日の日別シートを1回だけ探して返す(見つからなければnull)。
// calculatePrevPostTimes_ の実行中、この関数の呼び出しは高々1回だけ。
// ============================

function loadPreviousDaySheet_(sheetDateStr) {
  const prevDate = new Date(sheetDateStr + "T00:00:00");
  prevDate.setDate(prevDate.getDate() - 1);

  const prevYear = Utilities.formatDate(prevDate, CONFIG.TIMEZONE, "yyyy");
  const prevMonth = Utilities.formatDate(prevDate, CONFIG.TIMEZONE, "MM");

  const prevFileKey = `${prevYear}年${prevMonth}月`;

  const prevSpreadsheet = findMonthlySpreadsheetIfExists_(prevFileKey);

  if (!prevSpreadsheet) return null;

  return findExistingDailySheet_(prevSpreadsheet, prevDate);
}


// ============================
// 既にロード済みの前日シート(キャッシュ)から、同一NCODEの
// 最終投稿時刻を探す(日またぎ用)。
// 見つかり、かつ60分以内であれば時刻文字列(HH:mm)を返す。それ以外はnull。
// ============================

function findLastOccurrenceInSheet_(prevSheet, ncode, todayMinuteOfDay, threshold) {
  if (!prevSheet) return null;

  const lastRow = prevSheet.getLastRow();

  if (lastRow <= 1) return null;

  const values = prevSheet.getRange(2, 1, lastRow - 1, 9).getDisplayValues();

  let currentTime = "";
  let lastMatchTime = null;

  values.forEach(row => {
    const colB = row[1];
    const colD = row[3];

    const isParentRow = (colB !== "" && colD === "");

    if (isParentRow) {
      currentTime = normalizeTimeString_(colB);
    } else if (colD === ncode) {
      lastMatchTime = currentTime;
    }
  });

  if (!lastMatchTime) return null;

  // 前日 lastMatchTime から当日 todayMinuteOfDay までの経過分数(日またぎ考慮)
  const diff = (24 * 60 - timeToMinute_(lastMatchTime)) + todayMinuteOfDay;

  if (diff <= threshold) {
    return lastMatchTime;
  }

  return null;
}


// ============================
// 日別シート用データとサマリ集計を作成
// 列構成: A更新日 B時刻 C投稿数 D NCODE E前回投稿時刻 F PV0 G PV1 H作品名 I エラー
// ============================

function buildDailyRowsAndHourlyCounts_(dailyData) {
  const rowsToWrite = [];
  const sortedTimes = Object.keys(dailyData).sort();

  let currentDayDateStr = "";
  const hourlyCounts = new Array(24).fill(0);

  sortedTimes.forEach(time => {
    const block = dailyData[time];

    currentDayDateStr = normalizeDateString_(block.date);

    const hour = parseInt(time.substring(0, 2), 10);
    hourlyCounts[hour] += block.items.length;

    // 親行
    rowsToWrite.push([
      currentDayDateStr,
      time,
      block.items.length,
      "",
      "",
      "",
      "",
      "",
      ""
    ]);

    // 子行
    block.items.forEach(item => {
      rowsToWrite.push([
        "",
        "",
        "",
        item.ncode,
        item.prevPostTime || "",
        item.pv0,
        item.pv1,
        item.title,
        item.errorMsg || ""
      ]);
    });
  });

  return {
    rowsToWrite: rowsToWrite,
    currentDayDateStr: currentDayDateStr,
    hourlyCounts: hourlyCounts
  };
}


// ============================
// 日別シート安全書き換え
// ============================

function rewriteDailySheetSafely_(spreadsheet, sheetKey, mainSheet, rowsToWrite) {
  let bkupSheet = null;

  if (mainSheet) {
    const bkupName = `${sheetKey}_bkup`;
    const oldBkup = spreadsheet.getSheetByName(bkupName);

    if (oldBkup) {
      spreadsheet.deleteSheet(oldBkup);
    }

    mainSheet.setName(bkupName);
    bkupSheet = mainSheet;
  }

  const newSheet = spreadsheet.insertSheet(sheetKey);

  setDailyHeaders_(newSheet);

  newSheet.getRange("A:I").setNumberFormat("@");
  newSheet.getRange(2, 1, rowsToWrite.length, 9).setValues(rowsToWrite);

  if (bkupSheet) {
    spreadsheet.deleteSheet(bkupSheet);
  }
}


// ============================
// 日別シートヘッダー
// ============================

function setDailyHeaders_(sheet) {
  sheet.getRange(1, 1, 1, 9).setValues([[
    "更新日",
    "時刻",
    "投稿数",
    "NCODE",
    "前回投稿時刻",
    "PV数+0時間",
    "PV数+1時間",
    "作品名",
    "エラー"
  ]]);

  sheet.getRange("A1:I1").setBackground("#FFFF00");
  sheet.getRange("A:I").setNumberFormat("@");
}