# -*- coding: utf-8 -*-
import urllib.request
import time
import re
from bs4 import BeautifulSoup

def download_syosetu():
    base_url = "https://ncode.syosetu.com/n6795me/"
    start_ep = 1
    end_ep = 82
    
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
    }

    print(f"第{start_ep}話〜第{end_ep}話のダウンロードを開始するよ...")

    for i in range(start_ep, end_ep + 1):
        ep_url = f"{base_url}{i}/"
        print(f"[{i}/{end_ep}] 取得中: {ep_url}")
        
        try:
            req = urllib.request.Request(ep_url, headers=headers)
            with urllib.request.urlopen(req) as response:
                html = response.read().decode('utf-8', errors='ignore')
            
            soup = BeautifulSoup(html, 'html.parser')
            
            # タイトルをパース
            title_tag = soup.find('h1', class_='p-novel__title')
            episode_title = title_tag.text.strip() if title_tag else f"第{i}話"
            
            # ファイル名に使えない半角記号を置換
            safe_title = re.sub(r'[\\/*?:"<>|]', '_', episode_title)
            
            # 指定されたファイル名の形式（話数を3桁でゼロ埋め）
            output_filename = f"改｜001-{i:03d}-00｜{safe_title}.txt"
            
            # ルビの処理
            for ruby in soup.find_all('ruby'):
                for rp in ruby.find_all('rp'):
                    rp.decompose()
                
                rt_tag = ruby.find('rt')
                if rt_tag:
                    ruby_text = rt_tag.get_text().strip()
                    rt_tag.decompose()
                    
                    base_text = ruby.get_text().strip()
                    ruby.replace_with(f"｜{base_text}《{ruby_text}》")
            
            # 本文の処理
            honbun_tag = soup.find('div', class_='js-novel-text')
            if not honbun_tag:
                honbun_tag = soup.find('div', class_='p-novel__body')
            
            if honbun_tag:
                paragraphs = []
                for p in honbun_tag.find_all('p'):
                    text = p.get_text().strip('\r\n\t')
                    paragraphs.append(text)
                    
                honbun = "\n".join(paragraphs)
            else:
                honbun = "（本文の取得に失敗しました）"
            
            # 本文だけを保存
            with open(output_filename, 'w', encoding='utf-8') as outfile:
                outfile.write(honbun + "\n")
            
            time.sleep(1)

        except Exception as e:
            print(f"第{i}話の取得中にエラーが発生したよ: {e}")

    print("全部のダウンロードが完了したよ。")

if __name__ == "__main__":
    download_syosetu()