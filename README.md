# Relay · 多账号群组消息平台

NestJS + TypeORM + PostgreSQL / React 18 + TypeScript。实现服务账号、异步建群、可靠消息时间线、Agent 审计与工具循环、定时序列、会话轮换及断线补齐。网关与 Agent 由两个独立进程模拟，业务状态全部落入真实 PostgreSQL。

![Agent 执行轨迹](docs/console-agent.png)

## 快速启动

要求 Node.js ≥22.12、pnpm 9、Docker Desktop。

```bash
pnpm install --frozen-lockfile
docker compose up -d db
pnpm db:migrate
pnpm db:seed
pnpm dev
```

访问 <http://localhost:5173>。管理员 `admin / admin`；只读查看者 `viewer / viewer`。默认 4 个待连接服务账号，连接至少 3 个后可建群（第一位成员会提升为管理员）。

也可全部容器化运行：

```bash
docker compose up --build -d
```

数据库端口 54329，API 3000，Mock Gateway 3101，Mock Agent 3102，Web 5173，均绑定本机。迁移为独立一次性服务，API 检查 schema 落后即拒绝启动。`docker compose down` 保留数据卷，重新启动不会清空业务数据。

若本机已缓存 PostgreSQL 16 的兼容镜像，可使用 `POSTGRES_IMAGE=pgvector/pgvector:pg16 docker compose up -d db`。本项目不使用其向量扩展。

## 演示流程

1. 登录，依次连接 `acct-1`、`acct-2`、`acct-3`。
2. 群组空间 → 新建群组：群主 acct-1，成员依次 acct-2、acct-3。查看下方异步任务进度；完成后进入群。
3. 选择发送账号并发送消息，观察 queued / accepted / sent 状态。
4. 打开启用 Agent。以群详情中展示的网关群 ID 注入一条外部消息：

```bash
curl -X POST http://localhost:3101/__inject \
  -H 'Content-Type: application/json' \
  -d '{"groupId":"替换为 gatewayGroupId","text":"你好，请介绍一下活动"}'
```

5. 群详情会实时出现访客消息和 Agent 回复。打开右侧最近的 Agent 运行，检查每一步、入参、审计、结果和原始响应。
6. 定时序列页选择群组，填写 vars 与 stepVars，预检确认变量值和来源后启动，查看逐步排期。
7. viewer 登录后写按钮不可见；直接调用写 API 仍返回 403。

## 故障演示

Mock 端点只供本地开发。规则按顺序消费，支持 `operation`、`accountId`、`groupId`、`times`。详见 [模拟服务](docs/MOCKS.md)。

```bash
# 下一条 send 返回 504，1.5 秒后实际落地；后端只查询，不重发
curl -X POST http://localhost:3101/__control \
  -H 'Content-Type: application/json' \
  -d '{"faults":[{"operation":"send","code":"NETWORK_TIMEOUT","land":true,"settleMs":1500}]}'

# 下一次 send 限流 3 秒，其间账号队列不得再调用 send
curl -X POST http://localhost:3101/__control \
  -H 'Content-Type: application/json' \
  -d '{"faults":[{"operation":"send","code":"RATE_LIMITED","retryAfterSeconds":3}]}'

# 对事件重复投递，验证去重
curl -X POST http://localhost:3101/__control \
  -H 'Content-Type: application/json' \
  -d '{"settings":{"duplicateEvents":true}}'
```

## 检查与测试

```bash
pnpm typecheck
pnpm build
pnpm test
pnpm test:e2e
pnpm format:check
pnpm audit
```

集成测试自动创建 `msg_agent_test_<pid>` 独立数据库，启动独立 API/模拟服务，执行真实 SIGKILL、重启与数据库故障注入，然后删除测试库。测试数据库用户需要 CREATEDB 权限；Compose 预置用户具备该权限。测试使用按进程隔离的动态端口，避免不同测试运行互相干扰；本地请求绕过系统代理。

Playwright 默认使用已安装的 Google Chrome，连接本地演示服务；无 Chrome 时安装 Playwright Chromium 并把配置中的 `channel: 'chrome'` 删除。端到端测试创建有效演示群和消息，不清空已有数据库。

## 配置

默认值可直接启动。自定义时将 `.env.example` 中需要的变量导出到 shell；Node.js 进程不会隐式读取 `.env`。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| DATABASE_URL | postgres://msg:msg@localhost:54329/msg_agent | PostgreSQL |
| PORT | 3000 | API 监听端口 |
| GATEWAY_URL | http://localhost:3101 | 网关 HTTP/SSE 地址 |
| AGENT_URL | http://localhost:3102 | Agent turn/audit 地址 |
| WEB_ORIGIN | http://localhost:5173 | 浏览器来源/CORS/CSRF 校验 |
| ACCESS_TTL_SECONDS | 900 | access 有效期，测试可缩短 |
| TURN_TIMEOUT_MS | 12000 | 单轮 Agent 超时 |
| AUDIT_TIMEOUT_MS | 3000 | 单次审计超时 |
| COOKIE_SECURE | false | HTTPS 环境设置为 true |
| API_PROXY | http://localhost:3000 | Vite 的 API/WS 转发地址 |

## 工程地图与交付边界

- `apps/api/src/`：鉴权、领域服务、持久工作流、SSE inbox、WS 广播。
- `apps/web/src/`：`app` 负责应用组装/路由/主题，`features` 按业务组织页面与状态，`shared` 提供 API、协议入口、通用组件与基础样式。
- `apps/mock-gateway/`、`apps/mock-agent/`：独立模拟服务，状态/事件/延迟任务持久化。
- `packages/contracts/`：状态机、工具 schema、变量解析、消息版本合并。
- `packages/db/`：TypeORM schema、migration、幂等 seed。
- [实现说明与恢复边界](docs/IMPLEMENTATION.md)、[验收记录](docs/ACCEPTANCE.md)、[原始需求](docs/全栈开发工程师笔试题-候选人版.md)。
- [技术实现总结](docs/TECHNICAL_SUMMARY.md)：模块结构、消息可靠性、Agent 审计、序列与安全机制。
- [完整演示视频与录制说明](docs/DEMO.md)：中文旁白、字幕与 19 个功能章节；`pnpm demo:video` 可重新录制。

本地代码与 Git 历史为交付物，未公开发布。选做 C1（媒体下载/清理）、C2（真实 LLM）不在当前实现内。原协议缺少幂等/查回能力时，任意崩溃后的自动完成与绝不重复无法同时无条件保证；具体窗口、保留现场行为与方案简化见实现说明。
