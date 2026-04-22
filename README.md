# ipa_install

基于 GitHub Pages 的自助 iOS / Android / Mac / Windows 分发页。上传走 **GitHub Releases**，绕开 Git 的 100MB 文件限制，单文件可达 2GB。

## 地址

- 分发页：https://xiaoli55979.github.io/ipa_install/
- iOS 安装链接：`itms-services://...`（脚本自动生成，指向 Release 资产）

## 架构原理

用 GitHub 全家桶凑出的免费 App 分发服务：**Releases 当文件仓库，Pages 当分发页，Actions 当打包流水线**，零服务器、零数据库、零域名成本。

### 架构图

```
       ┌────────────── 你做的事 ──────────────┐
       │                                     │
       │  Release 新版 → 拖 ipa/apk/dmg/exe  │
       │                                     │
       └────────────────┬────────────────────┘
                        │ 触发 release 事件
                        ▼
       ┌─────────────────────────────────────┐
       │        GitHub Actions (免费 CI)      │
       │  build-metadata.mjs                  │
       │  ① 拉所有 Release 资产               │
       │  ② 解析 ipa Info.plist / apk manifest│
       │  ③ 按 bundleId 归组，挂载 dmg/exe    │
       │  ④ 生成 manifest.plist + apps.json   │
       │  ⑤ 提取图标                          │
       │  ⑥ commit 回 docs/                   │
       └────────────────┬────────────────────┘
                        │ 自动 push main
                        ▼
       ┌─────────────────────────────────────┐
       │     GitHub Pages (docs/ 目录静态托管) │
       │                                      │
       │  index.html + app.js + apps.json     │
       │  manifest/*.plist + icons/*.png      │
       └────────────────┬─────────────────────┘
                        │ 用户访问
                        ▼
       ┌─────────────────────────────────────┐
       │         终端用户浏览器                │
       │                                      │
       │  fetch apps.json → 渲染卡片          │
       │  UA 识别平台 → 点按钮                 │
       │    iOS:    itms-services:// 唤起系统  │
       │    其它:   直链下载 / 扫码给手机       │
       └─────────────────────────────────────┘
```

### 各层职责

#### 1. 存储层 — GitHub Releases

- **为什么不用 git 本体**：git 单文件硬上限 100 MB，ipa 动辄几十上百 MB 根本放不下。
- **Releases 的好处**：单文件 2 GB，CDN 加速，全球免费下载，不计仓库空间。
- **数据就是 Releases 本身**：你的 Release 就是数据库，每个 Release 里的 asset 就是一条记录。
- 文件永久 URL：`github.com/OWNER/REPO/releases/download/<tag>/<file>`。

#### 2. 触发层 — GitHub Actions

- 监听 `release` 事件 + 手动触发。
- 核心脚本 `scripts/build-metadata.mjs` 干 3 件事：
  - `gh api /repos/OWNER/REPO/releases` 拉所有 release 列表
  - 每个 `.ipa` 下载后用 `adm-zip` 拆开读 `Info.plist`；每个 `.apk` 用 `app-info-parser` 读 `AndroidManifest`
  - 按 `CFBundleIdentifier` / `package` 归组 → 生成 `apps.json` + `manifest/*.plist` → commit 回 `docs/`
- **dmg/exe/zip 不解析**，只在同一个 Release 里蹭 ipa/apk 的 bundleId 做归组。

#### 3. 托管层 — GitHub Pages

- 仓库 `Settings → Pages` 配 `main` 分支 `/docs` 目录。
- Actions push 完，Pages 自动重新部署。
- 最终地址 `https://USER.github.io/REPO/` 就是分发页。
- 静态页，无后端，所有动态逻辑都在浏览器里跑。

#### 4. 前端展示层 — `docs/` 纯静态

- `index.html + app.js + style.css` 是写死的模板。
- `apps.json` 是运行时数据，浏览器 fetch 进来渲染。
- 每张卡片：图标 + 名称 + bundleId + 各平台最新版按钮 + 历史版本折叠。
- UA 识别：iOS / Android / Mac / Windows 各自给合适的提示。
- 扫码按钮：`qrcodejs` 本地渲染二维码，解决"PC 上看到 iOS 包想传到手机"的场景。

#### 5. 安装协议层

整套方案最巧妙的地方：

- **iOS OTA 安装**：必须走 `itms-services://?action=download-manifest&url=<plist>` 这个 Apple 协议 URL。`<plist>` 是描述文件（里面写着真正 ipa 的 URL + bundleId + version），**必须 HTTPS**。GitHub Pages 自带 HTTPS，脚本自动生成这个 plist 扔在 `docs/manifest/` 里，完美满足条件。
- **Android / Mac / Windows**：没有 OTA 协议，就是直链下载。Android 下载完系统会提示安装；Mac `.dmg` 要手动拖 Applications；Windows `.exe` / `.zip` 自己跑。

#### 6. 归组规则

同 `bundleId` = 同一张卡，不管有多少平台、多少版本。所以只要保证 iOS `CFBundleIdentifier` 和 Android `package` 一致，就能自动聚合到一起。

### 和其它方案对比

| 方案 | 成本 | 定制度 | 私有控制 | 对比本方案 |
|------|------|--------|---------|-----------|
| 蒲公英 / fir.im | 免费有限额，付费贵 | 低 | 中 | 本方案免费无限额，但没后台管理 |
| 自建 + OSS + 域名 | OSS 流量费 + 备案 + 服务器 | 高 | 高 | 本方案零成本但完全公开 |
| TestFlight | 免费 | 最低 | 高 | 本方案更灵活，TF 要审核 |
| 企业签名 | 签名服务贵 + 易被封 | 中 | 中 | 本方案合规（开发者账号 Ad-Hoc） |

