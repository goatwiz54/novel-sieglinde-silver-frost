// 先ほどコピーしたGASのウェブアプリURL
const GAS_WEB_APP_URL = 'https://script.google.com/macros/s/AKfycbwY219iN1WXji_pZZmT5vd7Ig9wK7OOt0cg5JYXURCOYv-_d0MChyGtzNTfX4-N4ZOg/exec';

document.getElementById('fetch-pv-btn').addEventListener('click', async () => {
  const statusElement = document.getElementById('status');
  statusElement.textContent = 'PV取得中...';

  try {
    // GASのウェブアプリへリクエストを送信
    const response = await fetch(GAS_WEB_APP_URL, {
      method: 'POST', // もしくは 'GET' でもGAS側が対応しているので動きます
      redirect: 'follow', // GASの仕様上、必須の設定です
      headers: {
        'Content-Type': 'text/plain' // CORSエラーを回避するため、あえてtext/plainにするのがGASの定石です
      }
    });

    const result = await response.json();

    if (result.ok) {
      statusElement.textContent = '成功: ' + result.message;
    } else {
      statusElement.textContent = 'エラー: ' + result.error;
    }
  } catch (error) {
    console.error('通信エラー:', error);
    statusElement.textContent = '通信に失敗しました';
  }
});