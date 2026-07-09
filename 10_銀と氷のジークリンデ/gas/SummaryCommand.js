/**********************************************************************
 * SummaryCommand.gs
 *
 * QUE命令「サマリ更新」の実処理 + サマリシート本体のロジック
 * (旧コード.gsから、ここでしか使わない関数を移設)。
 *
 * ■やること
 * ・対象日付(targetDateStr)の日別シートを開く
 * ・親行(時刻ブロック行)から、時間帯(0〜23時)ごとの投稿数を再集計する
 * ・updateSummarySheet() を呼ぶ
 *
 * ■サマリシート仕様(ヒートマップ)
 * ・ヘッダーは毎回再生成する(日付/0時〜23時、黄色背景・太字・中央揃え)
 * ・A列は表示上 "yyyy/MM/dd(曜)" 形式だが、内部比較は yyyy-MM-dd に正規化
 * ・同じ日付が既にあればその行だけ更新、無ければ最終行へ追加(全体clearしない)
 * ・更新のたびに、シート全体の最大値を基準にヒートマップ(背景色)を塗り直す
 *   (0件は白、1件以上はシート全体の最大値を基準に24段階の青グラデーション)
 **********************************************************************/


// ============================
// 「サマリ更新」の実処理本体
// ============================

function processUpdateSummaryCommand_(targetDateStr) {
  const year = targetDateStr.substring(0, 4);
  const month = targetDateStr.substring(5, 7);
  const fileKey = `${year}年${month}月`;

  const spreadsheet = findMonthlySpreadsheetIfExists_(fileKey);

  if (!spreadsheet) {
    console.log(`【サマリ更新】月別ファイルが見つかりません: ${fileKey}`);
    return;
  }

  const dateObj = new Date(`${targetDateStr}T00:00:00`);
  const dailySheet = findExistingDailySheet_(spreadsheet, dateObj);

  if (!dailySheet) {
    console.log(`【サマリ更新】日別シートが見つかりません: ${targetDateStr}`);
    return;
  }

  const hourlyCounts = calculateHourlyCountsFromDailySheet_(dailySheet);

  updateSummarySheet(spreadsheet, targetDateStr, hourlyCounts);

  console.log(`【サマリ更新】完了: ${targetDateStr}`);
}


// ============================
// 日別シートの親行(時刻ブロック行)から、時間帯別の投稿数を集計する
// 列構成: A更新日 B時刻 C投稿数 D NCODE E前回投稿時刻 F PV0 G PV1 H作品名 I エラー
// ============================

function calculateHourlyCountsFromDailySheet_(dailySheet) {
  const hourlyCounts = new Array(24).fill(0);

  const lastRow = dailySheet.getLastRow();

  if (lastRow < 2) return hourlyCounts;

  const values = dailySheet.getRange(2, 1, lastRow - 1, 9).getDisplayValues();

  values.forEach(row => {
    const colB = row[1]; // 時刻
    const colC = row[2]; // 投稿数
    const colD = row[3]; // NCODE

    const isParentRow = (colB !== "" && colD === "");

    if (!isParentRow) return;

    const hour = parseInt(colB.substring(0, 2), 10);
    const count = Number(colC);

    if (isNaN(hour) || hour < 0 || hour > 23) return;
    if (isNaN(count)) return;

    hourlyCounts[hour] += count;
  });

  return hourlyCounts;
}


// ============================
// サマリシート更新(PV取得とは独立)
//
// ■列構成(A列は手動トリガー専用。自動更新では一切触らない)
//   A: ステータス(手動。「未処理」と入れるとその行を再更新する。処理中は「◆」、
//      成功で「✅」、失敗で「💀:理由」になる。installedOnEditSummary が担当)
//   B: 日付
//   C〜Z: 0時〜23時
// ============================

