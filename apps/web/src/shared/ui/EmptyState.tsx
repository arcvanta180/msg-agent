import { Empty } from "antd";
export function EmptyState({ text = "暂无记录" }: { text?: string }) {
  return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={text} />;
}
