import { useAuth } from "@/features/auth/AuthProvider";
import { api, post } from "@/shared/api/client";
import { Account, Group, Job } from "@/shared/contracts";
import { short, time } from "@/shared/lib/format";
import { EmptyState, ErrorView, Loading, PageTitle, Status } from "@/shared/ui";
import {
  ArrowRightOutlined,
  PlusOutlined,
  RobotOutlined,
  TeamOutlined,
} from "@ant-design/icons";
import { useQuery } from "@tanstack/react-query";
import { Alert, App, Button, Form, Modal, Select, Table, Tag } from "antd";
import { useState } from "react";
import { Link } from "react-router-dom";
export default function GroupsPage() {
  const { user } = useAuth();
  const { message } = App.useApp();
  const q = useQuery({
    queryKey: ["groups"],
    queryFn: () => api<Group[]>("/groups"),
  });
  const aq = useQuery({
    queryKey: ["accounts"],
    queryFn: () => api<Account[]>("/accounts"),
  });
  const jobs = useQuery({
    queryKey: ["jobs"],
    queryFn: () => api<Job[]>("/jobs"),
    refetchInterval: 3000,
  });
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false);
  const [form] = Form.useForm();
  const accounts = (aq.data || []).filter((a) => a.status === "online");
  return (
    <>
      <PageTitle
        title="群组空间"
        description="让多人消息、自动应答与定时协作在同一处发生。"
        action={
          user?.role === "admin" && (
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={() => setOpen(true)}
            >
              新建群组
            </Button>
          )
        }
      />
      <ErrorView error={q.error} />
      {q.isLoading ? (
        <Loading />
      ) : (
        <div className="group-grid">
          {q.data?.map((g) => (
            <Link className="group-card" key={g.id} to={`/groups/${g.id}`}>
              <div className="group-card-top">
                <span className="group-icon">
                  <TeamOutlined />
                </span>
                <Status value={g.status} />
              </div>
              <h2>{g.name}</h2>
              <p className="mono">{g.gatewayGroupId.slice(0, 18)}…</p>
              <div className="group-card-stats">
                <span>
                  <TeamOutlined /> {g.members.length} 位成员
                </span>
                <span className={g.agentEnabled ? "accent" : ""}>
                  <RobotOutlined /> Agent {g.agentEnabled ? "已启用" : "未启用"}
                </span>
              </div>
              <div className="group-card-footer">
                <span>进入消息空间</span>
                <ArrowRightOutlined />
              </div>
            </Link>
          ))}
        </div>
      )}
      {!q.isLoading && !q.data?.length && (
        <section className="panel">
          <EmptyState text="连接至少两个账号后，即可新建第一个群组" />
        </section>
      )}
      <section className="panel job-panel">
        <div className="panel-heading">
          <h2>群生命周期任务</h2>
          <span className="muted">建群与退群的每一步均可追踪</span>
        </div>
        <Table
          rowKey="id"
          size="small"
          pagination={{ pageSize: 5 }}
          dataSource={jobs.data || []}
          expandable={{
            expandedRowRender: (j) => (
              <>
                <pre>{JSON.stringify(j.steps, null, 2)}</pre>
                {j.errors.map((e, i) => (
                  <Alert
                    key={i}
                    type="error"
                    message={`${e.step} · ${e.code}`}
                  />
                ))}
              </>
            ),
          }}
          columns={[
            {
              title: "任务",
              dataIndex: "id",
              render: (id) => <code>{short(id)}</code>,
            },
            {
              title: "类型",
              dataIndex: "kind",
              render: (k) => (k === "create" ? "建群与拉人" : "全部账号退群"),
            },
            {
              title: "状态",
              dataIndex: "status",
              render: (s) => <Status value={s} />,
            },
            {
              title: "当前步骤",
              dataIndex: "phase",
              render: (p, j) =>
                j.uncertain ? (
                  <Tag color="warning">待核实：{p}</Tag>
                ) : (
                  <code>{p}</code>
                ),
            },
            { title: "创建时间", dataIndex: "createdAt", render: time },
          ]}
        />
      </section>
      <Modal
        title="新建协作群"
        open={open}
        onCancel={() => setOpen(false)}
        confirmLoading={busy}
        okText="开始建群"
        cancelText="取消"
        onOk={() =>
          void form.validateFields().then(async (values) => {
            setBusy(true);
            try {
              await post("/groups", values);
              setOpen(false);
              form.resetFields();
              await jobs.refetch();
              message.success("建群任务已创建，请查看任务进度");
            } catch (e) {
              message.error((e as Error).message);
            } finally {
              setBusy(false);
            }
          })
        }
      >
        <p className="muted">
          网关建群、邀请成员并提升第一位成员为管理员。此操作异步执行。
        </p>
        <Form form={form} layout="vertical">
          <Form.Item
            name="creatorAccountId"
            label="群主账号"
            rules={[{ required: true, message: "请选择群主" }]}
          >
            <Select
              options={accounts.map((a) => ({ value: a.id, label: a.id }))}
            />
          </Form.Item>
          <Form.Item
            name="memberAccountIds"
            label="成员账号（第一位将成为管理员）"
            rules={[{ required: true, message: "请选择至少一位成员" }]}
          >
            <Select
              mode="multiple"
              options={accounts.map((a) => ({ value: a.id, label: a.id }))}
            />
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
}
