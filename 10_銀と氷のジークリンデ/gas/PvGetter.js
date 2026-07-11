/**********************************************************************
 * PvGetter.gs
 *
 * かささぎアクセス解析から、指定した(NCODE, 日付, 時刻(HOUR))に対応する
 * PV数を1件取得する処理。呼び出し元: PvSheetFetchCommand.gs
 *
 * ■取得元
 *   https://kasasagi.hinaproject.com/access/top/ncode/{NCODE}/
 *   HTML内の chart_data_today / chart_data_yesterday を利用する。
 *   chart_data_week は使わない。
 *
 * ■today/yesterdayの判定
 *   行が持つ「日付」を、実行時点の日付と比較して判定する。
 *   ・実行日と同じ → today
 *   ・実行日の前日 → yesterday
 *   ・それ以外(2日以上前) → 取得可能範囲外(エラー)
 *
 * ■キャッシュ
 *   呼び出し元が同一実行内で使い回すpvCacheオブジェクトを渡すことで、
 *   同じNCODEへのアクセスは1回だけになる(呼び出し元の責任で管理)。
 *
 * ■タイムゾーンについて(重要)
 *   このファイルでは、ネイティブDateオブジェクトのローカル時刻依存の
 *   操作(new Date(文字列)によるパース、getHours/setHours/getDate/setDate
 *   などのゲッター・セッター)を一切使わない。これらはすべてGASプロジェクトの
 *   「タイムゾーン設定」(プロジェクト設定。CONFIG.TIMEZONEとは別の設定値)に
 *   依存するため、CONFIG.TIMEZONE("Asia/Tokyo")と食い違っていると、
 *   正しい時間帯のPVなのに「時間帯未経過」と誤判定される等のバグになる。
 *   代わりに、Utilities.parseDate(タイムゾーン明示指定)とミリ秒(エポック値)
 *   だけで日時計算を行い、プロジェクトのタイムゾーン設定に一切依存しない
 *   ようにしている。
 **********************************************************************/

