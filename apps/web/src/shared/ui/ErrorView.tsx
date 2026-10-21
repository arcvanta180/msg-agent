import { ApiError } from "@/shared/api/client";
import { Alert } from "antd";
export function ErrorView({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <Alert
      showIcon
      type="error"
      message={error instanceof Error ? error.message : String(error)}
      description={
        error instanceof ApiError
          ? `${error.code}${error.fields.stepIndex ? ` · 第 ${error.fields.stepIndex} 步 · 变量 ${error.fields.key}` : ""}`
          : undefined
      }
    />
  );
}
