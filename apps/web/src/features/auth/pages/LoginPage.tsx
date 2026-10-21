import { useAuth } from "@/features/auth/AuthProvider";
import {
  ApiOutlined,
  ArrowRightOutlined,
  CheckCircleOutlined,
  MessageOutlined,
  RobotOutlined,
  SafetyCertificateOutlined,
  TeamOutlined,
} from "@ant-design/icons";
import { Alert, Button, Form, Input, Tag } from "antd";
import { useState } from "react";

export default function LoginPage() {
  const { login } = useAuth();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <div className="login-page">
      <div className="login-story">
        <div className="brand">
          <span className="brand-icon">
            <MessageOutlined />
          </span>
          relay<span className="brand-dot">.</span>
        </div>
        <div>
          <div className="eyebrow">MESSAGES, IN SYNC.</div>
          <h1>
            每条消息，
            <br />
            都有可靠的回响。
          </h1>
          <p>
            多账号协作、可追踪的自动应答与定时编排。
            <br />
            让群组运营，回到一个清晰的工作空间。
          </p>
          <div className="login-features">
            <span>
              <CheckCircleOutlined /> 多账号协作，统一消息时间线
            </span>
            <span>
              <CheckCircleOutlined /> Agent 自动应答，全程可审计
            </span>
            <span>
              <CheckCircleOutlined /> 定时编排，让每一步准时发生
            </span>
          </div>
          <div className="login-preview">
            <div>
              <span className="preview-icon">
                <TeamOutlined />
              </span>
              <strong>一个工作空间，连接每段对话</strong>
            </div>
            <div className="login-diagram">
              <span>
                <ApiOutlined /> 服务账号
              </span>
              <i />
              <span className="active">
                <MessageOutlined /> 消息中枢
              </span>
              <i />
              <span>
                <RobotOutlined /> Agent
              </span>
            </div>
          </div>
        </div>
        <small>RELAY CONSOLE · LOCAL DEMO</small>
      </div>
      <div className="login-form-wrap">
        <div className="login-form">
          <Tag color="blue">RELAY CONSOLE</Tag>
          <h2>欢迎回来</h2>
          <p>登录控制台，继续你的群组协作。</p>
          <Form
            layout="vertical"
            initialValues={{ username: "admin", password: "admin" }}
            onFinish={async (values) => {
              setBusy(true);
              setError("");
              try {
                await login(values.username, values.password);
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <Form.Item
              name="username"
              label="用户名"
              rules={[{ required: true, message: "请输入用户名" }]}
            >
              <Input aria-label="用户名" size="large" autoComplete="username" />
            </Form.Item>
            <Form.Item
              name="password"
              label="密码"
              rules={[{ required: true, message: "请输入密码" }]}
            >
              <Input.Password
                aria-label="密码"
                size="large"
                autoComplete="current-password"
              />
            </Form.Item>
            {error && (
              <Alert type="error" message={error} showIcon className="mb" />
            )}
            <Button
              htmlType="submit"
              type="primary"
              size="large"
              block
              loading={busy}
            >
              进入工作空间 <ArrowRightOutlined />
            </Button>
          </Form>
          <div className="login-hint">
            <SafetyCertificateOutlined />
            <div>
              管理员 <code>admin / admin</code>
              <br />
              只读查看者 <code>viewer / viewer</code>
            </div>
          </div>
          <small>外部网关与 Agent 使用可配置的模拟服务。</small>
        </div>
      </div>
    </div>
  );
}
