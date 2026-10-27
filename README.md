# Twinly（暂定名）

面向北美 PC 用户的"工作分身"桌面应用：用户在桌面端描述任务，**数字孪生**在云端沙箱里完成工作，并按用户本人的语气和习惯交付成果（文档、表格、报告）。

## 架构

```
┌──────────── Electron 桌面端 ────────────┐        ┌──────────── Anthropic 云 ────────────┐
│ renderer (React)                         │        │ Managed Agents                        │
│  ├ 孪生设置：个人档案 + 写作样本         │  IPC   │  ├ Agent：Twinly Work Twin（全局一份）│
│  └ 任务页：时间线 / 审批 / 交付物        │ <────> │  ├ Session：每个任务一个云端容器      │
│ main (Node)                              │  SDK   │  │   bash / 文件 / 代码在容器里执行   │
│  ├ twin.ts   读写用户的记忆库            │ <────> │  └ Memory Store：每个用户一个"孪生"   │
│  └ tasks.ts  建会话、收事件流、下载产出  │        │      profile.md / writing-samples/    │
└──────────────────────────────────────────┘        │      learned/preferences.md           │
                                                    └───────────────────────────────────────┘
```

- **数字孪生 = 记忆库（Memory Store）**：里面存个人档案、写作样本，以及代理从用户纠正中学到的偏好。每个任务都会把记忆库挂载进容器，代理先读档案再干活；用户说"短一点""别用 emoji"这类话，代理会写进 `learned/preferences.md`，下次就记得。
- **云端沙箱 = Managed Agents 会话**：代理循环和执行环境都由 Anthropic 托管，不用自己维护虚拟机。每个任务设有硬性花费上限（默认 5 美元）。
- **交付物**：代理把成果写到 `/mnt/session/outputs/`；任务完成后自动下载到 `~/Documents/Twinly/<任务ID>/`。
- **审批**：工具权限策略为 `auto`。服务端判断不了是否安全的操作，会在界面上弹出"允许 / 拒绝"。

## 本地运行

```bash
npm install
cp .env.example .env          # 填入 ANTHROPIC_API_KEY
npm run setup:cloud           # 创建云环境和代理，ID 自动写回 .env
npm run dev
```

`npm run setup:cloud -- --web` 会开启联网搜索和网页抓取，同时放开沙箱的出网限制。默认关闭；开启前请确认能接受这一点。

修改 `src/main/core/agent-definition.ts`（系统提示词、模型、工具）后，重新运行 `npm run setup:cloud`。它会更新已有代理并生成新版本，不会重复创建。

## 目录

| 路径 | 作用 |
|---|---|
| `scripts/setup-cloud.ts` | 一次性创建/更新云环境和代理 |
| `src/main/core/agent-definition.ts` | 孪生代理的系统提示词、模型和工具 |
| `src/main/core/twin.ts` | 用户记忆库：档案、写作样本 |
| `src/main/core/tasks.ts` | 任务 = 会话：事件流、断线重连、审批、下载产出 |
| `src/main/core/local-state.ts` | 本地 JSON：记忆库 ID、任务列表 |
| `src/renderer/src/` | 界面：孪生设置、新任务、任务时间线 |

## 上线前必须做的

1. **加后端服务**。现在 API Key 放在桌面端，只适合开发。上线时要把 `twin.ts` / `tasks.ts` 搬到服务端，桌面端只通过你的服务器访问。
2. **账号和计费**：登录（如 Clerk、Auth0）、Stripe 订阅或积分，并把每个用户映射到自己的记忆库。
3. **合规**：隐私政策、CCPA 数据删除（删除记忆库即可删除孪生）、服务条款。
4. **打包签名**：Mac 公证、Windows 代码签名（electron-builder）。
