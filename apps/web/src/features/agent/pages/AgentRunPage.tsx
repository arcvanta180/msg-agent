import { api } from "@/shared/api/client";
import { AgentRun } from "@/shared/contracts";
import { label, time } from "@/shared/lib/format";
import { ErrorView, Loading, PageTitle, Status } from "@/shared/ui";
import { useQuery } from "@tanstack/react-query";
import { Alert, Collapse, Descriptions, Tag } from "antd";
import { Link, useParams } from "react-router-dom";
export default function AgentRunPage() {
  const { id } = useParams();
  const q = useQuery({
    queryKey: ["agent-run", id],
    queryFn: () => api<AgentRun>(`/agent-runs/${id}`),
    refetchInterval: (data) =>
      data.state.data?.status === "running" ? 1500 : false,
  });
  if (q.isLoading) return <Loading />;
  const run = q.data;
  if (!run) return <ErrorView error={q.error} />;
  return (
    <>
      <Link className="back-link" to={`/groups/${run.groupId}`}>
        ← 返回群组
      </Link>
      <PageTitle
        title="Agent 运行详情"
        description={run.id}
        action={<Status value={run.status} />}
      />
      {run.status === "blocked" && (
        <Alert
          className="mb"
          type="error"
          showIcon
          message="审计服务连续三次未返回明确结论"
          description="本次工具没有执行。请检查审计服务后，再决定下一次触发。"
        />
      )}
      <section className="panel run-overview">
        <Descriptions
          column={4}
          items={[
            { key: "end", label: "结束原因", children: label(run.endReason) },
            {
              key: "steps",
              label: "执行步骤",
              children: `${run.steps.length} / 12`,
            },
            {
              key: "time",
              label: "有效运行时间",
              children: `${(run.elapsedMs / 1000).toFixed(1)} 秒`,
            },
            { key: "start", label: "触发时间", children: time(run.createdAt) },
          ]}
        />
        {run.summary && (
          <div className="summary">
            <strong>运行总结</strong>
            <p>{run.summary}</p>
          </div>
        )}
      </section>
      <div className="trace-heading">
        <h2>执行轨迹</h2>
        <span className="muted">每一步保留原始响应、工具参数与审计结论</span>
      </div>
      <div className="trace-list">
        {run.steps.map((step) => (
          <section
            className={`panel trace-step ${step.isError ? "has-error" : ""}`}
            key={step.index}
          >
            <div className="trace-number">
              {String(step.index).padStart(2, "0")}
            </div>
            <div className="trace-body">
              <div className="trace-title">
                <h3>
                  {step.name ||
                    { final: "最终响应", protocol_error: "协议错误" }[
                      step.kind as "final" | "protocol_error"
                    ] ||
                    "请求处理中"}
                </h3>
                <Tag>{step.kind}</Tag>
                {step.isError ? (
                  <Tag color="error">{step.errorCode}</Tag>
                ) : (
                  <Status
                    value={step.phase === "done" ? "finished" : "running"}
                  />
                )}
                <span className="muted">{step.toolUseId}</span>
              </div>
              <p className="trace-result">
                {step.resultSummary || "等待本步结果…"}
              </p>
              <div className="audit-line">
                审计：
                {step.auditVerdict ? (
                  <Status value={step.auditVerdict} />
                ) : (
                  <span className="muted">无需审计 / 尚未执行</span>
                )}
                <span>尝试 {step.auditAttempts} 次</span>
                {step.phase === "uncertain" && (
                  <Tag color="warning">外部结果待核实</Tag>
                )}
              </div>
              <Collapse
                ghost
                items={[
                  ...(step.input
                    ? [
                        {
                          key: "input",
                          label: "工具入参",
                          children: (
                            <pre>{JSON.stringify(step.input, null, 2)}</pre>
                          ),
                        },
                      ]
                    : []),
                  ...(step.result
                    ? [
                        {
                          key: "result",
                          label: "完整工具结果",
                          children: (
                            <pre>{JSON.stringify(step.result, null, 2)}</pre>
                          ),
                        },
                      ]
                    : []),
                  {
                    key: "raw",
                    label: "原始响应",
                    children: <pre>{step.rawResponse || "等待响应"}</pre>,
                  },
                ]}
              />
            </div>
          </section>
        ))}
      </div>
    </>
  );
}