const PvGetter = (function () {

  const KASASAGI_URL_TEMPLATE = "https://kasasagi.hinaproject.com/access/top/ncode/{NCODE}/";

  // 失敗理由コード
  const FAIL = {
    FETCH_FAILED: "PV取得失敗",
    NO_TODAY: "todayデータなし",
    NO_YESTERDAY: "yesterdayデータなし",
    OUT_OF_RANGE: "PV対象外:取得可能範囲外",
    HOUR_NOT_FINISHED: "時間帯未経過",
    NOT_FOUND: "作品が存在しません(削除済みの可能性)",
    URLFETCH_QUOTA_EXCEEDED: "UrlFetch上限超過"
  };

  // かささぎが「作品情報取得エラー」を返す時に含まれる文言。
  // これが含まれていたら、一時的な失敗ではなく確定エラー(NOT_FOUND)として扱う。
  const NOT_FOUND_TEXT = "作品情報取得エラー";

  function normalizeNcodeKey_(ncode) {
    return String(ncode || "").trim().toUpperCase();
  }


  // ============================
  // 指定した(NCODE, 日付, 時刻(HOUR))のPV数を取得する。
  //
  // pvCache: 呼び出し元が保持する { ncode: {today, yesterday} } のキャッシュ。
  //          同一実行内で使い回すことで、同じNCODEへの重複アクセスを防ぐ。
  // fetchStats: { current, total } 進捗ログ・呼び出し元管理用。
  //
  // ■まだ早すぎる時間帯は取得しない
  // 現在時刻を「時」で切り捨て、そこから2時間引いた時刻を閾値とする。
  //   例: 現在22:05 → 22:00に切り捨て → -2時間 → 閾値は20:00
  // 対象チェックポイントの(日付+時刻)が、この閾値以降(閾値と同じか、
  // それより新しい)場合は、その時間帯のPVがまだ十分に確定していない
  // 可能性が高いため、取得を試みない。「時間帯未経過」という一時的な
  // 失敗として返し、呼び出し元はステータスを「未処理」のまま維持して、
  // 時間が経ってから再挑戦する。
  //
  // ★以前はnew Date()のsetHours/setMinutesや、
  //   new Date(`${dateStr}T${hour}:00:00`)というネイティブのローカル時刻
  //   依存パースを使っていた。これらはGASプロジェクトのタイムゾーン設定
  //   (CONFIG.TIMEZONEとは別)に依存するため、その設定がAsia/Tokyoと
  //   ズレていると、正しい時間帯なのに「時間帯未経過」と誤判定され続ける
  //   バグの原因になっていた。
  //   ここでは「時」への切り捨て+2時間引く計算はミリ秒(エポック値)だけで
  //   行う(JSTはUTC+9固定でDSTが無いため、1時間境界はどの時刻表現で見ても
  //   ズレない=プロジェクトのタイムゾーン設定に依存しない)。
  //   checkpoint側の日時は Utilities.parseDate でCONFIG.TIMEZONEを明示
  //   指定して求める。
  //
  // 戻り値: { ok:true, value:number } | { ok:false, reason:string }
  // ============================
  function fetchPvForDateHour_(pvCache, ncode, title, dateStr, hour, fetchStats) {
    const now = new Date();

    const HOUR_MS = 60 * 60 * 1000;
    const truncatedNowMs = Math.floor(now.getTime() / HOUR_MS) * HOUR_MS; // 現在時刻を「時」で切り捨て
    const thresholdMs = truncatedNowMs - 2 * HOUR_MS; // -2時間

    const checkpointStr = `${dateStr} ${String(hour).padStart(2, "0")}:00:00`;
    const checkpointDate = Utilities.parseDate(checkpointStr, CONFIG.TIMEZONE, "yyyy-MM-dd HH:mm:ss");

    const isHourNotFinished = checkpointDate.getTime() >= thresholdMs;

    // ★時間帯未経過の判定材料をそのままログに出す。
    //   現在時刻・比較元(閾値=現在時刻を「時」で切り捨てて-2時間したもの)・
    //   比較先(チェックポイントのdateStr+hour)・判定結果(未経過かどうか)を
    //   1行にまとめて出すことで、なぜ「時間帯未経過」になったのか/ならなかったのか
    //   をログだけで追えるようにする。
    const nowLogStr = Utilities.formatDate(now, CONFIG.TIMEZONE, "yyyy-MM-dd HH:mm:ss");
    const thresholdLogStr = Utilities.formatDate(new Date(thresholdMs), CONFIG.TIMEZONE, "yyyy-MM-dd HH:mm:ss");
    const checkpointLogStr = Utilities.formatDate(checkpointDate, CONFIG.TIMEZONE, "yyyy-MM-dd HH:mm:ss");
    console.log(`【時間帯判定】${ncode} / 現在時刻=${nowLogStr} / 比較元(現在時刻-2h切捨て)=${thresholdLogStr} / 比較先(PV取得シート:${dateStr} ${String(hour).padStart(2, "0")}:00)=${checkpointLogStr} / 判定=${isHourNotFinished ? "時間帯未経過(スキップ)" : "経過済み(取得へ進む)"}`);

    if (isHourNotFinished) {
      return { ok: false, reason: FAIL.HOUR_NOT_FINISHED };
    }

    const execDateStr = Utilities.formatDate(now, CONFIG.TIMEZONE, "yyyy-MM-dd");
    const dayRelation = getDayRelation_(dateStr, execDateStr);

    if (dayRelation === "OUT_OF_RANGE") {
      console.log(`【PV取得結果】${ncode} ${dateStr} ${String(hour).padStart(2, "0")}:00 => 失敗:${FAIL.OUT_OF_RANGE}`);
      return { ok: false, reason: FAIL.OUT_OF_RANGE };
    }

    const whichDay = (dayRelation === "TODAY") ? "today" : "yesterday";

    const result = getPvValue_(pvCache, ncode, title, dateStr, whichDay, hour, fetchStats);

    // ★時間帯の関門は通過したが、その先(かささぎ側のtoday/yesterdayデータ)で
    //   失敗しているケースを切り分けるためのログ。「未処理のまま」「PVが
    //   書き込まれない」という症状の原因が、この関門より先にあるかどうかを
    //   ここで確認できる。
    console.log(`【PV取得結果】${ncode} ${dateStr} ${String(hour).padStart(2, "0")}:00 (${whichDay}) => ${result.ok ? `成功:${result.value}` : `失敗:${result.reason}`}`);

    return result;
  }


  // ============================
  // fetchPvForDateHour_ の「時間帯未経過」ゲート抜きバージョン。
  //
  // ■なぜ必要か
  //   「PV取得」シートの1行は特定の(NCODE,日付,時刻)を表すが、その行の
  //   H〜AE列(0〜23時)には参考として1日24時間ぶんの値を並べて表示する。
  //   この24列を埋めるためだけに、24時間ぶん毎回「時間帯未経過」の
  //   ゲート判定をかけていたのが不要な二重判定だった。直近の1〜2時間が
  //   ゲートに引っかかるだけで行全体が「未処理」のまま固まる原因にも
  //   なっていた。
  //
  //   時間帯未経過の判定は、その行が本来担当する時刻(row.hour)について
  //   1回だけ行えば十分(fetchPvForDateHour_を使う)。24列の表示データは、
  //   ゲート抜きでその時点でかささぎから取得できているぶんだけ書けば良く、
  //   まだ確定していない時間帯は単に空欄のままにしておけばよい(次回の
  //   実行で自然に埋まる)。
  //
  // 戻り値: { ok:true, value:number } | { ok:false, reason:string }
  // ============================
  function fetchPvRawForDateHour_(pvCache, ncode, title, dateStr, hour, fetchStats) {
    const now = new Date();
    const execDateStr = Utilities.formatDate(now, CONFIG.TIMEZONE, "yyyy-MM-dd");
    const dayRelation = getDayRelation_(dateStr, execDateStr);

    if (dayRelation === "OUT_OF_RANGE") {
      return { ok: false, reason: FAIL.OUT_OF_RANGE };
    }

    const whichDay = (dayRelation === "TODAY") ? "today" : "yesterday";
    return getPvValue_(pvCache, ncode, title, dateStr, whichDay, hour, fetchStats);
  }


  // ============================
  // 実行日と対象日付の関係を判定
  // "TODAY" | "YESTERDAY" | "OUT_OF_RANGE"
  //
  // ★ここもネイティブDateのgetDate/setDateなどローカル時刻依存の操作は
  //   使わず、Utilities.parseDateで得たJST基準のエポック値から
  //   24時間(=86400000ミリ秒)を引くだけで「前日」を求める。
  //   JSTはDSTが無い固定オフセットなので、この引き算は常に正しい。
  // ============================
  function getDayRelation_(dateStr, execDateStr) {
    if (dateStr === execDateStr) return "TODAY";

    const DAY_MS = 24 * 60 * 60 * 1000;
    const exec = Utilities.parseDate(execDateStr, CONFIG.TIMEZONE, "yyyy-MM-dd");
    const yesterday = new Date(exec.getTime() - DAY_MS);
    const yesterdayStr = Utilities.formatDate(yesterday, CONFIG.TIMEZONE, "yyyy-MM-dd");

    if (dateStr === yesterdayStr) return "YESTERDAY";

    return "OUT_OF_RANGE";
  }


  // ============================
  // pvCacheからPV値を取得(未取得ならフェッチ)
  // 戻り値: { ok:true, value:number } | { ok:false, reason:string }
  // ============================
  function getPvValue_(pvCache, ncode, title, dateStr, whichDay, hour, fetchStats) {
    const cacheKey = normalizeNcodeKey_(ncode);

    if (!pvCache[cacheKey]) {
      pvCache[cacheKey] = fetchNcodePvData_(cacheKey, title, fetchStats, dateStr, hour);
    }

    const cacheEntry = pvCache[cacheKey];
    const dayData = cacheEntry[whichDay];

    if (dayData === FAIL.FETCH_FAILED) {
      return { ok: false, reason: FAIL.FETCH_FAILED };
    }

    if (dayData === FAIL.NOT_FOUND) {
      return { ok: false, reason: FAIL.NOT_FOUND };
    }

    if (whichDay === "today" && dayData === FAIL.NO_TODAY) {
      return { ok: false, reason: FAIL.NO_TODAY };
    }

    if (whichDay === "yesterday" && dayData === FAIL.NO_YESTERDAY) {
      return { ok: false, reason: FAIL.NO_YESTERDAY };
    }

    if (!Array.isArray(dayData)) {
      return { ok: false, reason: whichDay === "today" ? FAIL.NO_TODAY : FAIL.NO_YESTERDAY };
    }

    const value = dayData[hour];

    if (value === null || value === undefined || isNaN(value)) {
      return { ok: false, reason: whichDay === "today" ? FAIL.NO_TODAY : FAIL.NO_YESTERDAY };
    }

    return { ok: true, value: value };
  }


  // ============================
  // NCODE単位でかささぎへアクセスし、today/yesterdayの24時間分PVを取得
  // 戻り値: { today: number[24]|failCode, yesterday: number[24]|failCode }
  // ============================
  function fetchNcodePvData_(ncode, title, fetchStats, dateStr, hour) {
    fetchStats.current++;
    logFetchProgress_(fetchStats.current, fetchStats.total, dateStr, hour, ncode);

    const url = KASASAGI_URL_TEMPLATE.replace("{NCODE}", ncode);

    let html;

    try {
      const response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });

      if (response.getResponseCode() !== 200) {
        return { today: FAIL.FETCH_FAILED, yesterday: FAIL.FETCH_FAILED };
      }

      html = response.getContentText();
    } catch (e) {
      const message = String(e);
      console.log(`【PV取得失敗】${ncode}: ${message}`);

      if (message.indexOf("Service invoked too many times for one day: UrlFetch") !== -1) {
        throw new Error("URLFETCH_QUOTA_EXCEEDED");
      }

      return { today: FAIL.FETCH_FAILED, yesterday: FAIL.FETCH_FAILED };
    }

    return buildNcodePvResultFromHtml_(ncode, html);
  }

  function buildNcodePvResultFromHtml_(ncode, html) {
    // かささぎが「作品情報取得エラー」(削除済みなど)を返している場合は、
    // 一時的な失敗ではなく確定エラーとして扱う(二度と再挑戦しない)
    if (html.indexOf(NOT_FOUND_TEXT) !== -1) {
      console.log(`【PV取得】作品が存在しません: ${ncode}`);
      return { today: FAIL.NOT_FOUND, yesterday: FAIL.NOT_FOUND };
    }

    const todayArray = parseChartDataVariable_(html, "chart_data_today");
    const yesterdayArray = parseChartDataVariable_(html, "chart_data_yesterday");

    return {
      today: todayArray ? buildHourlyPvArray_(todayArray) : FAIL.NO_TODAY,
      yesterday: yesterdayArray ? buildHourlyPvArray_(yesterdayArray) : FAIL.NO_YESTERDAY
    };
  }

  function prefetchNcodePvDataBatch_(pvCache, ncodes, fetchStats, dateStr, hour) {
    const targets = (ncodes || []).filter(ncode => {
      const key = normalizeNcodeKey_(ncode);
      return key && !pvCache[key];
    });

    if (targets.length === 0) {
      return;
    }

    const requests = targets.map(ncode => ({
      url: KASASAGI_URL_TEMPLATE.replace("{NCODE}", normalizeNcodeKey_(ncode)),
      muteHttpExceptions: true
    }));

    let responses;

    try {
      responses = UrlFetchApp.fetchAll(requests);
    } catch (e) {
      const message = String(e);

      if (message.indexOf("Service invoked too many times for one day: UrlFetch") !== -1) {
        throw new Error("URLFETCH_QUOTA_EXCEEDED");
      }

      // fetchAllがまとめて失敗した場合は、対象NCODEを一時失敗としてキャッシュ。
      targets.forEach(ncode => {
        const cacheKey = normalizeNcodeKey_(ncode);
        fetchStats.current++;
        logFetchProgress_(fetchStats.current, fetchStats.total, dateStr, hour, cacheKey);
        pvCache[cacheKey] = { today: FAIL.FETCH_FAILED, yesterday: FAIL.FETCH_FAILED };
      });
      return;
    }

    targets.forEach((ncode, idx) => {
      const cacheKey = normalizeNcodeKey_(ncode);
      fetchStats.current++;
      logFetchProgress_(fetchStats.current, fetchStats.total, dateStr, hour, cacheKey);

      try {
        const response = responses[idx];

        if (!response || response.getResponseCode() !== 200) {
          pvCache[cacheKey] = { today: FAIL.FETCH_FAILED, yesterday: FAIL.FETCH_FAILED };
          return;
        }

        const html = response.getContentText();
        pvCache[cacheKey] = buildNcodePvResultFromHtml_(cacheKey, html);
      } catch (e) {
        pvCache[cacheKey] = { today: FAIL.FETCH_FAILED, yesterday: FAIL.FETCH_FAILED };
      }
    });
  }


  // ============================
  // HTML内の "var chart_data_xxx = [...];" を抽出してパース
  // 見つからない/パース失敗ならnullを返す
  // ============================
  function parseChartDataVariable_(html, varName) {
    const regex = new RegExp(varName + "\\s*=\\s*(\\[[\\s\\S]*?\\]);");
    const match = html.match(regex);

    if (!match) return null;

    try {
      const parsed = JSON.parse(match[1]);

      if (!Array.isArray(parsed) || parsed.length === 0) return null;

      return parsed;
    } catch (e) {
      console.log(`【${varName}パース失敗】${e}`);
      return null;
    }
  }


  // ============================
  // ["15時", tooltip, PC, SP, APP] の配列群から
  // 時間(0〜23)をインデックスとしたPV合計配列を作る
  // ============================
  function buildHourlyPvArray_(chartArray) {
    const hourly = new Array(24).fill(null);

    chartArray.forEach(entry => {
      if (!Array.isArray(entry) || entry.length < 5) return;

      const hourMatch = String(entry[0]).match(/(\d{1,2})時/);
      if (!hourMatch) return;

      const hour = parseInt(hourMatch[1], 10);
      if (hour < 0 || hour > 23) return;

      const pc = Number(entry[2]);
      const sp = Number(entry[3]);
      const app = Number(entry[4]);

      if (isNaN(pc) || isNaN(sp) || isNaN(app)) return;

      hourly[hour] = pc + sp + app;
    });

    return hourly;
  }


  // ============================
  // PV取得の進捗ログを出力する
  // 例: 1/30 2026-07-07 13:00 N1234AB
  // (日付・時刻はログ出力時刻ではなく、対象データの更新日・時刻)
  // ============================
  function logFetchProgress_(current, total, dateStr, hour, ncode) {
    const hourLabel = `${String(hour).padStart(2, "0")}:00`;

    console.log(`${current}/${total} ${dateStr} ${hourLabel} ${ncode}`);
  }


  return {
    fetchPvForDateHour_: fetchPvForDateHour_,
    fetchPvRawForDateHour_: fetchPvRawForDateHour_,
    prefetchNcodePvDataBatch_: prefetchNcodePvDataBatch_
  };

})();