function updateSummarySheet(spreadsheet, dateStr, hourlyCounts) {
  let summarySheet = spreadsheet.getSheetByName(CONFIG.SUMMARY_SHEET_NAME);

  if (!summarySheet) {
    // 通常はテンプレート由来で既に存在する想定。無い場合のみ末尾に新規作成する
    // (既存シートの並び順には手を加えない)
    summarySheet = spreadsheet.insertSheet(CONFIG.SUMMARY_SHEET_NAME);
  }

  setSummaryHeaders_(summarySheet);

  const normalizedDateStr = normalizeDateString_(dateStr);
  const displayDateStr = formatDateWithWeekdayDisplay_(normalizedDateStr);

  const data = summarySheet.getDataRange().getDisplayValues();

  let targetRowIndex = -1;

  for (let i = 1; i < data.length; i++) {
    const existingDate = normalizeDateString_(data[i][1]); // B列(日付)

    if (existingDate === normalizedDateStr) {
      targetRowIndex = i + 1;
      break;
    }
  }

  // A列(ステータス)は含めない。B列(日付)〜Z列(23時)の25列分だけ書く。
  const rowData = [displayDateStr, ...hourlyCounts];

  if (targetRowIndex !== -1) {
    summarySheet.getRange(targetRowIndex, 2, 1, 25).clearContent();
    summarySheet.getRange(targetRowIndex, 2, 1, 25).setNumberFormat("@");
    summarySheet.getRange(targetRowIndex, 2, 1, 25).setValues([rowData]);
  } else {
    const nextRow = summarySheet.getLastRow() + 1;
    summarySheet.getRange(nextRow, 2, 1, 25).setNumberFormat("@");
    summarySheet.getRange(nextRow, 2, 1, 25).setValues([rowData]);
  }

  applySummaryHeatmap_(summarySheet);
}


// ============================
// サマリシートのヘッダーを(毎回)再生成する
// ============================

function setSummaryHeaders_(sheet) {
  const headers = ["ステータス", "日付"];

  for (let i = 0; i <= 23; i++) {
    headers.push(`${i}時`);
  }

  const headerRange = sheet.getRange(1, 1, 1, 26);

  headerRange.setNumberFormat("@");
  headerRange.setValues([headers]);
  headerRange.setBackground("#FFFF00");
  headerRange.setFontColor("#000000");
  headerRange.setFontWeight("bold");
  headerRange.setHorizontalAlignment("center");
}


// ============================
// yyyy-MM-dd を表示用の "yyyy/MM/dd(曜)" 形式に変換する
// ============================

function formatDateWithWeekdayDisplay_(normalizedDateStr) {
  const dateObj = new Date(`${normalizedDateStr}T00:00:00`);

  const isoDow = parseInt(Utilities.formatDate(dateObj, CONFIG.TIMEZONE, "u"), 10);
  const weekdayMap = ["月", "火", "水", "木", "金", "土", "日"];
  const weekday = weekdayMap[isoDow - 1];

  const formatted = Utilities.formatDate(dateObj, CONFIG.TIMEZONE, "yyyy/MM/dd");

  return `${formatted}(${weekday})`;
}


// ============================
// サマリシート全体を対象に、投稿件数に応じた背景色(ヒートマップ)を塗る。
//
// ・0件 → 白
// ・1件以上 → シート全体の最大値を基準に24段階のグラデーション
// ・文字色は常に黒、太字、中央揃え
//
// ■配色の切り替え
// CONFIG.HEATMAP_STYLE で選ぶ:
//   "blue"    → 白→青の単色グラデーション(applySummaryHeatmapBlue_)
//   "rainbow" → 青→赤の虹色グラデーション(applySummaryHeatmapRainbow_)
//               件数が多いほど赤に近づく、信号色系の配色。
// ============================

function applySummaryHeatmap_(sheet) {
  if (CONFIG.HEATMAP_STYLE === "rainbow") {
    applySummaryHeatmapRainbow_(sheet);
  } else {
    applySummaryHeatmapBlue_(sheet);
  }
}


// ============================
// 共通: サマリシートのB〜Y列を読み込み、シート全体の最大値と
// 各セルの段階(0〜24)を計算する。配色だけが違う2つの関数から
// 共通で使う。
//
// colorFn: (step:0〜24) => 背景色(hex文字列) を返す関数
// ============================

