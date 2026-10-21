import { useAuth } from "@/features/auth/AuthProvider";
import { useStream } from "@/features/realtime/StreamProvider";
import { SequencePanel } from "@/features/sequences/components/SequencePanel";
import { api, patch, post } from "@/shared/api/client";
import {
  Account,
  AgentRun,
  Group,
  mergeMessages,
  Message,
} from "@/shared/contracts";
import { label, short, time } from "@/shared/lib/format";
import { EmptyState, ErrorView, Loading, PageTitle, Status } from "@/shared/ui";
import {
  ArrowRightOutlined,
  ClockCircleOutlined,
  LogoutOutlined,
  RobotOutlined,
  SendOutlined,
} from "@ant-design/icons";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  App,
  Button,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Switch,
  Tag,
} from "antd";
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
export default function GroupDetailPage() {
  const { id } = useParams();
  const { user } = useAuth();
  const { message, modal } = App.useApp();
  const stream = useStream();
  const query = useQueryClient();
  const gq = useQuery({
    queryKey: ["group", id],
    queryFn: () => api<Group>(`/groups/${id}`),
  });
  const aq = useQuery({
    queryKey: ["accounts"],
    queryFn: () => api<Account[]>("/accounts"),
  });
  const rq = useQuery({
    queryKey: ["agent-runs", id],
    queryFn: () => api<AgentRun[]>(`/groups/${id}/agent-runs`),
  });
  const mq = useQuery({
    queryKey: ["messages", id],
    queryFn: () =>
      api<{ items: Message[]; nextCursor: string | null; snapshotSeq: string }>(
        `/groups/${id}/messages?limit=30`,
      ),
  });
  const [items, setItems] = useState<Message[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [loadingMore, setLoadingMore] = useState(false),
    [sending, setSending] = useState(false),
    [sequenceOpen, setSequenceOpen] = useState(false);
  const [form] = Form.useForm();
  useEffect(() => {
    setItems([]);
    setCursor(null);
  }, [id]);
  useEffect(() => {
    if (mq.data) {
      setItems((old) => mergeMessages(old, mq.data.items));
      setCursor(mq.data.nextCursor);
    }
  }, [mq.data]);
  useEffect(() => {
    setItems((old) => mergeMessages(old, stream.messages[id!] || []));
  }, [stream.messages, id]);
  const group = gq.data;
  if (gq.isLoading) return <Loading />;
  if (!group) return <ErrorView error={gq.error} />;
  const admin = user?.role === "admin";
  const available = group.members.filter(
    (m) =>
      m.accountId &&
      aq.data?.some(
        (a) =>
          a.id === m.accountId && ["online", "rate_limited"].includes(a.status),
      ),
  );
  const update = async (body: object) => {
    try {
      await patch(`/groups/${id}`, body);
      await gq.refetch();
    } catch (e) {
      message.error((e as Error).message);
    }
  };
  const loadMore = async () => {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const page = await api<{ items: Message[]; nextCursor: string | null }>(
        `/groups/${id}/messages?before=${encodeURIComponent(cursor)}&limit=30`,
      );
      setItems((old) => mergeMessages(old, page.items));
      setCursor(page.nextCursor);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoadingMore(false);
    }
  };
  return (
    <>
      <Link className="back-link" to="/groups">
        ← 所有群组
      </Link>
      <PageTitle
        title={group.name}
        description={`网关群 ID · ${group.gatewayGroupId}`}
        action={
          <Space>
            <Status value={group.status} />
            {admin && group.status === "active" && (
              <>
                <Button
                  icon={<ClockCircleOutlined />}
                  onClick={() => setSequenceOpen(true)}
                >
                  定时序列
                </Button>
                <Button
                  danger
                  aria-label="全部退群"
                  icon={<LogoutOutlined />}
                  onClick={() =>
                    modal.confirm({
                      title: "退出群内所有服务账号？",
                      content: "非群主先退出，全部成功后群主最后退出。",
                      okText: "确认退群",
                      cancelText: "取消",
                      onOk: async () => {
                        try {
                          await post(`/groups/${id}/leave-all`);
                          message.success("退群任务已创建");
                        } catch (e) {
                          message.error((e as Error).message);
                        }
                      },
                    })
                  }
                >
                  全部退群
                </Button>
              </>
            )}
          </Space>
        }
      />
      <div className="conversation-layout">
        <section className="panel timeline">
          <div className="panel-heading">
            <h2>
              消息时间线 <span className="count">{items.length}</span>
            </h2>
            <span className={stream.online ? "live" : "muted"}>
              ● {stream.online ? "实时同步" : "重连补齐中"}
            </span>
          </div>
          <div className="message-list">
            <div className="load-earlier">
              {cursor ? (
                <Button
                  type="text"
                  loading={loadingMore}
                  onClick={() => void loadMore()}
                >
                  加载更早
                </Button>
              ) : (
                <span>— 已加载的消息起点 —</span>
              )}
            </div>
            <ErrorView error={mq.error} />
            {!items.length && (
              <EmptyState text="还没有消息。发送一条消息，开始协作。" />
            )}
            {[...items].reverse().map((m) => (
              <article
                key={m.id}
                className={`message-row ${m.isOwn ? "own" : ""}`}
              >
                <span className={`avatar ${m.isOwn ? "own-avatar" : ""}`}>
                  {m.isOwn ? "服" : "访"}
                </span>
                <div className="message-content">
                  <div className="message-meta">
                    <strong>{m.accountId || m.senderPlatformUserId}</strong>
                    {m.source === "agent" && <Tag>Agent</Tag>}
                    <time>{time(m.sentAt)}</time>
                  </div>
                  <div className="bubble">{m.text}</div>
                  <div className="delivery">
                    {m.isOwn && <Status value={m.deliveryStatus} />}
                    <code>{m.failCode}</code>
                    {m.deliveryStatus === "unknown" && (
                      <span className="amber">正在向网关核实，暂不重发</span>
                    )}
                  </div>
                </div>
              </article>
            ))}
          </div>
          {admin && group.status === "active" && !group.closing && (
            <Form
              className="composer"
              form={form}
              onFinish={async (values) => {
                setSending(true);
                try {
                  const result = await post<{ message: Message }>(
                    `/groups/${id}/send`,
                    values,
                  );
                  setItems((old) => mergeMessages(old, [result.message]));
                  form.setFieldValue("text", "");
                } catch (e) {
                  message.error((e as Error).message);
                } finally {
                  setSending(false);
                }
              }}
            >
              <Form.Item
                name="accountId"
                rules={[{ required: true, message: "请选择发送账号" }]}
              >
                <Select
                  aria-label="发送账号"
                  placeholder="选择发送账号"
                  options={available.map((a) => ({
                    value: a.accountId,
                    label: a.accountId,
                  }))}
                />
              </Form.Item>
              <Form.Item
                name="text"
                rules={[{ required: true, message: "请输入消息" }]}
              >
                <Input.TextArea
                  aria-label="消息内容"
                  placeholder="输入群消息…"
                  autoSize={{ minRows: 2, maxRows: 5 }}
                  maxLength={10000}
                />
              </Form.Item>
              <div className="composer-footer">
                <span>先持久化，再发送 · 状态实时可见</span>
                <Button
                  type="primary"
                  aria-label="发送消息"
                  icon={<SendOutlined />}
                  htmlType="submit"
                  loading={sending}
                >
                  发送消息
                </Button>
              </div>
            </Form>
          )}
        </section>
        <aside className="group-sidebar">
          <section className="panel">
            <div className="panel-heading">
              <h2>自动应答</h2>
              <RobotOutlined />
            </div>
            <div className="policy-row">
              <div>
                <strong>启用 Agent</strong>
                <p>外部消息触发自动处理</p>
              </div>
              <Switch
                aria-label="启用 Agent"
                checked={group.agentEnabled}
                disabled={!admin || group.status !== "active"}
                onChange={(v) => void update({ agentEnabled: v })}
              />
            </div>
            <div className="policy-row">
              <div>
                <strong>允许自动移除</strong>
                <p>执行前仍须通过内容审计</p>
              </div>
              <Switch
                aria-label="允许自动移除"
                checked={group.autoKickEnabled}
                disabled={!admin || group.status !== "active"}
                onChange={(v) => void update({ autoKickEnabled: v })}
              />
            </div>
          </section>
          <section className="panel">
            <div className="panel-heading">
              <h2>群成员</h2>
              <Tag>{group.members.length}</Tag>
            </div>
            <div className="member-list">
              {group.members.map((m) => (
                <div className="member" key={m.platformUserId}>
                  <span className="avatar small">
                    {m.accountId?.slice(-1) || "访"}
                  </span>
                  <div>
                    <strong>{m.accountId || "外部用户"}</strong>
                    <small>{m.platformUserId}</small>
                  </div>
                  <Status value={m.role} />
                </div>
              ))}
            </div>
          </section>
          <section className="panel">
            <div className="panel-heading">
              <h2>最近的 Agent 运行</h2>
              <span className="count">{rq.data?.length || 0}</span>
            </div>
            {!rq.data?.length ? (
              <EmptyState text="启用后，由外部消息触发" />
            ) : (
              <div className="run-list">
                {rq.data.map((r) => (
                  <Link
                    to={`/agent-runs/${r.id}`}
                    key={r.id}
                    className={
                      r.status === "blocked" ? "run-item blocked" : "run-item"
                    }
                  >
                    <div>
                      <code>{short(r.id)}</code>
                      <Status value={r.status} />
                    </div>
                    <p>
                      {label(r.endReason)} · {r.steps?.length || 0} 步{" "}
                      <ArrowRightOutlined />
                    </p>
                  </Link>
                ))}
              </div>
            )}
          </section>
        </aside>
      </div>
      <Modal
        title="定时序列"
        open={sequenceOpen}
        onCancel={() => setSequenceOpen(false)}
        footer={null}
        width={850}
        destroyOnHidden
      >
        <SequencePanel groupId={id!} />
      </Modal>
    </>
  );
}
