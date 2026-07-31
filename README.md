<div align="center">
  <img src="./public/logo.png" alt="MornSpeaker Logo" width="96" />
  <h1>MornSpeaker</h1>
  <p><strong>晨语 · 即时语言转换服务系统</strong></p>
  <p>面向多人交流场景的实时语音识别、翻译与协作平台。</p>
  <p>
    <a href="https://github.com/lzylovec/MornSpeaker"><img src="https://img.shields.io/badge/GitHub-lzylovec%2FMornSpeaker-181717?logo=github" alt="GitHub Repository" /></a>
    <img src="https://img.shields.io/badge/Next.js-16-000000?logo=nextdotjs" alt="Next.js 16" />
    <img src="https://img.shields.io/badge/React-19-149ECA?logo=react" alt="React 19" />
    <img src="https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white" alt="TypeScript" />
    <img src="https://img.shields.io/badge/License-MIT-2ea44f" alt="MIT License" />
  </p>
</div>

<br />

## 项目简介

MornSpeaker 是一个基于 Next.js App Router 构建的实时语音翻译协作平台。它把语音采集、自动转写、AI 翻译、语音播报和多人房间组合在一起，适用于跨语言会议、在线交流、学习练习等场景。

核心体验可以概括为：

```text
语音输入 -> 实时转写 -> 多语言翻译 -> 房间同步 -> 语音播报
```

当前代码库以 Next.js、React 和 TypeScript 为实际实现基础，并通过 Route Handlers 统一承载业务 API；数据库和 AI 服务可以根据部署环境切换。

## 界面预览

以下截图来自项目实际运行界面，覆盖首页入口、多人会议室、翻译消息和系统同传四个核心场景。

<table>
  <tr>
    <td align="center" width="50%">
      <strong>首页</strong><br />
      <img src="./public/screenshots/home.png" alt="MornSpeaker 首页" width="100%" />
    </td>
    <td align="center" width="50%">
      <strong>会议室主界面</strong><br />
      <img src="./public/screenshots/room.png" alt="MornSpeaker 会议室主界面" width="100%" />
    </td>
  </tr>
  <tr>
    <td align="center" width="50%">
      <strong>翻译消息</strong><br />
      <img src="./public/screenshots/translation-message.png" alt="MornSpeaker 翻译消息" width="100%" />
    </td>
    <td align="center" width="50%">
      <strong>系统同传</strong><br />
      <img src="./public/screenshots/system-audio.png" alt="MornSpeaker 系统同传" width="100%" />
    </td>
  </tr>
</table>

## 能力一览

| 能力 | 说明 | 主要入口 |
| --- | --- | --- |
| 实时语音翻译 | 支持语音采集、ASR 转写、多语言翻译和播报，内置中文、英语、日语、韩语、法语、德语、西班牙语、葡萄牙语等语言选项 | `/room/[roomId]` |
| 多人房间协作 | 房间创建与加入、成员列表、消息同步、房间权限和会话管理 | `/room`、`/api/rooms` |
| 音视频与实时通话 | 基于 WebRTC 与 TRTC SDK 支持通话信令、实时字幕和语音交流 | `components/voice-chat-interface.tsx` |
| 系统音频翻译 | 支持将系统音频作为输入进行转写和翻译 | `/system-audio` |
| 账号与登录 | 邮箱密码注册登录、找回密码，以及腾讯/微信相关登录流程 | `/login`、`/auth` |
| 管理后台 | 用户、房间、广告位、系统配置、发布包和 APK 管理 | `/admin` |
| 支付能力 | 创建订单、支付宝支付与异步通知处理 | `/pay/result`、`/api/pay` |
| 多端适配 | 支持网页端，并提供微信小程序 WebView 适配说明 | [`README_wechat.md`](./README_wechat.md) |

## 技术架构

