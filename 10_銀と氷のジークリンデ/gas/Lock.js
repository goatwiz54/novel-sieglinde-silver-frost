/**********************************************************************
 * Lock.js
 * 
 * 親スプシ(テンプレート)の「lock」シートで、複数ファイルの
 * シート・行・列の同時アクセスをロック管理する。
 * 
 * ロックシート構造:
 *   A列: ID (UUID、未使用時は空)
 *   B列: ファイル名
 *   C列: シート名
 *   D列: 行
 *   E列: 列
 *   F列: ロック時刻
 *
 * インターフェース:
 *   lockWrite(fileName, sheetName, row, col)       → UUID を返す
 *   lockUnlock(lockId)                              → 成功時 true
 *   lockSearch(fileName, sheetName, row, col)      → ロック行情報 or null
 *
 * 待機時間: 最大3秒
 **********************************************************************/

const LOCK_CONFIG = {
  PARENT_SPREADSHEET_ID: CONFIG.TEMPLATE_FILE_ID,
  LOCK_SHEET_NAME: "lock",
  LOCK_SHEET_HEADERS: ["ID", "ファイル名", "シート名", "行", "列", "lock日時"],
  MAX_WAIT_MS: 3000,
  RETRY_INTERVAL_MS: 100,
  LOCK_EXPIRATION_MINUTES: 10  // ロック有効期限(分)
};

/**
 * ロックシートを取得(または作成)。
 * @returns {GoogleAppsScript.Spreadsheet.Sheet}
 */
function getLockSheet_() {
  const parentSs = SpreadsheetApp.openById(LOCK_CONFIG.PARENT_SPREADSHEET_ID);
  let lockSheet = parentSs.getSheetByName(LOCK_CONFIG.LOCK_SHEET_NAME);

  if (!lockSheet) {
    lockSheet = parentSs.insertSheet(LOCK_CONFIG.LOCK_SHEET_NAME, 0);
    lockSheet.appendRow(LOCK_CONFIG.LOCK_SHEET_HEADERS);
  }

  return lockSheet;
}

/**
 * ロックシートをプロテクトする。
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @returns {boolean} 成功時 true
 */
function protectLockSheet_(sheet) {
  try {
    const protections = sheet.getProtections(SpreadsheetApp.ProtectionType.SHEET);
    const isAlreadyProtected = protections.some(p => p.getDescription() === "Lock sheet for concurrent access control");
    if (isAlreadyProtected) {
      return true; // 既にプロテクト中
    }
    
    const protection = sheet.protect();
    protection.setDescription("Lock sheet for concurrent access control");
    return true;
  } catch (e) {
    console.error(`【Lock】シートプロテクト失敗: ${e.message}`);
    return false;
  }
}

/**
 * ロックシートをアンプロテクトする。
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @returns {boolean} 成功時 true
 */
function unprotectLockSheet_(sheet) {
  try {
    const protections = sheet.getProtections(SpreadsheetApp.ProtectionType.SHEET);
    protections.forEach(p => {
      if (p.getDescription() === "Lock sheet for concurrent access control") {
        p.remove();
      }
    });
    return true;
  } catch (e) {
    console.error(`【Lock】シートアンプロテクト失敗: ${e.message}`);
    return false;
  }
}

/**
 * ロック時刻が期限超過か判定する。
 * @param {*} lockTimeStr - ロック時刻(文字列またはDate)
 * @returns {boolean} 期限超過時 true
 */
function isLockExpired_(lockTimeStr) {
  if (!lockTimeStr) {
    return false;
  }

  const lockTime = new Date(lockTimeStr);
  if (isNaN(lockTime.getTime())) {
    return false;
  }

  const now = new Date();
  const elapsedMinutes = (now.getTime() - lockTime.getTime()) / (1000 * 60);
  return elapsedMinutes >= LOCK_CONFIG.LOCK_EXPIRATION_MINUTES;
}

/**
 * 指定された(fileName, sheetName, row, col)のロックを取得する。
 * 既に存在する場合はそのロック情報を返す。
 * 存在しない場合は新規行にロック情報を書き込んで UUID を返す。
 * 期限超過(10分以上)のロックは削除されて上書き可能。
 *
 * @param {string} fileName - ファイル名
 * @param {string} sheetName - シート名
 * @param {number} row - 行番号
 * @param {number} col - 列番号
 * @returns {string} ロック ID (UUID)
 */
function lockWrite(fileName, sheetName, row, col) {
  const startTime = new Date().getTime();
  const lockSheet = getLockSheet_();

  // 既存ロックがあるか確認
  const existingLock = lockSearch(fileName, sheetName, row, col);
  if (existingLock) {
    return existingLock.id;
  }

  // プロテクトを解除して書き込み、再度プロテクト
  while (new Date().getTime() - startTime < LOCK_CONFIG.MAX_WAIT_MS) {
    try {
      unprotectLockSheet_(lockSheet);

      // 最初の空 ID 行を探す
      const values = lockSheet.getDataRange().getValues();
      let targetRow = -1;

      for (let i = 1; i < values.length; i++) {
        if (!values[i][0] || String(values[i][0]).trim() === "") {
          targetRow = i + 1; // sheetの行は1-indexed
          break;
        }
      }

      // 空行がなければ新規行追加
      if (targetRow === -1) {
        targetRow = values.length + 1;
      }

      const uuid = Utilities.getUuid();
      const now = Utilities.formatDate(new Date(), CONFIG.TIMEZONE, "yyyy-MM-dd HH:mm:ss");

      lockSheet.getRange(targetRow, 1).setValue(uuid);
      lockSheet.getRange(targetRow, 2).setValue(fileName);
      lockSheet.getRange(targetRow, 3).setValue(sheetName);
      lockSheet.getRange(targetRow, 4).setValue(row);
      lockSheet.getRange(targetRow, 5).setValue(col);
      lockSheet.getRange(targetRow, 6).setValue(now);

      protectLockSheet_(lockSheet);

      return uuid;
    } catch (e) {
      console.error(`【Lock】write 失敗(再試行): ${e.message}`);
      Utilities.sleep(LOCK_CONFIG.RETRY_INTERVAL_MS);
    }
  }

  console.error(`【Lock】write タイムアウト: ${fileName} / ${sheetName} / ${row} / ${col}`);
  return null;
}

