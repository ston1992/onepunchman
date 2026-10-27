# Twinly

面向北美 PC 用户的"工作分身"：用户在桌面端（Mac / Windows）描述任务，**数字孪生**在云端沙箱里完成工作，按用户本人的语气和习惯交付文档、表格和报告，并且越用越像本人。

> 产品名 Twinly、域名 twinly.app、公司名 Twinly, Inc. 都是占位，上线前请替换（见文末清单）。

## 产品

| 功能 | 说明 |
|---|---|
| 账号 | 邮箱 + 密码注册；验证邮箱后才能派任务（防止批量注册薅免费额度）；忘记密码可通过邮件重置；重置后旧会话全部失效 |
| 数字孪生 | 个人档案 + 写作样本 + 自动学到的偏好，存在每个用户自己的云端记忆库里 |
| 任务 | 每个任务一个云端沙箱：实时时间线、敏感操作需审批、可中途追加指令或停止、交付物一键保存到 `文稿/Twinly/` |
| 持续学习 | 用户说"短一点""别用 emoji"这类话，孪生会写进 `learned/preferences.md`，之后的任务都照做 |
| 计费 | Free：每月 $2 用量；Pro：每月 $25 用量（建议售价 $39/月，在 Stripe 里设置）。通过 Stripe Checkout 升级，在 Customer Portal 管理订阅 |
| 合规 | 隐私政策（含 CCPA 条款）、服务条款；删除账号会同时删除孪生、云端会话、任务记录，并取消订阅 |

## 架构

```
 桌面端 (Electron + React)              后端 (Fastify + SQLite)                 Anthropic
┌──────────────────────────┐  HTTPS  ┌──────────────────────────────┐  SDK  ┌────────────────────────┐
│ renderer：界面            │ ──────> │ /v1/auth   注册 登录 验证 重置 │ ────> │ Managed Agents          │
│ main：API 客户端、SSE 订阅 │ <────── │ /v1/twin   档案 写作样本       │       │  Agent：孪生（全局一份）│
│  token 存系统钥匙串        │   SSE   │ /v1/tasks  任务 事件流 文件    │ <──── │  Session：每任务一个沙箱│
└──────────────────────────┘         │ /v1/billing  Stripe            │       │  Memory Store：每用户一个│
                                     │ 额度控制 · 任务归属校验         │       └────────────────────────┘
                                     └──────────────────────────────┘
```

- **API 密钥只在服务端**。桌面端只持有用户自己的登录 token，并用系统钥匙串加密保存（macOS Keychain / Windows DPAPI）。
- **花费控制分两层**：每个任务在 Anthropic 侧有硬性上限（默认 $5，且不超过用户本月剩余额度）；运行中的任务按其全部预算预占额度，所以并行开多个任务也无法超支。
- **可靠性**：服务器重启后会自动接回运行中的任务，从中断处补齐事件；云端事件流断开会自动重连，事件不丢不重。

## 目录

```
apps/server/      后端
  src/app.ts            路由、鉴权、校验
  src/tasks.ts          任务 = 云端会话：事件流、断线重连、重启恢复、费用结算
  src/twin.ts           用户记忆库（数字孪生）
  src/agent-definition.ts  孪生代理的系统提示词、模型、工具
  src/billing.ts        Stripe
  src/mail.ts           邮件（Resend）
  src/legal.ts          隐私政策、服务条款、重置密码页面
  scripts/setup-cloud.ts   创建或更新云环境与代理
  scripts/fake-server.ts   用模拟的 Anthropic 启动后端（不花钱，开发界面用）
  test/                 17 个集成测试
apps/desktop/     桌面端
  src/main/             API 客户端、SSE、钥匙串
  src/renderer/src/     登录、孪生设置、任务界面
packages/shared/  前后端共用的类型
```

## 本地开发

需要 Node 22.13 或更高版本。

```bash
npm install

# 不需要任何密钥：用模拟后端开发界面
npm run dev:fake -w @twinly/server      # 终端 1，监听 :8787
npm run dev:desktop                     # 终端 2

# 使用真实云端
cp apps/server/.env.example apps/server/.env   # 填 ANTHROPIC_API_KEY、JWT_SECRET
npm run setup:cloud -w @twinly/server          # 创建云环境和代理，ID 自动写回 .env
npm run dev:server
npm run dev:desktop

npm run typecheck && npm test                  # CI 跑的就是这两条
```

## 部署后端

后端是一个 Docker 镜像，数据库是挂载在 `/data` 的 SQLite 文件。推荐 Fly.io 或 Railway，单实例加一块持久卷即可。

```bash
docker build -f apps/server/Dockerfile -t twinly-server .
docker run -p 8787:8787 -v twinly-data:/data --env-file apps/server/.env twinly-server
```

生产环境需要设置的变量见 `apps/server/.env.example`：`ANTHROPIC_API_KEY`、`JWT_SECRET`、`TWIN_*`、`PUBLIC_URL`、`STRIPE_*`、`RESEND_API_KEY`。

Stripe Webhook 地址填 `https://<你的域名>/v1/billing/webhook`，订阅以下事件：`checkout.session.completed`、`customer.subscription.created`、`customer.subscription.updated`、`customer.subscription.deleted`。

## 打包桌面端

```bash
cd apps/desktop
TWINLY_API_URL=https://api.twinly.app npm run dist:mac   # 在 Mac 上运行：签名并公证
TWINLY_API_URL=https://api.twinly.app npm run dist:win   # 在 Windows 上或 CI 中运行：代码签名
```

签名所需的环境变量：Mac 需要 `CSC_LINK`、`CSC_KEY_PASSWORD`、`APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID`；Windows 需要 `CSC_LINK` 和 `CSC_KEY_PASSWORD`（或者用 Azure Trusted Signing）。

## 上线清单（需要你本人操作的部分）

1. **品牌**：定产品名，注册域名，并替换 `legal.ts` 里的公司名和联系邮箱；在 `apps/desktop/build/` 放应用图标（`icon.icns` / `icon.ico`）。
2. **法律**：成立公司（如 Delaware C-Corp）；请律师审阅 `/privacy` 和 `/terms`，这两份是起草稿。
3. **账号与密钥**：
   - Anthropic API 密钥，运行一次 `setup:cloud`；
   - Stripe：创建 Pro 价格（建议 $39/月），开启 Stripe Tax，配置 Webhook；
   - Resend：验证发信域名；
   - 签名证书：Apple Developer（$99/年），以及 Windows 代码签名证书。
4. **部署**：后端部署到 `api.<你的域名>`，然后用这个地址打包桌面端。
5. **试运行**：先用自己的账号走一遍完整流程，看真实任务的质量和单次成本，再按实际成本调整套餐额度（`config.ts` 里的 `PLAN_LIMIT_CENTS`）。
