# Clawd Companion 项目指南

## 发布流程

当用户说"提交release"或类似表述时，自动执行以下流程：

1. **版本号递增**：运行 `npm run version:patch`（或 `version:minor` / `version:major`）同步更新 `package.json` 和 `package-lock.json`
   - 如果用户主动指定了版本号（如"发布1.4.0"），可使用 `npm run version:patch -- 1.4.0` 或手动执行 `node scripts/bump-version.mjs 1.4.0`
   - 永远不要覆盖已有的 GitHub Release
2. **本地构建**（可选，CI 会自动构建）：运行 `npm run dist` 生成安装包
3. **文件重命名**：将生成的 exe 和 blockmap 文件名从空格格式改为连字符格式（如 `Clawd Companion Setup 1.3.3.exe` → `Clawd-Companion-Setup-1.3.3.exe`），以匹配 `latest.yml` 中的文件名
4. **提交推送**：git add → commit → tag → push（tag 格式 `v{版本号}`）
5. **创建 Release**：推送 tag 后，CI 工作流 `.github/workflows/release.yml` 会自动构建并发布到 GitHub Release。如需手动发布，使用 `gh release create`

## 版本号规则

- 当前版本存储在 `package.json` 的 `version` 字段
- 每次发布自动 patch 递增，除非用户明确指定
- `latest.yml` 中的文件名必须与上传到 Release 的文件名完全一致
- `scripts/bump-version.mjs` 负责同步 `package.json` 和 `package-lock.json` 两个文件的版本

## Release 文件命名规范

- **上传到 GitHub Release 的文件**必须使用连字符格式：`Clawd-Companion-Setup-{版本号}.exe`
- **electron-builder 生成的文件**使用空格格式：`Clawd Companion Setup {版本号}.exe`
- **必须在构建后重命名**：exe 和 blockmap 文件都需要从空格格式改为连字符格式
- **latest.yml** 中的文件名必须与重命名后的文件名完全一致
- CI 中的重命名步骤在 `.github/workflows/release.yml` 的 "Rename artifacts to match latest.yml" 中自动完成

## 构建命令

- `npm run build` — 编译 TypeScript + Vite 构建
- `npm run dist` — 构建 + electron-builder 打包
- `npm run dist:validate` — 校验 latest.yml 文件名一致性
- `npm run typecheck` — 仅做类型检查（不发包）
- `npm test` — 运行 hook-forwarder 单元测试（vitest）
- `npm run version:patch` / `version:minor` / `version:major` — 同步更新 package.json 和 package-lock.json 的版本号

## 持续集成 (CI/CD)

- **`.github/workflows/ci.yml`**：push / PR 触发，运行 typecheck + 测试（windows-latest）
- **`.github/workflows/release.yml`**：tag 触发（`v*.*.*`），自动构建、产物重命名、上传到 GitHub Release

## Codex 启动时自动启动本应用

**默认关闭**，需要用户在配置面板 → 应用行为 中开启「Codex 启动时自动启动本应用」开关。

开关实现细节：
1. 主程序把开关状态写入标记文件 `~/.clawd-companion/auto-start-with-cli.flag`
2. forwarder 在 `SessionStart` 时先 ping `127.0.0.1:47634/health`，如果主程序已在运行则直接复用
3. 如果主程序未运行，根据 forwarder 所在位置判断是 dev 还是 prod 布局：
   - Dev: `<project>/dist/hook-forwarder/index.js` → `npm start` in 项目根
   - Prod: `<install>/resources/hook-forwarder/index.js` → `<install>/Clawd Companion.exe`
4. 通过 `child_process.spawn` + `detached: true` + `unref()` 启动，不阻塞 forwarder 退出
5. **环境变量覆盖**（高级用户）：`CLAWD_COMPANION_AUTOSTART=1` 强制开启，`=0` 强制关闭
