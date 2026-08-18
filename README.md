# 小红书笔记读取器（Xiaohongshu Note Reader）

使用**您本机已登录的小红书状态**打开笔记页面，自动读取页面可见的笔记信息，结构化保存为 JSON / CSV，方便后续交给 AI 分析并填写 Excel。

只读取您正常登录后能看到的数据：不破解登录、不绕验证码、不伪造签名、不保存 Cookie/Token/密码。

## 环境要求
- Windows 10/11，安装有 **Microsoft Edge**（本机已满足）或执行过 `npx playwright install chromium`
- Node.js 18+（本机 v24 已验证）

## 如何启动
双击 **`start.bat`**，或在命令行执行：
```
node src\main.js
```

## 首次使用：登录
1. 启动后选择菜单 **3 打开登录浏览器（人工登录）**；
2. 浏览器窗口会打开小红书首页，请用手机号+验证码 / 扫码等**正常方式登录**；
3. 登录成功后程序自动检测（最多等 10 分钟），登录状态保存在 `browser_profile\xhs_profile\`，**以后直接复用，无需再次登录**。

> 提示：直接读取时如果发现未登录，也会自动打开登录窗口。

## 读取单条链接
启动后选择 **1 单条读取**，粘贴链接回车即可。也支持命令行直接读取：
```
node src\main.js --url "https://www.xiaohongshu.com/discovery/item/6572cc17000000000700978a?source=webshare&xsec_token=xxx&xsec_source=pc_share"
```
带 `xsec_token` 的分享链接可正常处理；短链（xhslink.com）也会自动跳转解析。

## 批量读取
选择 **2 批量读取**，粘贴多个链接（每行一个，输入 `end` 结束）；或准备一个 `urls.txt` 后用：
```
node src\main.js --file urls.txt
```
`urls.txt` 为本地文件（已被 .gitignore 排除，可含真实 xsec_token），模板见仓库中的 `urls.example.txt`。
顺序逐个处理，每两条间隔 3 秒，稳定优先。

## 结果保存在哪里
| 内容 | 位置 |
|---|---|
| 每条笔记 JSON | `exports\json\<note_id>.json` |
| 汇总 CSV（追加） | `exports\xiaohongshu_notes.csv` |
| Excel 直用 CSV | `exports\excel_ready.csv`（账号名称/链接/发布日期/观看/点赞/收藏/评论/分享/标题/文案/素材来源） |
| 封面图 | `exports\covers\<note_id>.jpg` |
| 读取缓存 | `data\cache\<note_id>.json` |
| 失败现场（截图/HTML/原因） | `debug\<note_id>_error.png/.html/.json` |
| 运行日志 | `logs\reader.log` |

## 常用说明
- **登录失效怎么办**：重新选择菜单 3 登录一次即可。
- **出现验证码怎么办**：程序会停止自动操作，等您在浏览器里人工完成，然后自动继续。
- **如何清理缓存 / 重新读取**：删除 `data\cache` 目录，或加 `--refresh` 参数强制刷新：
  ```
  node src\main.js --url <链接> --refresh
  ```
- **观看/曝光数**：普通笔记页面不可见，输出中保持为空（不猜、不推算）。
- **评论**：只读取页面可见的前 30 条评论，不做大规模翻页。

## 目录结构
```
xiaohongshu_reader/
├── start.bat              一键启动
├── src/                   main / browser / parser / exporter / excel_mapping / utils
├── browser_profile/       独立浏览器登录状态（复用登录）
├── data/cache/            读取缓存
├── exports/               json / csv / covers
├── debug/                 失败截图与 HTML
└── logs/                  运行日志
```
