import { useAuth } from "@/features/auth/AuthProvider";
import { api, post } from "@/shared/api/client";
import {
  SequenceDefinition,
  SequenceRun,
  SequenceStep,
} from "@/shared/contracts";
import { time } from "@/shared/lib/format";
import { ErrorView, Status } from "@/shared/ui";
import { FileSearchOutlined } from "@ant-design/icons";
import { useQuery } from "@tanstack/react-query";
import { App, Button, Input, Modal, Progress, Select, Table, Tag } from "antd";
import { useState } from "react";
export function SequencePanel({ groupId }: { groupId: string }) {
  const { user } = useAuth();
  const { message } = App.useApp();
  const sq = useQuery({
    queryKey: ["sequences"],
    queryFn: () => api<SequenceDefinition[]>("/sequences"),
  });
  const rq = useQuery({
    queryKey: ["sequence-runs", groupId],
    queryFn: () => api<SequenceRun[]>(`/groups/${groupId}/sequence-runs`),
    refetchInterval: 2000,
  });
  const [sequenceId, setSequenceId] = useState("welcome"),
    [varsText, setVarsText] = useState(
      '{\n  "event": "产品分享会",\n  "time": "今天 16:00",\n  "location": "共享文档"\n}',
    ),
    [stepText, setStepText] = useState(
      '{\n  "2": { "location": "共享盘/活动资料" }\n}',
    ),
    [preview, setPreview] = useState<SequenceStep[] | null>(null),
    [error, setError] = useState<unknown>(null),
    [busy, setBusy] = useState(false),
    [previewBody, setPreviewBody] = useState<object | null>(null);
  const buildBody = () => ({
    sequenceId,
    vars: JSON.parse(varsText),
    stepVars: JSON.parse(stepText),
  });
  const check = async () => {
    setBusy(true);
    setError(null);
    try {
      const body = buildBody();
      const result = await post<{ steps: SequenceStep[] }>(
        `/sequences/${sequenceId}/preview`,
        { vars: body.vars, stepVars: body.stepVars },
      );
      setPreviewBody(body);
      setPreview(result.steps);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const start = async () => {
    setBusy(true);
    try {
      await post(`/groups/${groupId}/sequence-runs`, previewBody!);
      setPreview(null);
      await rq.refetch();
      message.success("序列已启动");
    } catch (e) {
      setError(e);
      setPreview(null);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="sequence-form">
        <div className="sequence-selector">
          <label>选择序列模板</label>
          <Select
            aria-label="序列模板"
            value={sequenceId}
            onChange={setSequenceId}
            options={sq.data?.map((s) => ({ value: s.id, label: s.name }))}
          />
          <p className="muted">每一步在前一步确认发出后排期；限流时顺延。</p>
        </div>
        <div className="variables-grid">
          <div>
            <label>默认变量 vars</label>
            <Input.TextArea
              aria-label="默认变量"
              value={varsText}
              onChange={(e) => setVarsText(e.target.value)}
              rows={7}
              className="code-input"
            />
          </div>
          <div>
            <label>分步覆盖 stepVars</label>
            <Input.TextArea
              aria-label="分步变量"
              value={stepText}
              onChange={(e) => setStepText(e.target.value)}
              rows={7}
              className="code-input"
            />
          </div>
        </div>
        <ErrorView error={error} />
        <Button
          icon={<FileSearchOutlined />}
          type="primary"
          loading={busy}
          onClick={() => void check()}
        >
          预检变量与排期
        </Button>
      </div>
      <div className="panel-heading">
        <h2>序列运行记录</h2>
        <span className="muted">每个群最多一个运行中的序列</span>
      </div>
      <Table
        rowKey="id"
        dataSource={rq.data || []}
        pagination={{ pageSize: 5 }}
        columns={[
          {
            title: "运行",
            dataIndex: "id",
            render: (id) => <code>{id.slice(0, 8)}</code>,
          },
          {
            title: "状态",
            dataIndex: "status",
            render: (v) => <Status value={v} />,
          },
          {
            title: "进度",
            render: (_, r) => (
              <Progress
                size="small"
                percent={Math.round(
                  (r.steps.filter((s) => ["sent", "skipped"].includes(s.status))
                    .length /
                    r.steps.length) *
                    100,
                )}
              />
            ),
          },
          { title: "当前步骤", dataIndex: "currentStepIndex" },
        ]}
        expandable={{
          expandedRowRender: (r) => (
            <Table
              rowKey="index"
              size="small"
              pagination={false}
              dataSource={r.steps}
              columns={[
                { title: "步骤", dataIndex: "index" },
                {
                  title: "状态",
                  dataIndex: "status",
                  render: (s) => <Status value={s} />,
                },
                { title: "排期", dataIndex: "scheduledAt", render: time },
                { title: "发出 / 跳过", dataIndex: "sentAt", render: time },
                {
                  title: "变量与来源",
                  render: (_, s) => (
                    <div>
                      {Object.entries(s.resolvedVars).map(([key, value]) => (
                        <div key={key}>
                          <code>{key}</code> = {value}{" "}
                          <Tag>{s.varSources[key]}</Tag>
                        </div>
                      ))}
                    </div>
                  ),
                },
              ]}
            />
          ),
        }}
      />
      <Modal
        title="启动前预检"
        open={!!preview}
        onCancel={() => setPreview(null)}
        width={780}
        okText="确认启动"
        cancelText="返回修改"
        confirmLoading={busy}
        onOk={() => void start()}
        okButtonProps={{ disabled: user?.role !== "admin" }}
      >
        <p className="muted">
          预检通过，以下是每一步实际发送的内容与变量来源。
        </p>
        <Table
          rowKey="index"
          pagination={false}
          dataSource={preview || []}
          columns={[
            { title: "步骤", dataIndex: "index", width: 60 },
            {
              title: "发送角色",
              dataIndex: "accountRole",
              render: (v) => <Status value={v} />,
            },
            { title: "消息内容", dataIndex: "text" },
            {
              title: "变量来源",
              render: (_, s) => (
                <div>
                  {Object.entries(s.resolvedVars).map(([k, v]) => (
                    <div key={k}>
                      <code>{k}</code>: {v}
                      <br />
                      <Tag>{s.varSources[k]}</Tag>
                    </div>
                  ))}
                </div>
              ),
            },
          ]}
        />
      </Modal>
    </>
  );
}