```text
┌────────────────────────────────────────────────────────────┐
│                        Web / 微信小程序 WebView             │
│  登录 · 房间 · 麦克风 · 系统音频 · 语言选择 · 消息与通话      │
└──────────────────────────────┬─────────────────────────────┘
                               │
                               v
┌────────────────────────────────────────────────────────────┐
│                 Next.js App Router + Route Handlers          │
│  auth · rooms · ASR · translate · TTS · payment · admin      │
└───────────────┬──────────────────────┬─────────────────────┘
                │                      │
                v                      v
┌──────────────────────────┐  ┌──────────────────────────────┐
│ AI / 语音服务             │  │ 数据与平台适配层               │
│ Whisper · 腾讯云 ASR      │  │ Prisma + MySQL / MariaDB      │
│ Mistral · 智谱 · DashScope│  │ Supabase · CloudBase · Memory │
│ 浏览器 Speech Synthesis   │  │ 自动检测或 DB_PROVIDER 显式指定 │
└──────────────────────────┘  └──────────────────────────────┘
```

### 一次翻译请求的路径

1. 浏览器采集麦克风或系统音频，并按当前部署模式选择转写路径。
2. 转写文本进入 `/api/translate`，由 Mistral 或腾讯部署下的智谱/DashScope 完成翻译。
3. 翻译结果写入房间消息，其他成员通过房间接口获取同步内容。
4. 前端使用浏览器 Speech Synthesis 或 Android 原生 TTS 播放结果。

## 技术栈

| 层级 | 技术 |
| --- | --- |
| Web 框架 | Next.js 16 App Router、React 19、TypeScript |
| UI | Tailwind CSS 4、Radix UI、Framer Motion、Lucide React |
| 业务 API | Next.js Route Handlers、Zod、JWT、bcryptjs |
| 数据访问 | Prisma 6、MariaDB/MySQL、Supabase、CloudBase |
| 语音与通信 | 腾讯云 ASR、Whisper、Web Speech API、WebRTC、TRTC SDK |
| AI 翻译 | Mistral、智谱、DashScope |
| 支付 | Alipay SDK |

## 快速开始

### 环境要求

- Node.js `20.19.0` 或更高版本
- npm `10.x`
- 可用的 MySQL/MariaDB 数据库（账号、房间和业务数据使用）
- 至少配置一条翻译服务路线

项目已通过 `.nvmrc` 和 `.node-version` 固定推荐 Node.js 版本：

```bash
nvm use
```

### 安装依赖

```bash
npm install
```

### 配置环境变量

仓库未提供可直接使用的 `.env.example`，请在根目录创建 `.env.local`。下面是非腾讯部署的基础示例：

```bash
# Prisma / 业务数据库
DATABASE_URL="mysql://user:password@127.0.0.1:3306/mornspeaker"

# JWT 签名密钥，请替换为随机长字符串
JWT_SECRET="replace-with-a-long-random-string"

# 非腾讯部署的翻译服务
MISTRAL_API_KEY="your-mistral-api-key"
# 可选：Mistral 模型，默认使用 open-mistral-7b
# MISTRAL_TRANSLATE_MODEL="open-mistral-7b"

# 可选：显式指定房间存储实现
# DB_PROVIDER="mysql"       # mysql / supabase / cloudbase / memory
```

腾讯云部署需要同时设置服务端和客户端部署标识，并补充 ASR、翻译和 TRTC 配置：

```bash
DEPLOY_TARGET="tencent"
NEXT_PUBLIC_DEPLOY_TARGET="tencent"

DATABASE_URL="mysql://user:password@host:3306/mornspeaker"
TENCENT_DATABASE_URL="mysql://user:password@host:3306/mornspeaker"
JWT_SECRET="replace-with-a-long-random-string"

TENCENT_ASR_APP_ID="your-asr-app-id"
TENCENT_ASR_SECRET_ID="your-secret-id"
TENCENT_ASR_SECRET_KEY="your-secret-key"

# 二选一：智谱或 DashScope
TENCENT_ZHIPU_API_KEY="your-zhipu-api-key"
# TENCENT_DASHSCOPE_API_KEY="your-dashscope-api-key"

# 实时通话签名
TENCENT_TRTC_SDK_APP_ID="your-trtc-sdk-app-id"
TENCENT_TRTC_SECRET_KEY="your-trtc-secret-key"

# 可选：微信小程序登录
# NEXT_PUBLIC_WECHAT_APP_ID="your-wechat-app-id"
# WX_MINI_APPID="your-mini-program-app-id"
# WX_MINI_SECRET="your-mini-program-secret"
```

