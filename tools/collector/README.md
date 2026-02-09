# 自动采集器（B站 + 知乎）

> 目标：自动生成可导入的 JSON 数据，含平台内容 ID 与可定位链接。

## 1. 安装依赖

```bash
cd /Users/liangxuechao/academic-content-platform/tools/collector
npm install
```

首次运行 Playwright 需要安装浏览器：

```bash
npx playwright install chromium
```

如果下载超时，可提高超时（毫秒）：

```bash
PLAYWRIGHT_DOWNLOAD_CONNECTION_TIMEOUT=120000 npx playwright install chromium
```

如果网络无法访问官方 CDN，可设置下载镜像：

```bash
PLAYWRIGHT_DOWNLOAD_HOST=https://playwright.azureedge.net npx playwright install chromium
```

如果你机器已有 Chrome，可跳过 Playwright 浏览器下载：

```bash
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install
USE_SYSTEM_CHROME=1 node index.mjs --platforms bilibili,zhihu --keywords "SCI,论文" --perKeyword 10 --out ./output.json
```

## 2. 运行采集

```bash
node index.mjs \
  --platforms bilibili,zhihu \
  --keywords "SCI,论文,专利,投稿,发表论文,发表期刊" \
  --perKeyword 100 \
  --commentsPerPost 5 \
  --out ./output.json
```

参数说明：
- `--platforms`：平台列表（逗号分隔）
- `--keywords`：关键词列表（逗号分隔）
- `--perKeyword`：每个关键词采集的帖子数量
- `--commentsPerPost`：每个帖子采集的评论数量（B站）
- `--out`：输出 JSON 文件路径
- `--headful true`：可视化运行（调试用）
- `--skipZhihuOnError false`：知乎失败时是否终止（默认跳过继续）

## 3. 导入到平台

打开管理后台 → 内容导入 → 粘贴或上传 `output.json`。

## 注意

- B站评论会自动生成可定位链接。
- 知乎搜索页可能触发反爬，建议降低 `perKeyword` 或使用 `--headful true` 观察运行。
- 若 B 站 API 返回 412，可传入登录 Cookie：

```bash
BILIBILI_COOKIE="SESSDATA=xxx; buvid3=xxx" USE_SYSTEM_CHROME=1 node index.mjs \
  --platforms bilibili --keywords "SCI" --perKeyword 10 --out ./output.json
```
