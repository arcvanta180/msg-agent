const labels: Record<string, string> = {
  idle: "待连接",
  online: "在线",
  rate_limited: "限流等待",
  disconnected: "已离线",
  suspended: "已停用",
  session_expired: "会话失效",
  active: "管理中",
  unreachable: "不可达",
  left: "已退出",
  running: "运行中",
  finished: "已完成",
  failed: "失败",
  blocked: "审计阻塞",
  cancelled: "已取消",
  stopped: "已停止",
  queued: "排队中",
  accepted: "已受理",
  sent: "已发出",
  unknown: "待核实",
  pending: "待执行",
  skipped: "已跳过",
  creator: "群主",
  admin: "管理员",
  member: "成员",
  final: "正常结束",
  budget_exhausted: "步数用尽",
  wall_clock: "运行超时",
  protocol_errors: "连续协议错误",
  audit_blocked: "审计无结论",
};
export const label = (s: string | null | undefined) =>
  s ? labels[s] || s : "—";
export const time = (value: string | null | undefined) =>
  value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "—";
export const short = (value: string) => value.slice(0, 8);