不要将真实 API Key、数据库密码、JWT 密钥或微信/腾讯云密钥提交到 Git 仓库。带有 `NEXT_PUBLIC_` 前缀的变量会进入浏览器端构建，只能放置确实允许公开的值。

### 初始化数据库并启动

```bash
npx prisma generate
npx prisma db push
npm run dev
```

开发服务器默认监听 `0.0.0.0:3000`，并启用 HTTPS，读取以下本地证书：

```text
.cert/localhost-key.pem
.cert/localhost-cert.pem
```

启动后访问 [https://localhost:3000](https://localhost:3000)。本地自签名证书可能触发浏览器安全提示。

## 常用命令

```bash
# 开发
npm run dev

# 生产构建与启动
npm run build
npm run start

# 启动前执行 Prisma 数据库同步（谨慎用于生产）
npm run start:migrate

# 静态检查
npm run lint
npm run typecheck

# 房间消息清理
npm run cleanup:rooms:dry
npm run cleanup:rooms
```

`npm run build` 会依次执行 schema 适配、Node/npm 版本输出、Prisma Client 生成和 Next.js 构建。

## 部署模式

房间存储由 `lib/store/index.ts` 统一选择，支持显式配置和环境自动检测：

| 场景 | 推荐配置 | 房间存储 | 翻译路线 |
| --- | --- | --- | --- |
| 本地开发 | `DB_PROVIDER=memory` 或 `mysql` | Memory 或 MySQL | Mistral |
| Vercel | 配置 Supabase 变量 | Supabase | Mistral |
| 腾讯云 | `DEPLOY_TARGET=tencent` | MySQL | 智谱或 DashScope |
| CloudBase | `DB_PROVIDER=cloudbase` 或使用 CloudBase 环境变量 | CloudBase | 按部署配置 |

生产环境建议显式设置 `DB_PROVIDER` 或部署标识，避免因平台环境变量变化而切换到非预期的存储实现。`memory` 仅适合本地体验，进程重启后房间数据会丢失。

## API 速览

| 路径 | 用途 |
| --- | --- |
| `GET /api/health` | 健康检查，不查询数据库 |
| `POST /api/translate` | 文本翻译 |
| `POST /api/transcribe` | 音频转写 |
| `GET /api/asr/realtime` | 创建腾讯云实时 ASR 签名 |
| `GET /api/tts?text=...&lang=...` | 获取语音播报音频 |
| `/api/rooms` | 房间、成员和消息操作 |
| `/api/auth/*` | 登录、注册、会话和微信回调 |
| `/api/pay/*` | 订单、支付宝创建和异步通知 |

健康检查示例：

```bash
curl -k https://localhost:3000/api/health
```

翻译接口冒烟检查：

```bash
curl -k -X POST https://localhost:3000/api/translate \
  -H 'content-type: application/json' \
  -d '{"text":"hello","sourceLanguage":"English","targetLanguage":"Chinese"}'
```

## 目录结构

```text
.
├── app/
│   ├── api/                 # 认证、房间、ASR、翻译、TTS、支付等接口
│   ├── admin/               # 管理后台
│   ├── auth/                # 认证页面
│   ├── login/               # 登录页面
│   ├── room/                # 房间列表与房间页面
│   └── system-audio/        # 系统音频翻译页面
├── components/              # 业务组件与通用 UI 组件
├── hooks/                   # React Hooks
├── lib/                     # 音频、鉴权、i18n、存储和第三方服务适配
├── prisma/                  # Prisma schema
├── public/                  # Logo、图标和静态资源
├── scripts/                 # 构建与运维脚本
├── rules/                   # CloudBase 相关规则文档
├── README.md                # 项目说明
└── README_wechat.md         # 微信小程序 WebView 适配指南
```

## 质量检查

当前仓库没有配置 Jest、Vitest、Playwright 或 Cypress，也没有 `test` script。提交前建议至少运行：

```bash
npm run lint
npm run typecheck
```

涉及翻译服务、数据库或第三方登录时，还应在对应环境变量齐全的开发环境中完成一次健康检查和接口冒烟验证。

## 相关文档

- [微信小程序 WebView 适配指南](./README_wechat.md)
- [MornSpeaker GitHub 仓库](https://github.com/lzylovec/MornSpeaker)

## License

本项目基于 MIT License 开源。

## 作者

`lzylovec`
