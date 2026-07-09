/**********************************************************************
 * Const.gs
 *
 * プロジェクト共通定数。
 *
 * 注意:
 * - 読み込み順依存を避けるため、他ファイルのトップレベル初期化では
 *   これらを直接使わない。必要な時に関数内で参照する。
 **********************************************************************/

const TASK_TRIGGER_KEY = {
  FETCH_SEARCH_API: "trigger_fetch_search_api",
  FETCH_API_BLOCK: "trigger_fetch_api_block",
  UPDATE_SUMMARY: "trigger_update_summary",
  UPDATE_TEN_MINUTE_PV: "trigger_update_ten_minuts_pv",
  FETCH_PV: "trigger_fetch_pv",
  CLEAR_QUE: "trigger_clear_que"
};

const TASK_TRIGGER_PREFIX = {
  UPDATE_DAY: "trigger_update_day",
  UPDATE_PV: "trigger_update_pv",
  FETCH_PV: "trigger_fetch_pv"
};
