# 88FRP CLI 与 Docker 版本设计文档

## 1. 文档目标

本文档用于梳理当前 `88FRP` 管理器的业务逻辑，并基于现有实现设计：

- 命令行版本 `CLI`
- Docker 运行版本
- 可复用的公共业务层拆分方案

目标不是重写现有功能，而是在保留现有实例管理能力的前提下，让 Web UI、CLI、Docker 三种形态共用一套核心业务逻辑。

## 2. 当前业务定位

当前项目本质上是一个 `88frpc` 多实例管理器，负责管理多份 `frpc.toml` 配置及其对应进程，而不是实现 FRP 协议本身。

当前后端的核心能力包括：

- 创建、更新、删除实例
- 保存本地配置文件
- 启动、暂停、重启实例进程
- 记录运行状态与日志
- 通过密匙从远程接口同步配置
- 启动服务时自动恢复实例
- 开启自动同步后定时检测远程配置变更

## 3. 当前业务模型

### 3.1 实例定义

一个实例由三部分组成：

- 实例元数据
- 本地配置文件 `frpc.toml`
- 对应的 `88frpc` 运行进程

### 3.2 存储结构

当前存储结构可抽象为：

```text
data/
  instances.json
  settings.json
  app.log
  instances/
    <instance-id>/
      frpc.toml
      runtime.json
      runtime.log
```

### 3.3 实例核心字段

实例元数据当前重点字段如下：

| 字段 | 说明 |
| --- | --- |
| `id` | 实例唯一 ID |
| `name` | 实例名称 |
| `secretKey` | 远程配置拉取密匙 |
| `remoteUrl` | 远程配置地址 |
| `autoSyncEnabled` | 是否开启自动同步 |
| `createdAt` | 创建时间 |
| `updatedAt` | 更新时间 |

运行时状态重点字段如下：

| 字段 | 说明 |
| --- | --- |
| `status` | `stopped` / `starting` / `running` / `stopping` / `error` |
| `pid` | 进程 ID |
| `lastStartedAt` | 上次启动时间 |
| `lastExitCode` | 上次退出码 |
| `lastError` | 最近一次错误信息 |
| `updatedAt` | 状态更新时间 |

## 4. 当前核心业务流程

### 4.1 创建实例

流程如下：

1. 接收实例名称、密匙、自动同步等参数
2. 生成实例 ID
3. 写入 `instances.json`
4. 初始化实例目录
5. 创建默认运行时信息和日志文件

### 4.2 保存配置

流程如下：

1. 前端或调用方提交配置文本
2. 服务端进行基础校验
3. 校验通过后写入实例目录下的 `frpc.toml`
4. 更新运行时更新时间

### 4.3 启动实例

流程如下：

1. 检查配置文件内容是否为空
2. 检查 `88frpc` 二进制是否存在且可执行
3. 如果实例当前已有旧进程，先停止旧进程
4. 使用 `88frpc -c <configPath>` 启动子进程
5. 将标准输出和错误输出写入 `runtime.log`
6. 更新运行时状态为 `running`

### 4.4 暂停实例

流程如下：

1. 读取当前实例运行时状态
2. 向子进程发送终止信号
3. 等待进程退出
4. 若超时则强制结束
5. 更新运行状态为 `stopped` 或 `error`

### 4.5 重启实例

流程如下：

1. 先停止实例
2. 再重新启动实例

### 4.6 删除实例

流程如下：

1. 读取实例信息
2. 检查是否存在正在运行的进程
3. 若在运行，则先暂停实例
4. 删除实例元数据
5. 删除实例目录及其配置、日志、运行时信息

### 4.7 手动同步远程配置

流程如下：

1. 根据实例的 `secretKey` 和 `remoteUrl` 请求远程配置
2. 获取配置文本后做基础校验
3. 成功后覆盖本地 `frpc.toml`
4. 当前手动同步默认只保存配置，不强制重启

### 4.8 自动同步远程配置

流程如下：

1. 定时扫描所有开启 `autoSyncEnabled` 的实例
2. 请求远程配置
3. 与本地配置做标准化对比
4. 若无差异则跳过
5. 若有差异则写回本地配置
6. 若实例正在运行，则重启实例
7. 若实例未运行，则直接启动实例，让新配置生效

### 4.9 服务启动自动恢复

当前规则如下：

1. 服务启动时初始化存储
2. 清理残留幽灵进程
3. 恢复运行状态
4. 自动扫描全部实例
5. 对有本地配置的实例尝试自动启动

注意：当前自动恢复是“有配置即恢复”，不是实例级单独 `autoStart` 开关。

## 5. 状态机设计

推荐将实例运行态统一理解为以下状态机：

```text
stopped -> starting -> running -> stopping -> stopped
                     \-> error
starting -> error
stopping -> error
error -> starting
```

对应操作限制：

