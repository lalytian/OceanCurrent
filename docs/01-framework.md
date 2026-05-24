# 洋流 (Ocean Stream) - 核心技术框架

本文档梳理了 Ocean Stream 客户端当前采用的核心技术栈与系统架构。

## 1. 整体架构 (Tauri 跨平台方案)
我们采用 **Tauri** 作为桌面端底层框架，它拥有极低的资源占用和原生的系统级体验。
* **前端 (UI层):** React 19 + TypeScript + Vite
* **后端 (系统层):** Rust (负责系统级 API 调用、托盘、本地文件操作等)
* **打包分发:** 自动编译为 Windows (.exe/.msi)、macOS (.dmg)、Linux (.deb/.AppImage)

## 2. 核心功能模块
### 2.1 可视化拓扑引擎 (ReactFlow)
前端界面的核心是一个支持无限缩放、拖拽的节点网络画布。
* **底层库:** `@xyflow/react` (React Flow)
* **当前节点定义:**
  * `Desktop` (本地设备)
  * `Ruflo Queen` (女王协调节点)
  * `Ocean MCP` (模型上下文协议服务)
* **表现形式:** 支持深色模式 (Dark Mode)、动态连线 (Animated Edges)、全局小地图 (MiniMap)。

## 3. CI/CD 自动化流水线
代码仓库已集成 GitHub Actions 自动化打包系统：
* **触发条件:** 代码推送到 `main` 分支。
* **编译矩阵:** `ubuntu-latest`, `macos-latest`, `windows-latest` 并行编译。
* **发布机制:** 编译成功后自动在 GitHub Releases 创建草稿发布，提供全平台安装包。

## 4. 下一步架构演进方向
* 引入 SQLite 或本地 JSON 存储以保存用户拓扑图状态。
* 桥接 Rust 后端与 Node.js 进程，实现真正的 MCP (Model Context Protocol) 本地通信。