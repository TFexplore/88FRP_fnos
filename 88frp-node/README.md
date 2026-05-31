# 88frp-node

独立的 `88FRP` Node 版本，包含：

- 交互式 CLI
- 常驻后台 agent
- Docker Web 后端骨架

## 快速开始

```bash
npm install
npm run agent
node ./src/cli/index.js agent-status
node ./src/cli/index.js list
```

## 当前状态

- 已建立独立项目骨架
- 已完成 `core + agent + cli + web` 初始结构
- 已跑通 CLI 与 agent 的最小通信链路
- `frpc` 实际二进制接入和完整 Web UI 仍在后续开发中
