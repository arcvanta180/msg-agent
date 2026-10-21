import { label } from "@/shared/lib/format";
import { Tag } from "antd";
export function Status({ value }: { value: string | null | undefined }) {
  const color = ["online", "active", "finished", "sent", "pass"].includes(
    value || "",
  )
    ? "success"
    : ["failed", "suspended", "session_expired", "blocked", "fail"].includes(
          value || "",
        )
      ? "error"
      : ["running", "accepted"].includes(value || "")
        ? "processing"
        : ["rate_limited", "unknown"].includes(value || "")
          ? "warning"
          : "default";
  return <Tag color={color}>{label(value)}</Tag>;
}
