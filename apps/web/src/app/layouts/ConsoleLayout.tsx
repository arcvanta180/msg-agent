import { useAuth } from "@/features/auth/AuthProvider";
import { useStream } from "@/features/realtime/StreamProvider";
import { api } from "@/shared/api/client";
import {
  ApartmentOutlined,
  ApiOutlined,
  LogoutOutlined,
  MessageOutlined,
  ReadOutlined,
  ScheduleOutlined,
  TeamOutlined,
} from "@ant-design/icons";
import { useQuery } from "@tanstack/react-query";
import { Alert, Button, Tag, Tooltip } from "antd";
import { NavLink, Outlet, useLocation } from "react-router-dom";

export function ConsoleLayout() {
  const { user, logout } = useAuth();
  const stream = useStream();
  const location = useLocation();
  const currentSection = location.pathname.startsWith("/accounts")
    ? "服务账号"
    : location.pathname.startsWith("/sequences")
      ? "定时序列"
      : location.pathname.startsWith("/agent-runs")
        ? "Agent 运行详情"
        : "群组空间";
  const notices = useQuery({
    queryKey: ["inconsistencies"],
    queryFn: () =>
      api<
        {
          seq: string;
          payload: { kind: string; ref: string; message: string };
        }[]
      >("/inconsistencies"),
    refetchInterval: 10000,
  });
  return (
    <div className="app-shell">
      <aside className="navigation">
        <NavLink to="/accounts" className="brand">
          <span className="brand-icon">
            <MessageOutlined />
          </span>
          relay<span className="brand-dot">.</span>
        </NavLink>
        <div className="workspace-label">
          <ApartmentOutlined /> 运营工作空间 <span>默认</span>
        </div>
        <nav>
          <NavLink to="/accounts" aria-label="服务账号">
            <ApiOutlined />
            <span className="nav-label">服务账号</span>
          </NavLink>
          <NavLink
            to="/groups"
            aria-label="群组空间"
            className={({ isActive }) =>
              isActive || location.pathname.startsWith("/agent-runs")
                ? "active"
                : undefined
            }
          >
            <TeamOutlined />
            <span className="nav-label">群组空间</span>
          </NavLink>
          <NavLink to="/sequences" aria-label="定时序列">
            <ScheduleOutlined />
            <span className="nav-label">定时序列</span>
          </NavLink>
        </nav>
        <div className="nav-bottom">
          <div className="demo-note">
            <span className="demo-dot" />
            演示工作空间
            <p>
              连接账号，创建群组，
              <br />
              开启自动化协作。
            </p>
          </div>
          <div className="user-block">
            <span className="user-avatar">
              {user?.role === "admin" ? "管" : "阅"}
            </span>
            <div>
              <strong>{user?.userId}</strong>
              <small>{user?.role === "admin" ? "管理员" : "只读查看者"}</small>
            </div>
            <Tooltip title="退出登录">
              <Button
                type="text"
                icon={<LogoutOutlined />}
                aria-label="退出登录"
                onClick={() => void logout()}
              />
            </Tooltip>
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <span>
            工作空间 <span className="breadcrumb-separator">/</span>{" "}
            <strong className="breadcrumb-current">{currentSection}</strong>
          </span>
          <div>
            <span
              className={`connection-dot ${stream.online ? "connected" : ""}`}
            />
            {stream.online ? "实时连接正常" : "正在恢复实时连接"}
            <span className="topbar-divider" />
            {user?.role === "viewer" && (
              <Tag icon={<ReadOutlined />}>只读模式</Tag>
            )}
            <Tag className="environment-tag">DEMO</Tag>
          </div>
        </header>
        <main>
          {notices.data?.slice(0, 3).map((n) => (
            <Alert
              key={n.seq}
              className="mb"
              type="warning"
              showIcon
              closable
              message="运行一致性通知"
              description={`${n.payload.message} · ${n.payload.ref.slice(0, 8)}`}
            />
          ))}
          {!stream.online && (
            <Alert
              className="mb"
              showIcon
              type="warning"
              message="实时连接正在恢复，重连后将自动补齐断线期间的事件。"
            />
          )}
          <Outlet />
        </main>
        <footer>
          Relay 消息协作平台<span>让协作的每一步都有迹可循</span>
        </footer>
      </div>
    </div>
  );
}