/**
 * 指定されたロック ID をアンロック(ID をクリア)する。
 *
 * @param {string} lockId - ロック ID (UUID)
 * @returns {boolean} 成功時 true
 */
function lockUnlock(lockId) {
  if (!lockId) {
    return false;
  }

  const startTime = new Date().getTime();
  const lockSheet = getLockSheet_();

  while (new Date().getTime() - startTime < LOCK_CONFIG.MAX_WAIT_MS) {
    try {
      unprotectLockSheet_(lockSheet);

      const values = lockSheet.getDataRange().getValues();

      for (let i = 1; i < values.length; i++) {
        if (String(values[i][0]).trim() === lockId) {
          lockSheet.getRange(i + 1, 1).setValue(""); // ID をクリア
          protectLockSheet_(lockSheet);
          return true;
        }
      }

      protectLockSheet_(lockSheet);
      return false; // ID が見つからない
    } catch (e) {
      console.error(`【Lock】unlock 失敗(再試行): ${e.message}`);
      Utilities.sleep(LOCK_CONFIG.RETRY_INTERVAL_MS);
    }
  }

  console.error(`【Lock】unlock タイムアウト: ${lockId}`);
  return false;
}

/**
 * 指定された(fileName, sheetName, row, col)のロック情報を検索する。
 *
 * @param {string} fileName - ファイル名
 * @param {string} sheetName - シート名
 * @param {number} row - 行番号
 * @param {number} col - 列番号
 * @returns {Object|null} ロック情報 {id, fileName, sheetName, row, col, lockedAt} または null
 */
function lockSearch(fileName, sheetName, row, col) {
  const startTime = new Date().getTime();
  const lockSheet = getLockSheet_();

  while (new Date().getTime() - startTime < LOCK_CONFIG.MAX_WAIT_MS) {
    try {
      protectLockSheet_(lockSheet); // プロテクト状態で読み取り

      const values = lockSheet.getDataRange().getValues();

      for (let i = 1; i < values.length; i++) {
        const lockId = String(values[i][0]).trim();
        const lockFileName = String(values[i][1]).trim();
        const lockSheetName = String(values[i][2]).trim();
        const lockRow = Number(values[i][3]);
        const lockCol = Number(values[i][4]);
        const lockTime = values[i][5];

        if (
          lockFileName === fileName &&
          lockSheetName === sheetName &&
          lockRow === row &&
          lockCol === col &&
          lockId !== ""
        ) {
          // マッチ見つかり。期限超過チェック。
          if (isLockExpired_(lockTime)) {
            // 期限超過 → 削除
            unprotectLockSheet_(lockSheet);
            lockSheet.deleteRow(i + 1);
            protectLockSheet_(lockSheet);
            return null; // ロックなし(削除済み)と扱う
          }

          return {
            id: lockId,
            fileName: lockFileName,
            sheetName: lockSheetName,
            row: lockRow,
            col: lockCol,
            lockedAt: lockTime
          };
        }
      }

      protectLockSheet_(lockSheet);
      return null; // ロック見つからず
    } catch (e) {
      console.error(`【Lock】search 失敗(再試行): ${e.message}`);
      Utilities.sleep(LOCK_CONFIG.RETRY_INTERVAL_MS);
    }
  }

  console.error(`【Lock】search タイムアウト: ${fileName} / ${sheetName} / ${row} / ${col}`);
  return null;
}

/**
 * 期限切れ(10分以上経過)のロックを削除する。
 * QUE整理から呼ばれる。
 *
 * @param {number} thresholdMinutes - 閾値(分)
 * @returns {number} 削除したロック数
 */
function clearExpiredLocks(thresholdMinutes) {
  const lockSheet = getLockSheet_();
  const now = new Date();
  let deletedCount = 0;

  try {
    unprotectLockSheet_(lockSheet);

    const values = lockSheet.getDataRange().getValues();
    const rowsToDelete = [];

    for (let i = 1; i < values.length; i++) {
      const lockId = String(values[i][0]).trim();
      const lockTimeStr = values[i][5];

      // ID が空なら対象外
      if (!lockId) {
        continue;
      }

      // ロック時刻をパース
      const lockTime = new Date(lockTimeStr);
      if (isNaN(lockTime.getTime())) {
        continue;
      }

      // 閾値以上経過しているか確認
      const elapsedMinutes = (now.getTime() - lockTime.getTime()) / (1000 * 60);
      if (elapsedMinutes >= thresholdMinutes) {
        rowsToDelete.push(i + 1); // sheetの行は1-indexed
      }
    }

    // 下から上に削除(行番号ズレ対策)
    for (let i = rowsToDelete.length - 1; i >= 0; i--) {
      lockSheet.deleteRow(rowsToDelete[i]);
      deletedCount++;
    }

    protectLockSheet_(lockSheet);

    return deletedCount;
  } catch (e) {
    console.error(`【Lock】期限切れロック削除失敗: ${e.message}`);
    protectLockSheet_(lockSheet);
    return 0;
  }
}
