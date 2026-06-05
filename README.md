# Clawd Companion

Claude Code 桌宠伴侣 — 透明桌宠窗口实时显示 Claude Code 的工具调用、会话状态和完成提醒。

基于 Claude Code 吉祥物 Clawd 的像素精灵动画，支持思维气泡、通知卡片和工具条三种反馈样式。

<div align="center">
  <img src="README-ICON/thinking.png" width="340" alt="Clawd 正在思考" />
  &nbsp;
  <img src="README-ICON/thinking-card.png" width="240" alt="会话开始通知卡片" />
</div>

## 功能

<div align="center">
  <img src="README-ICON/edit-tool.png" width="340" alt="Clawd 工作中 — Edit 工具" />
</div>

### 核心体验

- 透明桌宠窗口，始终置顶，支持拖动和边界限制
- 本地 HTTP + WebSocket 事件服务接收 Claude Code hooks 事件
- Hook forwarder 自动转发 SessionStart / UserPromptSubmit / PreToolUse / PostToolUse / Notification / Stop
- **自动更新**：基于 GitHub Releases，启动时静默检查，一键安装新版本
- **动作动画映射**：支持为每个工具/事件自定义 Clawd 精灵动画
- **运行统计**：持久化存储工具调用排行、会话数、权限统计、活跃时段等深度数据
- **设置导入/导出**：一键导出或导入 JSON 配置文件

### 完成与错误提醒

<div align="center">
  <img src="README-ICON/done.png" width="220" alt="Clawd 完成" />
  &nbsp;
  <img src="README-ICON/error.png" width="220" alt="Clawd 出错" />
</div>

### Git 状态感知

实时监听项目 `.git` 变更，commit / checkout / merge 等操作以胶囊浮窗形式即时提示，不打断工作流。

### Token 用量看板

扫描 `~/.claude/projects` 下的会话数据，提供：

- 今日 / 30 天 / 累计 Token 汇总
- 近 12 个月按月日历热力图
- 按模型拆分的 Token 排行（默认显示 Top 5，可展开查看全部）

### 音效系统

可配置的事件触发音效，支持内置音效和自定义 WAV/MP3/OGG/FLAC 文件：

- 完成、错误、权限请求、会话开始四种触发事件
- 每个事件可独立开关并替换为自定义音频文件
- 基于 HTML5 Audio API，无需外部依赖

### Claude Code 启动时自动启动

默认**关闭**。在配置面板 → 应用行为 中开启「Claude Code 启动时自动启动」开关后，每次 `SessionStart`（即 Claude Code CLI 新会话开始）都会自动唤起 Clawd Companion：

- 如果主程序已在运行，则复用现有实例
- 如果主程序未运行，则根据环境自动启动（开发模式启动 `npm start`，生产模式启动安装目录下的 exe）

环境变量覆盖（高级用户）：`CLAWD_COMPANION_AUTOSTART=1` 强制开启，`=0` 强制关闭。

## 安装

从 [Releases](https://github.com/Doulor/Clawd-Companion/releases) 下载最新版安装包，双击运行即可。

安装完成后启动 Clawd Companion，打开配置面板，点击「一键安装」配置 Claude Code hooks，然后重新打开 Claude Code 会话即可自动连接。

## 开发

```bash
# 安装依赖
npm install

# 开发模式（Electron + Vite 热更新）
npm run dev:electron

# 构建
npm run build

# 打包为安装程序
npm run dist

# 校验 latest.yml 文件名一致性
npm run dist:validate

# 类型检查
npm run typecheck

# 单元测试
npm test

# 版本号管理
npm run version:patch   # 递增 patch（1.4.2 → 1.4.3）
npm run version:minor   # 递增 minor（1.4.2 → 1.5.0）
npm run version:major   # 递增 major（1.4.2 → 2.0.0）
```

## 持续集成

- **CI**（`.github/workflows/ci.yml`）：push / PR 自动运行 typecheck + 单元测试
- **Release**（`.github/workflows/release.yml`）：推送 `v*.*.*` tag 自动构建、重命名产物、发布到 GitHub Releases

## 技术栈

- Electron + React + TypeScript + Vite
- electron-updater 自动更新（GitHub Releases）
- 本地 HTTP + WebSocket 事件服务
- Claude Code hooks 转发器（Node.js CLI，44 项单元测试）
- electron-builder NSIS 安装包

## License

MIT
