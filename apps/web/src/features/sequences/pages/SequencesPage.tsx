import { useAuth } from "@/features/auth/AuthProvider";
import { api, post } from "@/shared/api/client";
import { Group, SequenceDefinition } from "@/shared/contracts";
import { ErrorView, PageTitle } from "@/shared/ui";
import { PlusOutlined } from "@ant-design/icons";
import { useQuery } from "@tanstack/react-query";
import { App, Button, Input, Modal, Select } from "antd";
import { useState } from "react";
import { SequencePanel } from "../components/SequencePanel";
export default function SequencesPage() {
  const { user } = useAuth();
  const { message } = App.useApp();
  const gq = useQuery({
    queryKey: ["groups"],
    queryFn: () => api<Group[]>("/groups"),
  });
  const sq = useQuery({
    queryKey: ["sequences"],
    queryFn: () => api<SequenceDefinition[]>("/sequences"),
  });
  const [groupId, setGroupId] = useState<string | undefined>(),
    [open, setOpen] = useState(false),
    [raw, setRaw] = useState(
      '{"name":"新序列","steps":[{"index":1,"accountRole":"admin","text":"欢迎参加 {event}","delaySeconds":5}]}',
    );
  const [error, setError] = useState<unknown>(null);
  const selected = groupId || gq.data?.find((g) => g.status === "active")?.id;
  return (
    <>
      <PageTitle
        title="定时序列"
        description="用角色、模板与相对延迟，编排有节奏的群内协作。"
        action={
          user?.role === "admin" && (
            <Button icon={<PlusOutlined />} onClick={() => setOpen(true)}>
              添加序列模板
            </Button>
          )
        }
      />
      <section className="panel sequence-page">
        <div className="panel-heading">
          <h2>选择执行群组</h2>
          <Select
            aria-label="执行群组"
            style={{ width: 300 }}
            value={selected}
            placeholder="请选择群组"
            onChange={setGroupId}
            options={gq.data
              ?.filter((g) => g.status === "active")
              .map((g) => ({ value: g.id, label: g.name }))}
          />
        </div>
        {selected ? (
          <SequencePanel key={selected} groupId={selected} />
        ) : (
          <p className="empty-description">
            先创建一个群组，即可预检和运行定时序列。
          </p>
        )}
      </section>
      <Modal
        title="添加序列模板"
        open={open}
        onCancel={() => setOpen(false)}
        okText="保存模板"
        cancelText="取消"
        onOk={async () => {
          try {
            const body = JSON.parse(raw);
            await post("/sequences", body);
            await sq.refetch();
            setOpen(false);
            setError(null);
            message.success("序列模板已添加");
          } catch (e) {
            setError(e);
          }
        }}
      >
        <p className="muted">
          步骤 index 从 1 连续递增；角色可选 admin / member，延迟单位为秒。
        </p>
        <Input.TextArea
          aria-label="序列模板定义"
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          rows={12}
          className="code-input"
        />
        <ErrorView error={error} />
      </Modal>
    </>
  );
}
