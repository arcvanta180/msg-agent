import { test, expect } from "@playwright/test";
let groupId = "",
  gatewayGroupId = "";
test.beforeAll(async ({ request }) => {
  const login = await request.post("http://localhost:3000/api/auth/login", {
    data: { username: "admin", password: "admin" },
  });
  const { accessToken } = await login.json();
  const headers = { authorization: `Bearer ${accessToken}` };
  const accounts = await (
    await request.get("http://localhost:3000/api/accounts", { headers })
  ).json();
  for (const a of accounts)
    if (["idle", "disconnected"].includes(a.status))
      await request.post(`http://localhost:3000/api/accounts/${a.id}/connect`, {
        headers,
        data: {},
      });
  const groups = await (
    await request.get("http://localhost:3000/api/groups", { headers })
  ).json();
  let group = groups.find(
    (g: any) => g.status === "active" && g.members.length >= 3,
  );
  if (!group) {
    const created = await request.post("http://localhost:3000/api/groups", {
      headers,
      data: {
        creatorAccountId: "acct-1",
        memberAccountIds: ["acct-2", "acct-3"],
      },
    });
    const { jobId } = await created.json();
    await expect
      .poll(
        async () => {
          const job = await (
            await request.get(`http://localhost:3000/api/jobs/${jobId}`, {
              headers,
            })
          ).json();
          groupId = job.groupId;
          return job.status;
        },
        { timeout: 15000 },
      )
      .toBe("finished");
    group = await (
      await request.get(`http://localhost:3000/api/groups/${groupId}`, {
        headers,
      })
    ).json();
  }
  groupId = group.id;
  gatewayGroupId = group.gatewayGroupId;
  await request.patch(`http://localhost:3000/api/groups/${groupId}`, {
    headers,
    data: { agentEnabled: true },
  });
});
async function login(page: any, username = "admin") {
  await page.goto("/");
  await page.getByLabel("用户名", { exact: true }).fill(username);
  await page.getByLabel("密码", { exact: true }).fill(username);
  await page.getByRole("button", { name: "进入工作空间" }).click();
  await expect(
    page.getByRole("heading", { name: "服务账号", exact: true }),
  ).toBeVisible();
}
test("C3 登录 → 群详情 → 外部消息触发 → 查看 Agent 步骤", async ({
  page,
  request,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await login(page);
  await page.getByRole("link", { name: "群组空间" }).click();
  await page.locator(`a[href="/groups/${groupId}"]`).click();
  await expect(page.getByRole("heading", { name: "消息时间线" })).toBeVisible();
  const previousLink = page.locator("a.run-item").first();
  const previousHref = (await previousLink.count())
    ? await previousLink.getAttribute("href")
    : null;
  const text = `浏览器验收 ${Date.now()}`;
  await request.post("http://localhost:3101/__inject", {
    data: { groupId: gatewayGroupId, text },
  });
  await expect(page.getByText(text, { exact: true })).toBeVisible({
    timeout: 8000,
  });
  const link = page.locator("a.run-item").first();
  await expect(link).toBeVisible({ timeout: 8000 });
  if (previousHref)
    await expect(link).not.toHaveAttribute("href", previousHref);
  await link.click();
  await expect(
    page.getByRole("heading", { name: "Agent 运行详情" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "send_message", exact: true }),
  ).toBeVisible({ timeout: 10000 });
  await expect(
    page.getByText("已读取上下文并回复，等待下一条消息。", { exact: true }),
  ).toBeVisible({ timeout: 10000 });
  await page.screenshot({ path: "docs/console-agent.png", fullPage: true });
  expect(errors).toEqual([]);
});
test("viewer 页面无写按钮，刷新后通过 cookie 恢复登录", async ({ page }) => {
  await login(page, "viewer");
  await expect(
    page.getByRole("button", { name: "连接", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole("button", { name: "标记离线" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "释放账号" })).toHaveCount(0);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "服务账号", exact: true }),
  ).toBeVisible();
  await page.getByRole("link", { name: "群组空间" }).click();
  await expect(page.getByRole("button", { name: "新建群组" })).toHaveCount(0);
  await page.locator(`a[href="/groups/${groupId}"]`).click();
  await expect(page.getByRole("button", { name: "发送消息" })).toHaveCount(0);
  await expect(page.getByRole("switch").first()).toBeDisabled();
});
test("定时序列展示变量预检与来源", async ({ page }) => {
  await login(page);
  await page.getByRole("link", { name: "定时序列" }).click();
  await page.getByRole("button", { name: "预检变量与排期" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByText("启动前预检", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("dialog").getByText("step:2", { exact: true }),
  ).toHaveCount(2);
  await page.getByRole("button", { name: "返回修改" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});
