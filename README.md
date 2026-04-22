# ipa_install

基于 GitHub Pages 的自助 iOS / Android / Mac 分发页。上传走 **GitHub Releases**，绕开 Git 的 100MB 文件限制，单文件可达 2GB。

## 地址

- 分发页：https://xiaoli55979.github.io/ipa_install/
- iOS 安装链接：`itms-services://...`（脚本自动生成，指向 Release 资产）

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
4. **Attach binaries** 区域拖入 `.ipa` / `.apk` / `.dmg`（.dmg 必须和同 App 的 .ipa 或 .apk 放在同一个 Release 里）
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
3. 按**包名**（`CFBundleIdentifier` / `package`）归组；`.dmg` 不解析，用同 Release 里 ipa/apk 的包名挂过去
4. 生成 `docs/manifest/*.plist` + 重建 `docs/apps.json`
5. commit 回 `main`，Pages 重新部署

1~2 分钟后手机刷新页面即可看到。

## 归组规则

- iOS `CFBundleIdentifier` 和 Android `package` **完全一致** → 同一张卡片，两个平台各自一个安装按钮
- 不一致 → 分成两张卡片

同一个 App 可以有多个版本（多个 Release），按上传时间倒序显示，最新版显示在卡片上，"历史版本"折叠展开看老版。

## 每次发布可以传什么

- 只有 IPA、只有 APK、IPA + APK 同时传 —— 都行
- `.dmg` 需要同 Release 里至少有一个 `.ipa` 或 `.apk`，脚本靠它的包名归组；版本号用 Release tag
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
