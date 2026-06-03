# Clawd Companion

Claude Code 桌宠伴侣 — 透明桌宠窗口实时显示 Claude Code 的工具调用、会话状态和完成提醒。

基于 Claude Code 吉祥物 Clawd 的像素图标，支持思维气泡和通知卡片两种反馈样式。

<div align="center">
  <img src="README-ICON/thinking.png" width="360" alt="Clawd 正在思考" />
  &nbsp;
  <img src="README-ICON/thinking-card.png" width="260" alt="会话开始通知卡片" />
</div>

## 功能

<div align="center">
  <img src="README-ICON/edit-tool.png" width="360" alt="Clawd 工作中 — Edit 工具" />
</div>

- 透明桌宠窗口，始终置顶，支持拖动和边界限制
- 本地 HTTP 事件服务接收 Claude Code hooks 事件
- hook forwarder 自动转发 SessionStart / UserPromptSubmit / PreToolUse / PostToolUse / Notification / Stop
- 配置面板：连接状态、桌宠外观、隐私模式、事件映射、反馈样式自定义
- 思维气泡（工具调用时从 Clawd 脑边浮现）和通知卡片（等待确认、完成、错误）
- 每种状态可独立选择气泡或卡片样式
- 分别调整 Clawd 和气泡/卡片的大小与透明度
- 单实例锁、静默启动脚本、托盘菜单、开机自启

### 完成与错误提醒

<div align="center">
  <img src="README-ICON/done.png" width="240" alt="Clawd 完成 — 处理完成" />
  &nbsp;
  <img src="README-ICON/error.png" width="240" alt="Clawd 出错 — 执行失败" />
</div>

## 快速开始

```bash
# 安装依赖
npm install

# 开发模式
npm run dev:electron

# 构建并启动
npm run build
npm run start
```

Windows 用户可双击：
- `静默启动Clawd.vbs` — 无命令行窗口启动
- `启动Clawd.bat` — 带命令行窗口启动（调试用）

## 连接 Claude Code

1. 启动 Clawd Companion
2. 打开配置面板，复制 hooks 配置片段
3. 将 hooks 合并到 `~/.claude/settings.json`
4. 重新打开一个 Claude Code 会话

配置面板会显示连接状态、最近事件和会话信息。

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `CLAWD_COMPANION_PORT` | `47634` | 事件服务端口 |
| `CLAWD_COMPANION_TOKEN` | `clawd-local` | 认证 token |
| `CLAWD_PRIVACY_MODE` | `safe` | safe / standard / detailed |
| `CLAWD_CLIENT_TYPE` | `unknown` | 客户端标识 |
| `CLAWD_CLIENT_LABEL` | `Claude Code` | 客户端显示名 |

## 技术栈

- Electron + React + TypeScript + Vite
- 本地 HTTP + WebSocket 事件服务
- Claude Code hooks 转发器（Node.js CLI）
