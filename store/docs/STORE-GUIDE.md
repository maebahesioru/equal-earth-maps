# ストア提出ガイド

## 共通の前準備
1. このリポジトリの **Releases** から zip を取得(またはローカルで `python build.py` を実行して `dist/` を生成)
   - Chrome 用: `dist/equal-earth-maps-chrome.zip`(解凍不要・このzipをそのまま提出)
   - Firefox 用: `dist/equal-earth-maps-firefox.zip`
2. 提出物一覧は `store/` フォルダ:
   - `screenshots/01-world-equal-earth.png`(1280x800)
   - `screenshots/02-osm-japan-equal-earth.png`(1280x800)
   - `icons/icon128.png`(ストアアイコン)
   - `docs/chrome-listing-en.txt`(説明文の雛形)
   - `docs/listing-ja.txt`(日本語説明の雛形)

---

## A. Chrome Web Store(Google)
1. https://chrome.google.com/webstore/devconsole を開き、Googleアカウントでログイン
   - 開発者登録手数料 **$5(一回のみ)** が必要(本人確認・住所入力)
2. 「新しいアイテム」→ `dist/equal-earth-maps-chrome.zip` をアップロード
3. ストア情報を入力(雛形: `store/docs/chrome-listing-en.txt` / `listing-ja.txt`)
   - 説明: 英語+日本語両方入れてOK
   - カテゴリ: 「便利ツール / Productivity」or「地図 / Maps」
4. アイコン: `icons/icon128.png` / スクリーンショット: `store/screenshots/*.png`
5. 権限の説明に「この拡張はデータを収集・送信しません」と明記(単一目的=地図の投影変換表示)
6. 審査に出す。審査は数時間〜数日(初回は数日かかることも)

注意: Chrome Web Store は「自分のアカウントで提出する」必要があり、外部から代理提出はできません。
(ブラウザ拡張の権限が絞ってあるので審査は通りやすい構成にしてある)

---

## B. Firefox Add-ons(AMO)
1. https://addons.mozilla.org に Mozillaアカウントでログイン(無料)
2. 「Submit a New Add-on」→ 自分で署名(distribution: self-distribution or listed)
3. `dist/equal-earth-maps-firefox.zip` をアップロード
   - manifest に `browser_specific_settings.gecko.id` を設定済み
4. 説明・アイコン・スクリーンショットを入力(上記のファイルを使用)
5. 審査に出す(初回は数日程度)

---

## C. GitHub
リポジトリ: https://github.com/maebahesioru/equal-earth-maps
- Releases から最新zipを配布
- ソース一式はリポジトリ直下(shared/ content/ popup/ demo/ tests/ 等)

---

## 再ビルド方法
```
python build.py
# dist/chrome, dist/firefox, *.zip が更新される
```