| 状态 | 允许操作 |
| --- | --- |
| `stopped` | 启动、删除、编辑配置、同步配置 |
| `running` | 重启、暂停、删除、同步配置 |
| `starting` | 等待，不建议再发启动命令 |
| `stopping` | 等待，不建议重复停止 |
| `error` | 启动、删除、查看日志 |

这套状态机后续需要在：

- Web UI
- CLI 输出
- Docker 健康状态

三处保持一致。

## 6. CLI 版本设计

### 6.1 CLI 版本目标

CLI 版本适合以下场景：

- 无浏览器环境的服务器管理
- 自动化脚本调用
- 面板之外的运维管理
- Docker 容器内调试和排障

### 6.2 CLI 设计原则

- 直接复用当前后端的业务层，不重复实现业务
- 命令输出尽量可读，同时支持脚本化
- 支持 `json` 输出模式，方便自动化集成
- 保持与 Web 管理逻辑一致的状态约束

### 6.3 推荐命令结构

建议命令名称：

```bash
88frpctl <command> [options]
```

推荐一级命令如下：

```text
88frpctl health
88frpctl list
88frpctl create
88frpctl update
88frpctl delete
88frpctl start
88frpctl stop
88frpctl restart
88frpctl status
88frpctl config get
88frpctl config set
88frpctl sync
88frpctl logs
```

### 6.4 推荐命令说明

#### 1. `list`

列出所有实例：

```bash
88frpctl list
88frpctl list --json
```

输出字段建议包含：

- `id`
- `name`
- `status`
- `pid`
- `autoSyncEnabled`
- `updatedAt`

#### 2. `create`

创建实例：

```bash
88frpctl create --name "主力隧道" --secret "xxxxx" --auto-sync
```

支持参数：

- `--name`
- `--secret`
- `--remote-url`
- `--auto-sync`

#### 3. `update`

修改实例基础信息：

```bash
88frpctl update <id> --name "新名称" --secret "xxxxx" --auto-sync=true
```

#### 4. `config get`

查看实例配置：

```bash
88frpctl config get <id>
```

#### 5. `config set`

保存配置文本：

```bash
88frpctl config set <id> --file ./frpc.toml
88frpctl config set <id> --stdin
```

建议支持：

- 文件输入
- 标准输入

#### 6. `start`

启动实例：

```bash
88frpctl start <id>
```

#### 7. `stop`

暂停实例：

```bash
88frpctl stop <id>
```

#### 8. `restart`

重启实例：

```bash
88frpctl restart <id>
```

#### 9. `status`

查看实例运行态：

```bash
88frpctl status <id>
```

建议返回：

- 当前状态
- PID
- 启动时间
- 最近错误
- 最近日志摘要

#### 10. `sync`

手动同步远程配置：

```bash
88frpctl sync <id>
88frpctl sync <id> --restart-on-change
```

建议支持选项：

- `--restart-on-change`
- `--secret`
- `--remote-url`

#### 11. `logs`

查看实例日志：

```bash
88frpctl logs <id>
88frpctl logs <id> --tail 200
88frpctl logs <id> --follow
```

### 6.5 CLI 输出设计建议

建议同时支持两种输出模式：

- 默认文本模式：便于人工查看
- `--json` 模式：便于脚本和自动化系统解析

例如：

```bash
88frpctl status <id> --json
```

建议退出码规则：

| 退出码 | 含义 |
| --- | --- |
| `0` | 成功 |
| `1` | 一般错误 |
| `2` | 参数错误 |
| `3` | 实例不存在 |
| `4` | 状态不允许 |
| `5` | 远程同步失败 |

## 7. Docker 版本设计

### 7.1 Docker 版本目标

Docker 版本主要解决：

- 快速部署
- 数据卷持久化
- 镜像化分发
- 与 NAS、家庭服务器、面板环境解耦

### 7.2 两种 Docker 方案

#### 方案 A：单实例容器

特点：

- 容器内只跑一个 `88frpc`
- 配置通过文件挂载或环境变量传入
- 更轻量
- 更接近标准 `frpc` 容器

适用场景：

- 只管理 1 个代理实例
- 编排交给外部系统

缺点：

- 不能复用当前多实例管理价值
- 自动同步和实例管理需要额外实现

#### 方案 B：多实例管理容器

特点：

- 容器内运行当前 Node 管理服务
- 一个容器管理多个 `88frpc` 实例
- 保留当前 Web 管理能力
- 后续 CLI 也可放到同一镜像中

适用场景：

- 想完整复用当前项目
- 需要 Web UI、CLI、自动同步、多实例统一管理

结论：

当前项目更推荐优先做 **多实例管理容器**。

### 7.3 推荐容器结构

```text
/app
  /server
  /ui
  /bin/88frpc
  /data
```

其中：

- `/app/data` 作为持久化卷
- `/app/bin/88frpc` 放置对应平台二进制
- Node 服务作为容器主进程

### 7.4 推荐挂载与端口

建议：

- 数据卷挂载：`/app/data`
- Web 管理端口暴露：例如 `8801`

示例：

