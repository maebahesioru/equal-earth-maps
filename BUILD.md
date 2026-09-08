# ビルド手順 (Add-on source submission 用)

このアドオンは**変換・圧縮・トランスパイル一切なし**の素のJavaScriptです。
ビルドは単純な「ファイルコピー + manifest選択 + zip化」のみ行います。

## 必要なもの

- OS: Windows / macOS / Linux いずれでも可
- Python **3.8 以降**(標準ライブラリのみ使用。`pip install` 不要)
  - 確認: `python --version`
- その他の依存はありません(node/npm 等は不要。動作確認用テストだけ任意で node を使用)

## 手順

1. リポジトリ(またはソースzip)を展開
2. ルートで次を実行:
   ```
   python build.py
   ```
3. 生成物:
   - `dist/chrome/` と `dist/firefox/`(展開済みアドオン)
   - `dist/equal-earth-maps-chrome.zip`
   - `dist/equal-earth-maps-firefox.zip` ← **Firefox 提出物はこの zip**

`build.py` が行うこと:
- `shared/`・`content/`・`popup/`・`icons/`・`background.js` を `dist/firefox/` へコピー
- `manifest.firefox.json` を `dist/firefox/manifest.json` として配置
- README のコピー
- 内容を zip にまとめる

コードの中身は一切変更されません(コピーと配置のみ)。

## 提出物との一致の確認

- 提出した zip の中身 = `dist/firefox/` の中身と同一
- 再現確認: `python build.py` → `dist/equal-earth-maps-firefox.zip` を生成 →
  展開して `manifest.json` の `version` と提出物が一致することを確認

## (任意) 数学ロジックの自動テスト

投影計算の単体テスト:
```
python -m http.server 8099   # demo用(ブラウザ検証)
node tests/math.test.mjs     # 投影計算の数値テスト
```
※ どちらもビルドには不要です。node はこのテストのためだけに使用します。
