# MornSpeaker 🎙️

MornSpeaker 是一个基于 Next.js App Router 的实时语音翻译协作平台，支持语音识别、文本翻译、房间协作、用户认证、支付与后台管理。

作者：`lzylovec`

## 核心能力 ⚡

- 实时语音转写（腾讯云 ASR，含实时签名接口）
- 多语言文本翻译（按部署模式自动走不同模型/服务）
- 语音播放（TTS 代理）
- 房间聊天与成员协作（消息、会话、管理能力）
- 多端登录能力（邮箱密码、微信相关登录流程）
- 管理后台（广告位、发布包、系统配置等）

## 技术栈 🧱

- 前端：Next.js 16、React 19、TypeScript、Tailwind CSS 4、Radix UI
- 后端：Next.js Route Handlers
- 数据层：Prisma + MariaDB/MySQL（腾讯路径），并兼容 Supabase 相关能力
- AI/语音：Mistral / 智谱 / DashScope、腾讯云 ASR

## 环境要求 🧰

- Node.js `>=20.19.0`（见 `.node-version` / `.nvmrc`）
- npm `10.x`（项目锁定 `npm@10.9.2`）

## 快速开始 🚀

### 1) 安装依赖

```bash
npm install
```

### 2) 配置环境变量

项目当前未提供 `.env.example`，请在仓库根目录创建 `.env.local`，至少包含：

```bash
# 基础配置
DATABASE_URL="mysql://user:password@127.0.0.1:3306/mornspeaker"
JWT_SECRET="replace-with-a-long-random-string"

# 非腾讯部署时的翻译能力（必填其一条路线）
MISTRAL_API_KEY="your-mistral-api-key"

# 腾讯部署模式（DEPLOY_TARGET=tencent）常用配置
DEPLOY_TARGET="tencent"
TENCENT_DATABASE_URL="mysql://user:password@host:3306/mornspeaker"
TENCENT_ASR_SECRET_ID="xxx"
TENCENT_ASR_SECRET_KEY="xxx"
TENCENT_ASR_APP_ID="xxx"
TENCENT_ZHIPU_API_KEY="xxx" # 或 TENCENT_DASHSCOPE_API_KEY

# 可选：Supabase 实时/管理能力
NEXT_PUBLIC_SUPABASE_URL="https://xxx.supabase.co"
NEXT_PUBLIC_SUPABASE_ANON_KEY="xxx"
SUPABASE_SERVICE_ROLE_KEY="xxx"
```

### 3) 初始化 Prisma

```bash
npx prisma generate
npx prisma db push
```

### 4) 启动开发环境

```bash
npm run dev
```

说明：开发命令默认启用 HTTPS，并读取 `.cert/localhost-key.pem` 与 `.cert/localhost-cert.pem`。

## 常用命令 🛠️

```bash
# 本地开发
npm run dev

# 生产构建（会先执行 scripts/adapt-schema.js + prisma generate）
npm run build

# 生产启动
npm run start

# 启动前执行数据库 push（谨慎用于生产）
npm run start:migrate

# 代码检查
npm run lint
npm run typecheck

# 清理房间消息（脚本）
npm run cleanup:rooms:dry
npm run cleanup:rooms
```

## 目录结构 📁

```text
.
├── app/                    # 页面与 API（App Router）
│   ├── admin/              # 管理后台
│   ├── api/                # 业务接口（auth/rooms/translate/transcribe/...）
│   ├── auth/ login/ room/  # 核心业务页面
├── components/             # 业务组件与通用 UI 组件
├── hooks/                  # 自定义 hooks
├── lib/                    # 核心工具、数据访问、i18n、鉴权等
├── prisma/                 # Prisma schema
├── scripts/                # 构建/运维辅助脚本
├── rules/                  # CloudBase 相关规则文档
└── README_wechat.md        # 微信小程序接入说明
```

## 验证建议 ✅

当前仓库未配置标准测试框架（无 `test` script）。建议至少执行：

```bash
npm run lint
npm run typecheck
```

开发环境接口可快速冒烟验证：

```bash
curl -k -X POST https://localhost:3000/api/translate \
  -H 'content-type: application/json' \
  -d '{"text":"hello","sourceLanguage":"English","targetLanguage":"Chinese"}'
```

## 相关文档 📚

- 微信小程序套壳与网页端适配：`README_wechat.md`

## License 📄

MIT