```bash
docker run -d \
  --name 88frp-manager \
  -p 8801:8801 \
  -v 88frp-data:/app/data \
  88frp/manager:latest
```

### 7.5 推荐环境变量

建议统一支持以下环境变量：

| 变量名 | 说明 |
| --- | --- |
| `PORT` | Web 服务监听端口 |
| `DATA_DIR` | 数据目录 |
| `FRPC_BINARY_PATH` | `88frpc` 可执行文件路径 |
| `INSTANCE_AUTO_START_ON_BOOT` | 是否启动时自动恢复实例 |
| `AUTO_SYNC_INTERVAL_MS` | 自动同步间隔 |
| `HOST` | 监听地址 |

### 7.6 Docker 健康检查建议

建议使用健康检查接口：

```text
/api/health
```

用于判断：

- Node 服务是否在线
- `88frpc` 二进制是否存在
- 数据目录是否正常

### 7.7 Docker 日志建议

建议区分两类日志：

- 容器标准输出：Node 服务主日志
- 数据卷内日志：实例运行日志 `runtime.log`

这样便于：

- `docker logs` 快速定位服务问题
- 挂卷保存实例详细日志

## 8. 公共业务层拆分建议

当前 Web 版中，业务编排逻辑较多集中在 `server/index.js`。为了支撑 CLI 和 Docker，建议拆成更清晰的服务层。

### 8.1 推荐拆分结构

```text
app/server/
  index.js
  lib/
    store.js
    process-manager.js
    config-service.js
    instance-service.js
    runtime-service.js
    sync-service.js
```

### 8.2 服务职责建议

#### `store.js`

职责：

- 文件读写
- 实例元数据持久化
- 配置文件读写
- 运行时状态读写
- 日志读写

#### `process-manager.js`

职责：

- 直接与子进程打交道
- 启动、暂停、重启进程
- 进程存活检测
- 幽灵进程清理

#### `instance-service.js`

职责：

- 创建实例
- 更新实例
- 删除实例
- 查询实例

#### `runtime-service.js`

职责：

- 启动实例
- 暂停实例
- 重启实例
- 批量停止
- 状态恢复

#### `sync-service.js`

职责：

- 拉取远程配置
- 比较配置差异
- 应用配置
- 自动同步调度

### 8.3 为什么要拆

拆分后好处：

- Web API 只负责请求转发
- CLI 直接调用 service 层
- Docker 版只需换启动方式，不改业务
- 单元测试更容易做
- 业务逻辑不再散落在 HTTP 路由中

## 9. 推荐迭代顺序

### 第一阶段：业务内核整理

目标：

- 抽出 `instance-service`
- 抽出 `runtime-service`
- 抽出 `sync-service`
- 保持现有 Web 版功能不变

### 第二阶段：CLI 版本

目标：

- 完成 `88frpctl`
- 复用同一套数据目录
- 支持基础管理命令

建议先做：

1. `list`
2. `status`
3. `start`
4. `stop`
5. `restart`
6. `config get`
7. `config set`
8. `sync`

### 第三阶段：Docker 版本

目标：

- 基于当前 Node 管理服务构建镜像
- 支持数据卷持久化
- 支持自动恢复与自动同步
- 支持 Web UI 与 CLI 共存

### 第四阶段：补充高级能力

建议后续考虑：

- 实例级 `autoStartEnabled`
- CLI 批量操作
- 配置导入导出
- 多平台镜像
- 认证与权限控制
- 日志滚动清理

## 10. CLI 与 Docker 的关系建议

推荐把 CLI 和 Docker 统一规划为同一套产品的一部分：

- Web 版：给普通用户和面板用户使用
- CLI 版：给运维、脚本和自动化使用
- Docker 版：给独立部署环境使用

推荐最终形态：

- 一套核心业务层
- 两个入口：
  - `server/index.js`，提供 Web API
  - `cli/index.js`，提供命令行入口
- 一个 Docker 镜像，同时包含：
  - Web 服务
  - CLI 工具
  - `88frpc` 二进制

## 11. 推荐最终目录结构

```text
88frp/
  app/
    server/
      index.js
      lib/
        store.js
        process-manager.js
        config-service.js
        instance-service.js
        runtime-service.js
        sync-service.js
    ui/
      ...
  cli/
    index.js
    commands/
      list.js
      status.js
      start.js
      stop.js
      restart.js
      config.js
      sync.js
  docker/
    Dockerfile
    entrypoint.sh
  docs/
    ...
```

## 12. 最终结论

当前项目已经具备完整的多实例管理核心能力，后续开发 CLI 和 Docker 版本时，不建议重新设计业务，而应围绕现有三块核心能力继续抽象：

- 实例存储管理
- 进程生命周期管理
- 远程配置同步管理

推荐路线如下：

1. 先把 `server/index.js` 中的业务编排拆成 service
2. 再开发 `CLI`
3. 最后基于同一业务内核制作 Docker 镜像

这样可以保证：

- 业务逻辑一致
- 成本最低
- 后续维护最简单