function applySummaryHeatmapWithColorFn_(sheet, colorFn) {
  const lastRow = sheet.getLastRow();

  if (lastRow < 2) return; // データ行が無ければ何もしない

  const dataRange = sheet.getRange(2, 3, lastRow - 1, 24); // C列〜Z列(0時〜23時)
  const values = dataRange.getValues();

  // シート全体(全日付)の最大値を基準にする
  let maxVal = 0;

  values.forEach(row => {
    row.forEach(v => {
      const n = Number(v);
      if (!isNaN(n) && n > maxVal) maxVal = n;
    });
  });

  const backgrounds = values.map(row => row.map(v => {
    const n = Number(v);

    if (isNaN(n) || n <= 0 || maxVal <= 0) {
      return colorFn(0); // 白(0件)
    }

    let step = Math.ceil((n / maxVal) * 24);

    if (step < 1) step = 1;
    if (step > 24) step = 24;

    return colorFn(step);
  }));

  dataRange.setBackgrounds(backgrounds);
  dataRange.setFontColor("#000000");
  dataRange.setFontWeight("bold");
  dataRange.setHorizontalAlignment("center");
}


// ============================
// 配色①: 白→青の単色グラデーション(従来通り)
// ============================

const SUMMARY_HEATMAP_COLORS_BLUE = [
  "#FFFFFF", "#EBF5FF", "#DCEEFF", "#CDE6FF", "#BEDCFF", "#AAD2FF",
  "#96C6FA", "#82B9F5", "#6EAAF0", "#5FA0EB", "#5096E6", "#4691E1",
  "#3C8CDC", "#3787D7", "#3282D2", "#2D7DCD", "#2878C8", "#2373C3",
  "#1E6EBE", "#1969B9", "#1464B4", "#0F5FAF", "#0A5AAA", "#0555A5", "#0050A0"
];

function applySummaryHeatmapBlue_(sheet) {
  applySummaryHeatmapWithColorFn_(sheet, step => SUMMARY_HEATMAP_COLORS_BLUE[step]);
}


// ============================
// 配色②: 青→赤の虹色グラデーション(信号色系)
// 0件=白、件数が多いほど 青→水色→黄緑→黄色→オレンジ→赤 に近づく。
// HSL色空間で色相(Hue)を240°(青)→0°(赤)へ滑らかに変化させて生成する
// (固定の色テーブルを持たず、その場で計算する)。
// ============================

function applySummaryHeatmapRainbow_(sheet) {
  applySummaryHeatmapWithColorFn_(sheet, step => rainbowColorForStep_(step));
}

function rainbowColorForStep_(step) {
  if (step <= 0) return "#FFFFFF"; // 0件は白

  const t = (step - 1) / (24 - 1); // 0(最低)〜1(最高)
  const hue = 240 - t * 240; // 240°(青) → 0°(赤)

  return hslToHex_(hue, 85, 55);
}


// ============================
// HSL(色相0〜360, 彩度/明度0〜100)からHex文字列(#RRGGBB)へ変換する
// ============================

function hslToHex_(h, s, l) {
  const sNorm = s / 100;
  const lNorm = l / 100;

  const c = (1 - Math.abs(2 * lNorm - 1)) * sNorm;
  const hPrime = h / 60;
  const x = c * (1 - Math.abs((hPrime % 2) - 1));
  const m = lNorm - c / 2;

  let r1 = 0, g1 = 0, b1 = 0;

  if (hPrime >= 0 && hPrime < 1) { r1 = c; g1 = x; b1 = 0; }
  else if (hPrime >= 1 && hPrime < 2) { r1 = x; g1 = c; b1 = 0; }
  else if (hPrime >= 2 && hPrime < 3) { r1 = 0; g1 = c; b1 = x; }
  else if (hPrime >= 3 && hPrime < 4) { r1 = 0; g1 = x; b1 = c; }
  else if (hPrime >= 4 && hPrime < 5) { r1 = x; g1 = 0; b1 = c; }
  else { r1 = c; g1 = 0; b1 = x; }

  const toHex = (v) => {
    const n = Math.round((v + m) * 255);
    return n.toString(16).padStart(2, "0").toUpperCase();
  };

  return `#${toHex(r1)}${toHex(g1)}${toHex(b1)}`;
}