### 端到端时序

1. **你** 拖个 ipa 到 Release — 1 秒
2. **Actions** 识别 → 解析 → 生成 → commit — 1-2 分钟
3. **Pages** 重新部署 — 30 秒
4. **用户** 打开页面 → 扫码 → iOS 弹安装面板 → 下载装上 — 1-3 分钟（看网速）

端到端用户感知 **2-5 分钟能用上新版**。

## 一次性初始化（在 GitHub 上做一遍）

1. 推送代码到 `https://github.com/xiaoli55979/ipa_install.git` 的 `main` 分支
2. **Settings → Pages**：Source 选 `Deploy from a branch`，Branch 选 `main`，目录 `/docs`，Save
3. **Settings → Actions → General → Workflow permissions**：勾选 **Read and write permissions**，Save

仓库名或用户名变了就改 `config.json` 的 `repo` 和 `publicUrl` 两个字段。

## 发布一个新版本

### 方式 A：GitHub 网页（推荐新手）

1. 仓库主页 → **Releases** → **Draft a new release**
2. **Choose a tag** → 输入新版本号（如 `v1.2.3`）→ `Create new tag on publish`
3. **Release title** 填一个你看得懂的标题（不影响归组）
4. **Attach binaries** 区域拖入 `.ipa` / `.apk` / `.dmg` / `.exe` / `.zip`（dmg/exe/zip 必须和同 App 的 .ipa 或 .apk 放在同一个 Release 里）
5. 右下角 **Publish release**

### 方式 B：gh 命令行

```bash
gh release create v1.2.3 \
  /path/to/MyApp.ipa /path/to/MyApp.apk \
  --title "v1.2.3" \
  --notes "修了登录 bug"
```

发布后 GitHub Actions 会自动：
1. 列出所有 Release 资产
2. 下载每个 `.ipa` / `.apk`，解析 `Info.plist` / `AndroidManifest`
3. 按**包名**（`CFBundleIdentifier` / `package`）归组；`.dmg` / `.exe` / `.zip` 不解析，用同 Release 里 ipa/apk 的包名挂过去
4. 生成 `docs/manifest/*.plist` + 重建 `docs/apps.json`
5. commit 回 `main`，Pages 重新部署

1~2 分钟后手机刷新页面即可看到。

## 归组规则

- iOS `CFBundleIdentifier` 和 Android `package` **完全一致** → 同一张卡片，两个平台各自一个安装按钮
- 不一致 → 分成两张卡片

同一个 App 可以有多个版本（多个 Release），按上传时间倒序显示，最新版显示在卡片上，"历史版本"折叠展开看老版。

## 每次发布可以传什么

- 只有 IPA、只有 APK、IPA + APK 同时传 —— 都行
- `.dmg`（Mac）、`.exe` / `.zip`（Windows）需要同 Release 里至少有一个 `.ipa` 或 `.apk`，脚本靠它的包名归组；版本号用 Release tag
- Release 里**不要丢其它无关 zip**（例如源码打包），脚本会把它当成 Windows 包
- 同一个 Release 里可以塞多个 App 的包（按包名归组不冲突）
- 发新版本就建新 Release，老 Release 里的旧包会进"历史版本"

## 已知限制

| 项 | 限制 | 说明 |
|---|---|---|
| 单文件 | **2 GB** | Release 资产上限 |
| iOS 签名 | 必须有效 | 未签名/过期的 IPA 装不上 |
| UDID 白名单 | Ad-Hoc 100 台/类/年 | 苹果开发者账号限制 |
| 图标提取 | Assets.car 不支持 | 用 Assets.car 打包的 IPA 会没图标，兜底显示首字母 |
| Release 数量 | 建议 ≤ 100 个 | 每次构建要下载所有资产解析，太多会慢 |

## 基于本项目克隆一套新分发（给另一批 App 用）

如果要给**不同客户/业务线**做独立分发页（独立仓库、独立 URL、独立访问权），用自带脚本一键克隆：

```bash
# 先确认已 gh auth login
./scripts/new-dist-repo.sh <新仓库名> "站点标题"
# 示例:
./scripts/new-dist-repo.sh customer_abc "ABC 客户分发"
```

脚本会自动：复制本项目到 `../<新仓库名>_project/`、清掉旧产物、写入新 `config.json`、建 GitHub 仓库并推送、启用 Pages、打开 Actions 写权限。跑完 1-2 分钟后去新 Pages URL 就能用。

> 如果只是想**在现有页面里加多个 App**，不用克隆仓库，直接把新 App 的 ipa/apk 丢进 Release，脚本会按 `bundleId` 自动归成新卡片。

## 本地调试（可选）

```bash
# 先 gh auth login 一次
npm install
npm run build      # 从 Releases 拉取资产解析
npx serve docs     # 本地预览分发页
```

## 项目结构

```
.
├── config.json                 # repo / publicUrl / siteTitle
├── package.json
├── scripts/
│   └── build-metadata.mjs      # 从 Releases 解析 + 生成 apps.json
├── docs/                       # GitHub Pages 根
│   ├── index.html              # 分发页
│   ├── assets/{app.js,style.css}
│   ├── manifest/               # 自动生成的 OTA plist
│   ├── icons/                  # 自动提取的图标
│   └── apps.json               # 自动生成的元数据
└── .github/workflows/build.yml # release 事件触发解析 + 自动提交
```
