// Records the actual application against an isolated PostgreSQL database.
// Requires macOS `say`, ffmpeg/ffprobe, Google Chrome, and a built server.
const { chromium, expect } = require("@playwright/test");
const { spawn, execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const root = path.resolve(__dirname, "../..");
const out = path.join(root, "media/demo");
fs.mkdirSync(out, { recursive: true });
process.env.NO_PROXY = "localhost,127.0.0.1";
const apiPort = 3300,
  gwPort = 3301,
  agentPort = 3302,
  webPort = 5373;
const base = `http://127.0.0.1:${apiPort}`;
const gw = `http://127.0.0.1:${gwPort}`;
const ag = `http://127.0.0.1:${agentPort}`;
const web = `http://localhost:${webPort}`;
const children = [];
const scenes = [];
const resume = process.env.DEMO_RESUME
  ? JSON.parse(fs.readFileSync(process.env.DEMO_RESUME, "utf8"))
  : null;
let browser, context, page, token, group, adminDb, demoDb, createdDatabaseName;
let startedAt = 0;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
function log(text) {
  console.log(new Date().toISOString(), text);
}
async function until(fn, check, timeout = 20000) {
  const end = Date.now() + timeout;
  let value;
  while (Date.now() < end) {
    value = await fn();
    if (check(value)) return value;
    await pause(150);
  }
  throw new Error(`等待超时: ${JSON.stringify(value).slice(0, 1200)}`);
}
async function http(url, body, method) {
  const response = await fetch(url, {
    method: method || (body === undefined ? "GET" : "POST"),
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await response.json();
  if (!response.ok)
    throw new Error(`${response.status} ${url}: ${JSON.stringify(json)}`);
  return json;
}
const api = (p, b, m) => http(base + "/api" + p, b, m);
const tool = (id, name, input) => ({
  body: {
    stop_reason: "tool_use",
    content: [{ type: "tool_use", id, name, input }],
  },
});
const finish = (summary) => tool("done", "finish", { summary });
async function select(locator, text) {
  await locator.first().click();
  await pause(250);
  await page
    .locator(".ant-select-dropdown:visible .ant-select-item-option")
    .filter({ hasText: new RegExp(`^${text}$`) })
    .last()
    .click();
}
async function login(username = "admin") {
  await page.getByLabel("用户名", { exact: true }).fill(username);
  await page.getByLabel("密码", { exact: true }).fill(username);
  await page.getByRole("button", { name: "进入工作空间" }).click();
  await expect(
    page.getByRole("button", { name: "退出登录", exact: true }),
  ).toBeVisible();
  await page.getByRole("link", { name: "服务账号", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "服务账号", exact: true }),
  ).toBeVisible();
}
async function showGroup() {
  await page.goto(web + "/groups/" + group.id);
  await expect(page.getByRole("heading", { name: /消息时间线/ })).toBeVisible();
}
async function scrollMessages() {
  await page
    .locator(".message-list")
    .evaluate((e) => (e.scrollTop = e.scrollHeight));
}
async function send(text) {
  await page.getByLabel("消息内容", { exact: true }).fill(text);
  const response = page.waitForResponse(
    (r) =>
      r.url().endsWith(`/api/groups/${group.id}/send`) &&
      r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  const result = await (await response).json();
  assert.ok(result.message?.id, JSON.stringify(result));
  await scrollMessages();
  return result.message;
}
async function settled(message) {
  return until(
    () => api(`/groups/${group.id}/messages?limit=100`),
    (r) =>
      r.items.some((m) => m.id === message.id && m.deliveryStatus === "sent"),
  );
}
async function trigger(text, extra = {}) {
  const previous = (await api(`/groups/${group.id}/agent-runs`)).map(
    (r) => r.id,
  );
  await http(gw + "/__inject", {
    groupId: group.gatewayGroupId,
    text,
    ...extra,
  });
  const runs = await until(
    () => api(`/groups/${group.id}/agent-runs`),
    (r) => r.some((x) => !previous.includes(x.id) && x.status !== "running"),
  );
  return runs.find((x) => !previous.includes(x.id));
}
async function openRun(run) {
  await page.locator(`a[href="/agent-runs/${run.id}"]`).click();
  await expect(
    page.getByRole("heading", { name: "Agent 运行详情" }),
  ).toBeVisible();
}
function escape(s) {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
function duration(file) {
  return Number(
    execFileSync(
      "ffprobe",
      [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "csv=p=0",
        file,
      ],
      { encoding: "utf8" },
    ).trim(),
  );
}
const chapters = [
  [
    "登录与工作空间",
    "欢迎来到 Relay 消息协作平台。这段视频将从登录开始，完整演示账号管理、建群、消息、智能应答、定时编排以及异常恢复。画面来自实际运行的应用，网关和智能体使用本地模拟服务，业务数据写入真实数据库。",
  ],
  [
    "服务账号 · 连接与状态",
    "进入工作空间后，首先连接三个服务账号。上方统计卡片会同步显示在线数量，下方保留每个账号的平台身份和状态。账号既能承担群主与管理员角色，也能独立发送消息，后端会检查合法的状态迁移。",
  ],
  [
    "异步建群 · 邀请与角色提升",
    "现在创建协作群。选择第一个账号作为群主，再依次选择第二、第三个账号作为成员。建群是异步任务：后台创建群组、邀请成员、确认加入，并将首位成员提升为管理员，每一步都能在任务列表中查看。",
  ],
  [
    "消息时间线 · 多账号发送",
    "进入群组后，左侧是消息时间线，右侧是自动应答策略、成员和运行记录。选择发送账号，输入欢迎消息。系统先持久化，再进入发送队列；网关受理不等于发出，收到确认后，状态才更新为已发出。",
  ],
  [
    "Agent · 外部消息自动回复",
    "开启自动应答后，通过本地模拟网关注入一条访客消息。访客消息实时进入时间线，并触发智能体读取上下文和自动回复。自己的消息不会再次触发智能体，避免无限回复循环。整个过程不需要刷新页面。",
  ],
  [
    "执行轨迹 · 参数、审计与结果",
    "打开刚才的运行记录。这里逐步展示读取消息、发送消息和结束运行。展开工具入参、完整结果和原始响应，可以检查模型实际请求了什么。涉及发送的操作必须先通过审计，轨迹同时保留审计结论和尝试次数。",
  ],
  [
    "内容审计 · 拒绝执行",
    "接下来演示审计拒绝。模拟智能体提出一条被拒绝的发送请求，运行轨迹会显示审计失败，并记录工具错误。被拒绝的文字不会发送到群里；智能体仍可继续结束运行，留下可追溯的说明。",
  ],
  [
    "审计异常 · 阻塞保护",
    "如果审计服务连续三次没有返回明确结论，系统不会默认放行。当前运行进入审计阻塞状态，页面清楚显示原因，工具没有执行。这个场景通过模拟服务注入故障，但页面展示的状态和执行记录来自真实后端。",
  ],
  [
    "成员治理 · 策略与审计双重检查",
    "自动移除成员需要单独开启群级策略，并且仍然要通过审计。现在启用开关，模拟一个违规访客，再让智能体请求移除。通过审计后，网关执行移除，成员列表和运行记录随事件同步更新。",
  ],
  [
    "序列模板 · 添加与保存",
    "定时序列用于编排多条消息。先添加一个双角色模板：管理员发送活动通知，普通成员随后补充资料位置。每一步指定角色、文本和相对延迟，文本支持占位变量。保存后，模板即可在编排面板中复用。",
  ],
  [
    "变量校验 · 缺失值阻止启动",
    "启动之前先做变量预检。这里故意缺少资料位置，系统会指出具体步骤和变量，不会创建运行，也不会发送任何消息。补齐默认变量后，再设置分步覆盖，让第二步使用专属资料目录。",
  ],
  [
    "预检与执行 · 角色及排期",
    "预检窗口展示每一步的最终消息和变量来源。确认后序列开始运行，管理员和普通成员依次发送，进度持续更新。下一步从前一步确认发出后开始计时，而不是只看接口是否受理。展开记录即可查看实际排期与完成时间。",
  ],
  [
    "限流恢复 · 账号队列顺延",
    "现在通过模拟网关给下一次发送注入限流。第一条消息进入等待，第二条消息也必须留在同一账号的队列中。等待结束后，两条消息按原顺序发出，系统不会在限流期间不断重试，避免延长封锁时间。",
  ],
  [
    "发送超时 · 查回而非重发",
    "接着模拟一次请求超时，但消息稍后已经落地。系统把结果标为待核实，并通过客户端消息编号查询原发送，最终更新为已发出。录制脚本同时检查网关调用次数，确认只发送过一次，避免超时造成重复消息。",
  ],
  [
    "断线重连 · 补齐遗漏消息",
    "现在暂时断开浏览器网络。页面出现连接恢复提示；断线期间注入的访客消息仍由网关和后端保存。恢复网络后，客户端带上最后收到的事件序号重连，补齐遗漏消息，不必手动刷新，也不会重复插入。",
  ],
  [
    "只读权限 · 刷新恢复会话",
    "退出管理员，改用只读查看者登录。页面仍能查看账号、群组、消息和执行轨迹，但写按钮被隐藏，策略开关不可操作。刷新页面后，会话通过安全的续期机制恢复。服务端也会拒绝只读账号的写请求。",
  ],
  [
    "群生命周期 · 所有账号退群",
    "回到管理员身份，演示退出群内所有服务账号。确认后生成异步任务，非群主先退出，群主最后退出。任务完成后，群组标为已退出，公开成员列表清空，消息历史和任务记录仍然保留，便于后续核查。",
  ],
  [
    "账号生命周期 · 离线、重连与停用",
    "最后检查账号生命周期。在线账号可以离线，并通过重连恢复可用。永久释放则需要二次确认，停用后不会再出现重连按钮。这个操作只针对独立演示数据库中的备用账号，不影响已有项目数据。",
  ],
  [
    "技术实现与演示完成",
    "演示到这里结束。前端使用 React、Ant Design 和查询缓存，后端按鉴权、账号、群组、消息、智能体和序列拆分 Nest 模块。数据库保存任务阶段和事件，协调工作进程负责恢复。完整技术说明和可重复录制脚本已经随项目提供。",
  ],
];

async function prepareAudio() {
  for (let i = 0; i < chapters.length; i++) {
    const [title, text] = chapters[i];
    // Per-sentence synthesis gives subtitle timing from the actual audio duration.
    const lines = text.match(/[^。！？]+[。！？]?/g).filter(Boolean);
    const subtitles = [];
    for (let j = 0; j < lines.length; j++) {
      const file = path.join(out, `voice-${i}-${j}.aiff`);
      if (!fs.existsSync(file))
        execFileSync("say", [
          "-v",
          process.env.DEMO_VOICE || "Tingting",
          "-r",
          "210",
          "-o",
          file,
          lines[j],
        ]);
      subtitles.push({ text: lines[j], duration: duration(file), file });
    }
    const list = path.join(out, `voice-${i}.txt`);
    fs.writeFileSync(list, subtitles.map((s) => `file '${s.file}'`).join("\n"));
    const audio = path.join(out, `voice-${i}.wav`);
    execFileSync("ffmpeg", [
      "-y",
      "-v",
      "error",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      list,
      "-ar",
      "48000",
      "-ac",
      "1",
      audio,
    ]);
    scenes.push({
      index: i,
      title,
      text,
      audio,
      subtitles,
      voiceDuration: duration(audio),
    });
    log(`旁白 ${i + 1}/${chapters.length}: ${title}`);
  }
}
async function scene(index, action) {
  if (resume && index < resume.scenes.length) return;
  const s = scenes[index];
  s.start = (Date.now() - startedAt) / 1000;
  log(`录制 ${index + 1}/${scenes.length}: ${s.title}`);
  await action();
  await page.screenshot({ path: path.join(out, `scene-${index}.png`) });
  const elapsed = (Date.now() - startedAt) / 1000 - s.start;
  await pause(
    process.env.DEMO_FAST
      ? 500
      : Math.max(500, (s.voiceDuration + 1 - elapsed) * 1000),
  );
  s.duration = (Date.now() - startedAt) / 1000 - s.start;
  fs.writeFileSync(
    path.join(out, "scenes.json"),
    JSON.stringify(scenes, null, 2),
  );
}

async function run() {
  await prepareAudio();
  if (resume) {
    for (const saved of resume.scenes) {
      Object.assign(scenes[saved.index], saved, {
        sourceVideo: resume.rawVideo,
      });
    }
    log(`复用已完成的 ${resume.scenes.length} 个真实录制章节`);
  }
  const {
    createDataSource,
    Database,
    seed,
  } = require("../../dist/packages/db/src");
  const databaseName = `msg_agent_demo_${Date.now()}`;
  const databaseUrl = new URL(
    process.env.DATABASE_URL || "postgres://msg:msg@127.0.0.1:54329/msg_agent",
  );
  adminDb = await createDataSource().initialize();
  await adminDb.query(`CREATE DATABASE "${databaseName}"`);
  createdDatabaseName = databaseName;
  databaseUrl.pathname = "/" + databaseName;
  process.env.DATABASE_URL = databaseUrl.toString();
  demoDb = await createDataSource().initialize();
  await demoDb.runMigrations();
  await seed(new Database(demoDb));
  const env = {
    ...process.env,
    PORT: String(apiPort),
    MOCK_GATEWAY_PORT: String(gwPort),
    MOCK_AGENT_PORT: String(agentPort),
    GATEWAY_URL: gw,
    AGENT_URL: ag,
    WEB_ORIGIN: web,
    API_PROXY: base,
  };
  const fd = fs.openSync(path.join(out, "services.log"), "w");
  for (const app of ["mock-gateway", "mock-agent", "api"])
    children.push(
      spawn(process.execPath, [`dist/apps/${app}/src/main.js`], {
        cwd: root,
        env,
        stdio: ["ignore", fd, fd],
      }),
    );
  children.push(
    spawn(
      "pnpm",
      [
        "exec",
        "vite",
        "preview",
        "--config",
        "apps/web/vite.config.ts",
        "--port",
        String(webPort),
      ],
      { cwd: root, env, stdio: ["ignore", fd, fd] },
    ),
  );
  await until(async () => {
    try {
      return (await fetch(base + "/api/health")).ok && (await fetch(web)).ok;
    } catch {
      return false;
    }
  }, Boolean);
  token = (await api("/auth/login", { username: "admin", password: "admin" }))
    .accessToken;
  browser = await chromium.launch({ channel: "chrome", headless: true });
  context = await browser.newContext({
    viewport: { width: 1600, height: 900 },
    deviceScaleFactor: 1,
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
    recordVideo: { dir: out, size: { width: 1600, height: 900 } },
  });
  await context.addInitScript(() => {
    const NativeWebSocket = window.WebSocket;
    window.__demoSockets = [];
    window.WebSocket = class extends NativeWebSocket {
      constructor(...args) {
        super(...args);
        window.__demoSockets.push(this);
      }
    };
    document.addEventListener("DOMContentLoaded", () => {
      const cursor = document.createElement("div");
      cursor.style.cssText =
        "position:fixed;width:22px;height:22px;border:2px solid #1677ff;border-radius:50%;background:#1677ff22;pointer-events:none;z-index:2147483647;left:-100px;top:-100px;transition:transform .12s;";
      document.body.append(cursor);
      document.addEventListener("mousemove", (e) => {
        cursor.style.left = e.clientX - 11 + "px";
        cursor.style.top = e.clientY - 11 + "px";
      });
      document.addEventListener(
        "mousedown",
        () => (cursor.style.transform = "scale(1.7)"),
      );
      document.addEventListener(
        "mouseup",
        () => (cursor.style.transform = "scale(1)"),
      );
    });
  });
  page = await context.newPage();
  startedAt = Date.now();
  page.setDefaultTimeout(15000);
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await page.goto(web);
  if (resume) {
    for (const id of ["acct-1", "acct-2", "acct-3"]) {
      await api(`/accounts/${id}/connect`, {});
    }
    await login();
  }
  await scene(0, async () => {
    await expect(page.getByRole("heading", { name: "欢迎回来" })).toBeVisible();
    await pause(2500);
    await login();
  });
  await scene(1, async () => {
    for (const id of ["acct-1", "acct-2", "acct-3"]) {
      await page
        .getByRole("row")
        .filter({ has: page.getByText(id, { exact: true }) })
        .getByRole("button", { name: "连接", exact: true })
        .click();
      await pause(650);
    }
    await until(
      () => api("/accounts"),
      (a) => a.filter((x) => x.status === "online").length === 3,
    );
  });
  await scene(2, async () => {
    await page.getByRole("link", { name: "群组空间", exact: true }).click();
    await page.getByRole("button", { name: "新建群组" }).click();
    await select(page.getByLabel("群主账号", { exact: true }), "acct-1");
    await select(
      page.getByLabel("成员账号（第一位将成为管理员）", { exact: true }),
      "acct-2",
    );
    await page
      .locator(".ant-select-dropdown:visible .ant-select-item-option")
      .filter({ hasText: /^acct-3$/ })
      .last()
      .click();
    await page.keyboard.press("Escape");
    const response = page.waitForResponse(
      (r) =>
        r.url() === base + "/api/groups" ||
        (r.url().endsWith("/api/groups") && r.request().method() === "POST"),
    );
    await page.getByRole("button", { name: "开始建群" }).click();
    const { jobId } = await (await response).json();
    assert.ok(jobId);
    const job = await until(
      () => api("/jobs/" + jobId),
      (j) => j.status !== "running",
    );
    assert.equal(job.status, "finished");
    group = await api("/groups/" + job.groupId);
    assert.equal(group.members.length, 3);
    await page.locator(".ant-table-row-expand-icon").first().click();
  });
  await scene(3, async () => {
    await page.locator(`a[href="/groups/${group.id}"]`).click();
    await select(page.getByLabel("发送账号", { exact: true }), "acct-1");
    await http(gw + "/__control", { settings: { sendDelayMs: 1200 } });
    const msg = await send(
      "大家好，欢迎参加产品分享会！活动将在今天 16:00 开始。",
    );
    await settled(msg);
  });
  await scene(4, async () => {
    await page.getByRole("switch", { name: "启用 Agent", exact: true }).click();
    await http(ag + "/__control", { script: [], audits: [] });
    const run = await trigger("你好，请问活动资料在哪里？");
    assert.equal(run.status, "finished");
    await scrollMessages();
  });
  await scene(5, async () => {
    const run = (await api(`/groups/${group.id}/agent-runs`))[0];
    await openRun(run);
    const sendStep = page.locator(".trace-step").filter({
      has: page.getByRole("heading", { name: "send_message", exact: true }),
    });
    await sendStep.getByText("工具入参", { exact: true }).click();
    await sendStep.getByText("原始响应", { exact: true }).click();
    await sendStep.scrollIntoViewIfNeeded();
  });
  await scene(6, async () => {
    await showGroup();
    await http(ag + "/__control", {
      script: [
        tool("denied", "send_message", {
          text: "[拒绝] 不应发送的演示内容",
          idempotency_key: "denied-demo",
        }),
        finish("审计拒绝了发送，未产生消息效果。"),
      ],
      audits: [],
    });
    const run = await trigger("请演示一次内容审计拒绝");
    assert.ok(run.steps.some((s) => s.auditVerdict === "fail"));
    assert.ok(
      !(await api(`/groups/${group.id}/messages?limit=100`)).items.some(
        (m) => m.text === "[拒绝] 不应发送的演示内容",
      ),
    );
    await openRun(run);
  });
  await scene(7, async () => {
    await showGroup();
    await http(ag + "/__control", {
      script: [
        tool("blocked", "send_message", {
          text: "审计异常时禁止发送",
          idempotency_key: "blocked-demo",
        }),
      ],
      audits: [{ status: 503 }, { status: 503 }, { status: 503 }],
    });
    const run = await trigger("请演示审计服务异常");
    assert.equal(run.status, "blocked");
    await openRun(run);
  });
  await scene(8, async () => {
    await showGroup();
    await page
      .getByRole("switch", { name: "允许自动移除", exact: true })
      .click();
    await http(ag + "/__control", {
      script: [
        tool("kick", "kick_user", {
          platform_user_id: "moderation-demo",
          reason: "本地成员治理演示",
        }),
        finish("违规访客已通过审计并移除。"),
      ],
      audits: [],
    });
    const run = await trigger("这是一条成员治理演示消息", {
      senderPlatformUserId: "moderation-demo",
    });
    assert.equal(run.status, "finished");
    assert.ok(
      !(await http(gw + "/__state")).groups[group.gatewayGroupId].members[
        "moderation-demo"
      ],
    );
    await openRun(run);
    await page
      .locator(".trace-step")
      .first()
      .getByText("完整工具结果", { exact: true })
      .click();
    await http(ag + "/__control", { script: [], audits: [] });
  });
  await scene(9, async () => {
    await page.getByRole("link", { name: "定时序列", exact: true }).click();
    await page.getByRole("button", { name: "添加序列模板" }).click();
    await page.getByLabel("序列模板定义", { exact: true }).fill(
      JSON.stringify(
        {
          name: "发布会 · 双角色提醒",
          steps: [
            {
              index: 1,
              accountRole: "admin",
              text: "欢迎参加 {event}，我们将在 {time} 开始。",
              delaySeconds: 2,
            },
            {
              index: 2,
              accountRole: "member",
              text: "{event} 的资料已放在 {location}，欢迎查阅。",
              delaySeconds: 2,
            },
          ],
        },
        null,
        2,
      ),
    );
    await page.getByRole("button", { name: "保存模板" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await select(
      page.getByLabel("序列模板", { exact: true }),
      "发布会 · 双角色提醒",
    );
  });
  await scene(10, async () => {
    await page
      .getByLabel("默认变量", { exact: true })
      .fill('{"event":"产品分享会","time":"今天 16:00"}');
    await page.getByLabel("分步变量", { exact: true }).fill("{}");
    await page.getByRole("button", { name: "预检变量与排期" }).click();
    await expect(
      page.getByText("UNRESOLVED_PLACEHOLDER", { exact: false }),
    ).toBeVisible();
    await pause(2500);
    await page
      .getByLabel("默认变量", { exact: true })
      .fill(
        '{\n  "event": "产品分享会",\n  "time": "今天 16:00",\n  "location": "共享文档"\n}',
      );
    await page
      .getByLabel("分步变量", { exact: true })
      .fill('{\n  "2": { "location": "共享盘/发布会资料" }\n}');
  });
  await scene(11, async () => {
    await page.getByRole("button", { name: "预检变量与排期" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await pause(3500);
    await page.getByRole("button", { name: "确认启动" }).click();
    const runs = await until(
      () => api(`/groups/${group.id}/sequence-runs`),
      (r) => r.length && r[0].status === "finished",
    );
    assert.ok(runs[0].steps.every((s) => s.status === "sent"));
    await page.locator(".ant-table-row-expand-icon").first().click();
  });
  await scene(12, async () => {
    await showGroup();
    await select(page.getByLabel("发送账号", { exact: true }), "acct-1");
    await http(gw + "/__control", {
      faults: [
        {
          operation: "send",
          accountId: "acct-1",
          code: "RATE_LIMITED",
          retryAfterSeconds: 4,
        },
      ],
    });
    const first = await send("限流恢复演示：消息一，保持原始队列顺序。");
    const second = await send("限流恢复演示：消息二，不抢先发送。");
    await settled(first);
    await settled(second);
    await scrollMessages();
    const calls = (await http(gw + "/__state")).calls.filter(
      (c) =>
        c.operation === "send" &&
        [first.clientMsgId, second.clientMsgId].includes(c.body.clientMsgId),
    );
    assert.equal(calls.at(-1).body.clientMsgId, second.clientMsgId);
  });
  await scene(13, async () => {
    await http(gw + "/__control", {
      faults: [
        {
          operation: "send",
          code: "NETWORK_TIMEOUT",
          land: true,
          settleMs: 1800,
        },
      ],
    });
    const msg = await send("超时查回演示：这条消息只会发送一次。");
    await settled(msg);
    await scrollMessages();
    const calls = (await http(gw + "/__state")).calls.filter(
      (c) => c.operation === "send" && c.body.clientMsgId === msg.clientMsgId,
    );
    assert.equal(calls.length, 1);
    log("超时不重发断言通过：send 调用 = 1");
  });
  await scene(14, async () => {
    await page.getByRole("switch", { name: "启用 Agent", exact: true }).click();
    await context.setOffline(true);
    await page.evaluate(() =>
      window.__demoSockets.forEach((socket) => socket.close()),
    );
    await expect(
      page.getByText("实时连接正在恢复，重连后将自动补齐断线期间的事件。"),
    ).toBeVisible();
    await http(gw + "/__inject", {
      groupId: group.gatewayGroupId,
      text: "断线期间的消息：网络恢复后自动补齐。",
    });
    await pause(2500);
    await context.setOffline(false);
    await expect(
      page.getByText("断线期间的消息：网络恢复后自动补齐。", { exact: true }),
    ).toBeVisible();
    await scrollMessages();
    assert.equal(
      await page
        .getByText("断线期间的消息：网络恢复后自动补齐。", { exact: true })
        .count(),
      1,
    );
  });
  await scene(15, async () => {
    await page.getByRole("button", { name: "退出登录", exact: true }).click();
    await login("viewer");
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "服务账号", exact: true }),
    ).toBeVisible();
    await showGroup();
    assert.equal(
      await page.getByRole("button", { name: "发送消息", exact: true }).count(),
      0,
    );
    await expect(
      page.getByRole("switch", { name: "启用 Agent", exact: true }),
    ).toBeDisabled();
    const viewerToken = (
      await api("/auth/login", { username: "viewer", password: "viewer" })
    ).accessToken;
    const denied = await fetch(base + `/api/groups/${group.id}/send`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + viewerToken,
      },
      body: JSON.stringify({ accountId: "acct-1", text: "只读写入应该失败" }),
    });
    assert.equal(denied.status, 403);
    log("只读服务端权限断言通过：403");
  });
  await scene(16, async () => {
    await page.getByRole("button", { name: "退出登录", exact: true }).click();
    await login();
    await showGroup();
    await page.getByRole("button", { name: "全部退群", exact: true }).click();
    const response = page.waitForResponse((r) =>
      r.url().endsWith(`/api/groups/${group.id}/leave-all`),
    );
    await page.getByRole("button", { name: "确认退群", exact: true }).click();
    const { jobId } = await (await response).json();
    const job = await until(
      () => api("/jobs/" + jobId),
      (j) => j.status !== "running",
    );
    assert.equal(job.status, "finished");
    const after = await api("/groups/" + group.id);
    assert.equal(after.status, "left");
    assert.equal(after.members.length, 0);
    await page.getByRole("link", { name: "群组空间", exact: true }).click();
  });
  await scene(17, async () => {
    await page.getByRole("link", { name: "服务账号", exact: true }).click();
    const row = page
      .getByRole("row")
      .filter({ has: page.getByText("acct-1", { exact: true }) });
    await row.getByRole("button", { name: "标记离线", exact: true }).click();
    await pause(800);
    await row.getByRole("button", { name: "重连", exact: true }).click();
    const spare = page
      .getByRole("row")
      .filter({ has: page.getByText("acct-4", { exact: true }) });
    await spare.getByRole("button", { name: "连接", exact: true }).click();
    await expect(spare.getByText("在线", { exact: true })).toBeVisible();
    await spare.getByRole("button", { name: "释放账号", exact: true }).click();
    await pause(1500);
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "释放账号", exact: true })
      .click();
    await expect(spare.getByText("已停用", { exact: true })).toBeVisible();
    assert.equal(
      await spare.getByRole("button", { name: "重连", exact: true }).count(),
      0,
    );
  });
  await scene(18, async () => {
    assert.deepEqual(pageErrors, []);
    await page.mouse.move(450, 250);
  });
  const rawVideo = await page.video().path();
  await context.close();
  context = undefined;
  fs.writeFileSync(
    path.join(out, "recording.json"),
    JSON.stringify({ databaseName, rawVideo, scenes, pageErrors }, null, 2),
  );
  log("真实操作录制完成，开始合成旁白与字幕");
  if (process.env.DEMO_FAST) {
    log("快速验收：19 个场景全部通过");
    return;
  }
  const overlay = await browser.newPage({
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
  });
  const segments = [];
  let total = 0;
  const srt = [];
  const chapterMetadata = [";FFMETADATA1"];
  function timecode(sec) {
    const ms = Math.round(sec * 1000);
    return `${String(Math.floor(ms / 3600000)).padStart(2, "0")}:${String(Math.floor(ms / 60000) % 60).padStart(2, "0")}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")},${String(ms % 1000).padStart(3, "0")}`;
  }
  for (const s of scenes) {
    const images = [];
    let cursor = 0;
    for (let j = 0; j < s.subtitles.length; j++) {
      const line = s.subtitles[j];
      const end =
        j === s.subtitles.length - 1 ? s.duration : cursor + line.duration;
      await overlay.setContent(
        `<html><meta charset="utf-8"><style>*{box-sizing:border-box}body{margin:0;background:transparent;color:#fff;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}header{height:72px;position:absolute;top:0;left:0;right:0;display:flex;align-items:center;justify-content:space-between;padding:0 48px;background:#0c1e3a}h1{margin:0;font-size:26px;font-weight:500}b{color:#69b1ff;margin-right:18px}header span{font-size:17px;color:#9cb7df}footer{position:absolute;bottom:0;left:0;right:0;height:108px;background:#0c1e3a;display:flex;align-items:center;justify-content:center;padding:10px 90px;font-size:28px;line-height:1.5;text-align:center}footer div{max-width:1640px}</style><header><h1><b>${String(s.index + 1).padStart(2, "0")}</b>${escape(s.title)}</h1><span>RELAY / 全流程功能演示 · 本地模拟环境</span></header><footer><div>${escape(line.text)}</div></footer></html>`,
      );
      const file = path.join(out, `overlay-${s.index}-${j}.png`);
      await overlay.screenshot({ path: file, omitBackground: true });
      images.push({ file, start: cursor, end });
      srt.push(
        `${srt.length + 1}\n${timecode(total + cursor)} --> ${timecode(total + end)}\n${line.text}\n`,
      );
      cursor = end;
    }
    const args = [
      "-y",
      "-v",
      "error",
      "-ss",
      String(s.start),
      "-t",
      String(s.duration),
      "-i",
      s.sourceVideo || rawVideo,
      "-i",
      s.audio,
    ];
    for (const img of images) args.push("-i", img.file);
    let filter = "[0:v]fps=24,pad=1920:1080:160:72:color=0x0c1e3a[base];";
    let previous = "base";
    for (let j = 0; j < images.length; j++) {
      const img = images[j],
        next = "v" + j;
      filter += `[${previous}][${j + 2}:v]overlay=0:0:enable='between(t,${img.start},${img.end})'[${next}];`;
      previous = next;
    }
    filter += "[1:a]apad[a]";
    const segment = path.join(out, `part-${s.index}.mp4`);
    args.push(
      "-filter_complex",
      filter,
      "-map",
      `[${previous}]`,
      "-map",
      "[a]",
      "-t",
      String(s.duration),
      "-c:v",
      "libx264",
      "-preset",
      "fast",
      "-crf",
      "22",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      segment,
    );
    execFileSync("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    segments.push(segment);
    chapterMetadata.push(
      `[CHAPTER]\nTIMEBASE=1/1000\nSTART=${Math.round(total * 1000)}\nEND=${Math.round((total + s.duration) * 1000)}\ntitle=${s.title}`,
    );
    s.finalStart = total;
    total += s.duration;
    log(`合成 ${s.index + 1}/${scenes.length}`);
  }
  await overlay.close();
  const concat = path.join(out, "parts.txt");
  fs.writeFileSync(concat, segments.map((f) => `file '${f}'`).join("\n"));
  fs.writeFileSync(
    path.join(out, "chapters.ffmeta"),
    chapterMetadata.join("\n"),
  );
  const final = path.join(out, "relay-full-demo.mp4");
  execFileSync("ffmpeg", [
    "-y",
    "-v",
    "error",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    concat,
    "-f",
    "ffmetadata",
    "-i",
    path.join(out, "chapters.ffmeta"),
    "-map_metadata",
    "1",
    "-c",
    "copy",
    "-movflags",
    "+faststart",
    final,
  ]);
  fs.writeFileSync(path.join(out, "relay-full-demo.srt"), srt.join("\n"));
  fs.writeFileSync(
    path.join(out, "recording.json"),
    JSON.stringify(
      {
        databaseName,
        rawVideo,
        scenes,
        pageErrors,
        final,
        duration: duration(final),
      },
      null,
      2,
    ),
  );
  log(`完成: ${final} (${duration(final).toFixed(1)} 秒)`);
}
run()
  .catch(async (error) => {
    console.error(error);
    if (page)
      await page
        .screenshot({ path: path.join(out, "failure.png") })
        .catch(() => {});
    process.exitCode = 1;
  })
  .finally(async () => {
    for (const child of children) child.kill("SIGTERM");
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    if (demoDb?.isInitialized) await demoDb.destroy().catch(() => {});
    if (adminDb?.isInitialized) {
      if (createdDatabaseName) {
        await pause(1000);
        await adminDb.query(
          "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()",
          [createdDatabaseName],
        );
        await adminDb.query(`DROP DATABASE "${createdDatabaseName}"`);
      }
      await adminDb.destroy();
    }
  });
