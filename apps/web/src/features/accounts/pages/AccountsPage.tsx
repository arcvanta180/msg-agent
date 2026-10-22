import { useAuth } from "@/features/auth/AuthProvider";
import { api, post } from "@/shared/api/client";
import { Account, canTransition } from "@/shared/contracts";
import { ErrorView, PageTitle, Status } from "@/shared/ui";
import {
  ApiOutlined,
  CheckCircleOutlined,
  ClockCircleOutlined,
  DeleteOutlined,
  DisconnectOutlined,
  LinkOutlined,
  ReloadOutlined,
  StopOutlined,
} from "@ant-design/icons";
import { useQuery } from "@tanstack/react-query";
import { App, Button, Space, Statistic, Table } from "antd";
import { useState } from "react";
export default function AccountsPage() {
  const { user } = useAuth();
  const { message, modal } = App.useApp();
  const [busy, setBusy] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ["accounts"],
    queryFn: () => api<Account[]>("/accounts"),
    refetchInterval: 5000,
  });
  const accounts = q.data || [];
  const operate = async (a: Account, to: string) => {
    setBusy(a.id);
    try {
      if (to === "online") await post(`/accounts/${a.id}/connect`);
      else
        await post(`/accounts/${a.id}/transition`, {
          to,
          expectedFrom: a.status,
        });
      await q.refetch();
      message.success("账号状态已更新");
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  return (
    <>
      <PageTitle
        title="服务账号"
        description="管理网关连接与账号生命周期，状态变化实时同步。"
        action={
          <Button icon={<ReloadOutlined />} onClick={() => void q.refetch()}>
            刷新状态
          </Button>
        }
      />
      <div className="stats-grid">
        <div className="stat">
          <span className="stat-icon">
            <ApiOutlined />
          </span>
          <Statistic title="全部账号" value={accounts.length} />
          <span>独立身份 · 统一管理</span>
        </div>
        <div className="stat">
          <span className="stat-icon">
            <CheckCircleOutlined />
          </span>
          <Statistic
            title="在线可用"
            value={accounts.filter((a) => a.status === "online").length}
            valueStyle={{ color: "#1677ff" }}
          />
          <span>可执行群内消息与工具</span>
        </div>
        <div className="stat">
          <span className="stat-icon">
            <ClockCircleOutlined />
          </span>
          <Statistic
            title="限流等待"
            value={accounts.filter((a) => a.status === "rate_limited").length}
          />
          <span>到期后按原顺序恢复</span>
        </div>
        <div className="stat">
          <span className="stat-icon">
            <StopOutlined />
          </span>
          <Statistic
            title="终态账号"
            value={
              accounts.filter((a) =>
                ["suspended", "session_expired"].includes(a.status),
              ).length
            }
          />
          <span>停用后不可恢复</span>
        </div>
      </div>
      <ErrorView error={q.error} />
      <section className="panel">
        <div className="panel-heading">
          <h2>
            账号列表 <span className="count">{accounts.length}</span>
          </h2>
          <span className="muted">仅在线群成员可承担发送任务</span>
        </div>
        <Table
          rowKey="id"
          loading={q.isLoading}
          dataSource={accounts}
          pagination={false}
          columns={[
            {
              title: "服务账号",
              dataIndex: "id",
              render: (id) => (
                <div className="identity">
                  <span className="avatar">{id.slice(-1)}</span>
                  <div>
                    <strong>{id}</strong>
                    <small>服务身份</small>
                  </div>
                </div>
              ),
            },
            {
              title: "状态",
              dataIndex: "status",
              render: (s) => <Status value={s} />,
            },
            {
              title: "平台用户标识",
              dataIndex: "platformUserId",
              render: (v) => <code>{v || "等待首次连接"}</code>,
            },
            {
              title: "限流截止",
              dataIndex: "rateLimitedUntil",
              render: (v) =>
                v ? new Date(v).toLocaleTimeString("zh-CN") : "—",
            },
            ...(user?.role === "admin"
              ? [
                  {
                    title: "操作",
                    key: "actions",
                    render: (_: unknown, a: Account) => (
                      <Space>
                        {canTransition(a.status, "online") && (
                          <Button
                            aria-label={a.status === "idle" ? "连接" : "重连"}
                            size="small"
                            icon={<LinkOutlined />}
                            loading={busy === a.id}
                            onClick={() => void operate(a, "online")}
                          >
                            {a.status === "idle" ? "连接" : "重连"}
                          </Button>
                        )}
                        {canTransition(a.status, "disconnected") && (
                          <Button
                            aria-label="标记离线"
                            size="small"
                            icon={<DisconnectOutlined />}
                            loading={busy === a.id}
                            onClick={() => void operate(a, "disconnected")}
                          >
                            标记离线
                          </Button>
                        )}
                        {canTransition(a.status, "suspended") && (
                          <Button
                            aria-label="释放账号"
                            disabled={busy === a.id}
                            size="small"
                            danger
                            icon={<DeleteOutlined />}
                            onClick={() =>
                              modal.confirm({
                                title: `释放 ${a.id}？`,
                                content:
                                  "账号将永久停用，并取消尚未发送的排队消息。",
                                okText: "释放账号",
                                cancelText: "取消",
                                onOk: () => operate(a, "suspended"),
                              })
                            }
                          >
                            释放账号
                          </Button>
                        )}
                      </Space>
                    ),
                  },
                ]
              : []),
          ]}
        />
      </section>
      <div className="footnote">
        限流只暂停消息发送；停用或会话失效会原子移除成员并取消排队消息。
      </div>
    </>
  );
}
