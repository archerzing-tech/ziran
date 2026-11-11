<div align="center">

# Ziran

**AI 写真生成工作台 —— 传一张照片、挑一张姿势，出一张成图**

基于 [Tauri 2](https://v2.tauri.app/) 的桌面应用，macOS 与 Windows 10+ 原生运行。
参考图库、提示词、多家模型供应商开箱即用；API Key 与图片缓存只存在你自己的电脑里。

[![CI](https://github.com/archerzing-tech/ziran/actions/workflows/ci.yml/badge.svg)](https://github.com/archerzing-tech/ziran/actions/workflows/ci.yml)
[![Release](https://github.com/archerzing-tech/ziran/actions/workflows/release.yml/badge.svg)](https://github.com/archerzing-tech/ziran/actions/workflows/releases)

</div>

---

## 界面一览

亮色 / 暗色两套主题，标题栏一键切换，随时切、随时记：

![Ziran 界面截图 1](./docs/screenshots/Screenshot%202026-11-08%20at%2018.21.06.png)

![Ziran 界面截图 2](./docs/screenshots/Screenshot%202026-11-08%20at%2018.21.48.png)

![Ziran 界面截图 3](./docs/screenshots/Screenshot%202026-11-08%20at%2018.23.06.png)

画板周围的三件小事，都为「不挡图」设计：

- **顶部参考缩略条** —— 已选的照片 / 姿势 / 服装以小卡贴着画布上缘居中摆放，不遮成图；卡上只有缩略图，悬停看名称，点击放大预览。
- **图上缩放工具条** —— 缩小 / 适应窗口 / 放大和当前百分比，半透明毛玻璃浮在成图下缘，文字始终清晰；画板从顶部锚定缩放，放大只向下长，不会盖住参考条。
- **生成历史胶片条** —— 本次会话的成图排在画板左下，点击回看切换；悬停画板右上现下载按钮，一键保存 PNG。

## 三步出图

1. **选模型** —— 挑一家供应商，点「一键前往申请页」拿 API Key 粘贴进来（只存本机，自动保存）。
2. **选参考** —— 传一张人物照片，再从姿势图库挑一张姿势；服装、人脸可选，加了更像。
3. **点生成** —— 成图直接铺满画板，按成图比例走，不裁剪参考；不满意就再点一次，历史里随时回看。

## 功能

- **一张照片就能出图**：上传人物照片 + 挑一张姿势即可生成；不传照片也可以「姿势 + 人脸 + 服装」组合出图。照片与人脸二选一，避免"两张脸"的身份冲突，后选的自动替换先选的并给出提示。
- **内置三大参考图库**
  - 姿势：98 张人体线稿（全身单人 73 + 上半身单人 25），按坐姿/站姿/躺卧等分类
  - 服装：1407 套穿搭参考，按春夏秋冬、内衣睡衣、派对礼服、泳装度假等 8 类
  - 人脸：1499 张人脸参考（CC0 公共领域），按短发/中发/中长发/长发 4 个体系
- **图库离线可用**：缩略图按需缓存进本机 SQLite（`gallery.db`），也可一键"缩略图存本地"整库预下载，断网也能翻图库。
- **多家模型供应商**，都做了参考图适配（姿势/服装/人脸能"吃进去"的会标注"参考图"）：

  | 供应商 | 模型 | API Key 申请 |
  |---|---|---|
  | Seedream（火山方舟） | doubao-seedream-5.0-flash | [控制台 → API Key 管理](https://console.volcengine.com/ark) |
  | 硅基流动 | Qwen-Image-Edit-2509 | [API 密钥页](https://cloud.siliconflow.cn/account/ak) |
  | 智谱 CogView | glm-image | [API Keys](https://bigmodel.cn/usercenter/apikeys) |
  | OpenAI | gpt-image-1 | [API Keys](https://platform.openai.com/api-keys) |
  | Gemini | gemini-2.5-flash-image（Nano Banana） | [AI Studio](https://aistudio.google.com/apikey) |
  | MiniMax | image-01 | [开放平台](https://platform.minimax.io/console) |
  | 自定义 / 中转站 | 任意 OpenAI 兼容接口 | — |

  选好供应商后可直接点"一键前往申请页"打开对应的 Key 申请入口；Key 只保存在本机。
- **自动提示词**：按你已选的参考组合（照片/姿势/服装/人脸）自动拼装出图指令，也可以手动改写。
- **五种画幅**：1:1 / 3:4 / 4:3 / 9:16 / 16:9；成图按图片实际比例铺满画板，不留黑边。
- **亮 / 暗双主题**：标题栏太阳 / 月亮一键切换，选择自动记忆；叠加在图片上的浮层（工具条、标签、缩略卡）两种主题都保持深色，保证在成图上可读。

## 安装

从 [Releases](https://github.com/archerzing-tech/ziran/releases) 下载对应平台的安装包：

**macOS**
- `aarch64.dmg` → Apple Silicon（M 系列）
- `x64.dmg` → Intel
- 首次打开若被 Gatekeeper 拦截：右键 App → 打开；或执行 `xattr -dr com.apple.quarantine /Applications/Ziran.app`

**Windows（10 及以上）**
- `x64-setup.exe` → 64 位安装包
- 系统缺 WebView2 运行时时，安装器会自动下载安装（需联网）

**Android（10 及以上，arm64）**
- `arm64-v8a.apk` → 主流安卓手机；自签名发布，安装时允许「未知来源»

## 开发

```bash
# 依赖：Node 22+、Rust stable（tauri CLI 在 src-tauri 的 devDependencies 里）
npm ci                    # 根目录：react / @tauri-apps/api
cd src-tauri && npm ci    # 应用目录：vite / @tauri-apps/cli

npm run dev               # 仅前端（http://localhost:43123）
npx tauri dev             # 桌面应用开发模式
npx tauri build           # 打包（macOS 出 .app/.dmg，Windows 出 NSIS 安装包，CI 加 --bundles nsis）

# Android（需要本机 Android SDK/NDK + JDK 17）
# release 签名三环境变量：TAURI_ANDROID_KEYSTORE_PATH / _PASSWORD / _ALIAS
# keystore 在仓库外由发布者保管，不随库提交
npx tauri android dev                     # 手机/模拟器上开发调试
npx tauri android build --apk --target aarch64   # 出自签名 release APK
```

目录速览：

```
src-tauri/
  src/lib.rs              # Rust 侧：SQLite 图片缓存、批量预取、外链打开
  web/                    # 前端（React + Vite）
    src/main.tsx          # 工作台、供应商、图库 UI
    src/data/*.json       # 三个图库的目录数据（只含名称与公开图地址）
.github/workflows/
  ci.yml                  # push/PR：前端构建、cargo test、Windows/Android 编译检查
  release.yml             # 推 v* 标签发版：三平台并行构建进草稿，全部成功后转正
```

## 隐私

- API Key 只存在本机（`localStorage`），不经过任何第三方服务器，请求直连所选供应商。
- 图库图片按需下载后缓存在本机 SQLite 数据库（macOS：`~/Library/Application Support/com.ziran.app/gallery.db`；Windows：`%APPDATA%\com.ziran.app\gallery.db`）。
- 应用只收录参考图的名称与公开图地址，不随安装包分发任何图库图片。

## 致谢

- 姿势、服装、人脸图库数据源自 [anhao/ai-pose-gallery-zh](https://github.com/anhao/ai-pose-gallery-zh)（POSE & CHARACTER Atlas）的中文化整理；姿势线稿与服装图片著作权归原所有者，人脸照片采用 [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) 公共领域授权。本项目仅收录名称与公开图地址，不随包分发图片。
