import type { ThemeConfig } from "antd";
export const theme: ThemeConfig = {
  token: {
    colorPrimary: "#1677ff",
    borderRadius: 6,
    colorText: "#1f2937",
    colorTextSecondary: "#64748b",
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif',
  },
  components: {
    Button: { controlHeight: 36 },
    Table: { headerBg: "#f7f9fc", headerColor: "#475569" },
    Modal: { titleFontSize: 20 },
  },
};
