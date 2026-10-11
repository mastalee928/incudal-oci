# Incudal

Incudal 是一个基于 Incus 的容器与 KVM 虚拟机管理、销售和托管平台，包含用户面板、管理后台、节点 Agent、计费系统、NAT 端口映射、通知系统及节点安装工具。

本仓库由 [mastalee928/incudal-oci](https://github.com/mastalee928/incudal-oci) 独立维护，保留完整源码和 Git 历史。部署、更新和 Agent 下载默认使用本仓库，原项目版权和 BSD 3-Clause 许可声明保留在 `LICENSE` 中。

> 本分支包含生产环境持续维护的安全、节点兼容性、计费与界面改进。完整修改原因和部署说明见 [CHANGELOG.md](./CHANGELOG.md)。

## 主要功能

- Incus 容器与 KVM 虚拟机生命周期管理
- IPv4 NAT、IPv4 NAT + IPv6、IPv4 NAT + IPv6 NAT、IPv6 Only 等网络模式
- 单端口及批量端口映射，支持 TCP、UDP、对等范围映射和冲突回滚
- 套餐、余额、续费、退款、人工充值与账单管理
- 套餐流量及按量流量计费、欠费提醒与自主还款
- 创建失败重试及防重复退款
- 数据库原子 IP 预留及 IPv4/IPv6 防碰撞
- 节点资源、流量和在线状态监控
- 节点 Agent 心跳、安全事件上报及管理员强制更新
- Telegram、邮件、站内信等通知方式
- 中英文界面、公共落地页、方案概览与预览页

## 当前版本的重要改进

### 计费与资源一致性

- 套餐流量与按量流量使用同一套结算基础设施，支持阈值结算、小时兜底、低余额提醒和欠费恢复。
- 流量重置和套餐切换不会再把未付款流量标记为已结算；切换到包量套餐时会处理遗留 pending 账单。
- 余额、退款、VIP 奖励、资源池、宿主机资源计数和 NAT port 预留均使用事务及原子增减。
- 延迟支付回调可以处理已过期清理的订单，重复回调保持幂等。

### IPAM 与实例交付

- IPv4/IPv6 会在创建 Incus 实例前完成数据库原子预留，并由唯一索引仲裁并发请求。
- 同一宿主机不能重复分配相同地址；Routed IPv6 在全部宿主机之间保持唯一。
- 创建失败重试复用有效预留；无预留的历史字段会重新分配，避免反复尝试同一个冲突 IP。
- `ipv6_only` 容器和虚拟机均会生成完整 guest 网络配置。
- 创建、升级、停止、销毁和退款操作采用状态认领与补偿路径，减少进程崩溃或 Worker 竞争留下半完成状态。

### 并发与数据库稳定性

- 热点 advisory lock 使用快速失败模式，API 返回可重试的 `409`，后台任务退避后重试，不让锁等待耗尽连接池。
- Prisma 连接池默认 `DB_POOL_MIN=0`，并可分别配置连接、空闲、statement 和 query timeout。
- 流量及实例 Worker 按宿主机限制并发，避免调度高峰同时占满 PostgreSQL 和 Incus 连接。

### 节点安全

- 新节点默认启用每实例 PPS 防护：总限制和单一目的 IP 最低阈值均为 `20,000 PPS`；全局保护只计 UDP 与 TCP SYN，避免正常 TCP 下载被误伤。
- nftables 按实例来源 MAC 和目的 IP 精确封锁，不影响同节点其他实例。
- Agent 将安全事件上报面板，面板精确关联实例和用户。
- TCP SYN 单目标超限才执行网络层目标封锁；UDP 单目标超限只记录并通知管理员，需人工确认后再执行用户封禁，避免正常高速下载或 UDP 业务造成误封。
- 无法关联实例时只执行网络层封锁和管理员告警，不猜测或误封。

### Agent 运维

- Agent `v0.0.7` 支持实例 MAC、安全事件、网络策略、任务租约及实例报告去重校验。
- 管理员可从节点列表一键强制下发 Agent 更新。
- 离线节点会保留待更新任务，恢复心跳后继续执行。
- 更新包校验来源与 SHA-256 后才会替换程序并重启。

### 节点系统兼容性

安装脚本支持 Debian、Ubuntu、Rocky Linux 9/10 和 Alpine Linux 3.20+。脚本可识别 cloud、virtual、AWS、Azure、GCP、Oracle、KVM 和 Xen 内核。ZFS 不可用时会回退到 dir/btrfs。Alpine 使用 OpenRC，并提供轻量化部署路径。

### 端口映射

添加端口时可选择“单个端口”或“批量端口”。批量模式分别填写外部起始／结束和内部起始／结束端口，两段数量必须相同并按顺序对应。前后端都会验证范围、配额、协议冲突和节点允许端口；失败时回滚已创建内容。

### 公共页面与方案预览

- 公共落地页、概览页、方案预览页统一主题与图标风格。
- 方案描述最多显示两行，超出部分使用省略号。
- 多计划方案按最低至最高流量显示，不再把有限套餐错误标记为“无限”。
- 离线节点方案禁止购买。

## 技术栈

- 前端：Vue 3、TypeScript、Vite、Pinia、Vue Router、Tailwind CSS
- 服务端：Node.js 20+、Fastify、TypeScript、Prisma
- 数据库：PostgreSQL 16；缓存：Redis 7
- 节点：Incus、nftables、Go Agent

## 快速部署

主控使用已安装 Docker Compose、Git、Python 3.9+ 的 Debian/Ubuntu（systemd）。Alpine/Debian 宿主节点通过面板接入，独立于主控安装。

```bash
git clone https://github.com/mastalee928/incudal-oci.git
cd incudal-oci
cp .env.example .env
bash scripts/init-env.sh
sudo bash scripts/install-source.sh
```

上述命令从当前 Git 提交构建镜像、记录运行提交，并安装网页更新所需的主控执行器。执行前请先填写 `.env` 中的站点地址和必要配置，并保持源码工作区干净；安装器会在构建前后检查源码，避免把本地改动标记为已发布提交。Git 同步不会复制 GitHub Releases 附件或 GHCR 镜像；节点接入需先按 [Agent 发布说明](./agent/README.md) 发布本仓库的 Agent。

默认仅监听 `127.0.0.1:3000`，生产环境应通过受信任反向代理提供 HTTPS。启动前至少确认 `POSTGRES_PASSWORD`、`JWT_SECRET`、`ENCRYPTION_KEY`、`ADMIN_PASSWORD`、`FRONTEND_URL` 和 `SITE_URL` 已正确配置。不要提交生产环境 `.env`。

Docker 入口脚本会在启动应用前自动执行 Prisma migration。首次升级到 2026-09-16 版本时，IP 唯一索引迁移会检查历史数据；如果已有活动实例撞 IP，迁移会停止并要求人工核对，不会自动覆盖运行中实例的地址。

## 本地开发

要求 Node.js 20+ 和 pnpm 9：

```bash
corepack enable
pnpm install
cp .env.example .env
pnpm dev
```

构建全部项目：`pnpm build`。

## 升级现有部署

源码 Docker Compose 部署首次启用网页更新时，在仓库目录执行以下命令。升级前自行备份 PostgreSQL 和 `.env`；保持源码工作区干净，先处理本地代码改动。

```bash
git pull --ff-only origin main
sudo bash scripts/install-source.sh
```

随后在「管理 → 系统更新」手动检查本仓库 **main**，查看当前运行提交、目标提交和 CI 状态。确认后，执行器下载已选定的完整提交并构建镜像；构建成功后暂停面板写入、备份数据库、启动新版本并验证实际运行提交。CI 未通过或 main 在确认前发生变化时不能开始更新。

更新执行器作为独立 systemd 服务运行，状态保存在 `/var/lib/incudal-updater/status.json`，页面在面板重启后继续显示进度。执行器仅向应用提供受限 Unix socket，配置在 `/etc/incudal-updater/`；不需要把 Docker socket 挂载给应用。每次成功更新也会更新执行器本身。

更新后的 Git 工作区停在所选提交（detached HEAD），日常继续使用网页更新。若必须手工更新，先确认 `git status --short` 干净，再 `git fetch origin main`、`git checkout --detach origin/main`，运行 `sudo bash scripts/install-source.sh`。不要在该状态下直接套用 `git pull`。本地 `docker-compose.override.yml` 和 `.env` 保留；自定义 Compose 文件应放在项目内，并在首次安装执行器前配置 `COMPOSE_FILE`。

备份为 `/var/lib/incudal-updater/database-<任务ID>.dump`。新版本启动失败时执行器尝试恢复之前的镜像和源码提交，但**不会自动恢复数据库**；迁移可能已执行。恢复失败时查看状态文件与 `journalctl -u incudal-updater -u 'incudal-update@*'`，由管理员判断是否恢复数据库备份。保留备份期间应定期检查磁盘空间。

直接使用 Node.js 运行的部署仍通过终端更新，当前网页执行器适用于源码 Docker Compose 部署：

```bash
pnpm install
cd server
npx prisma migrate deploy
npx prisma generate
cd ..
pnpm build
```

随后重启服务端，并通过管理员节点页面向节点强制下发最新版 Agent。数据库升级前请先备份 PostgreSQL；`ENCRYPTION_KEY` 不可随意更换。

### 远程更新

使用预构建镜像或产物包的部署，在本仓库已发布对应版本后，可以运行远程更新脚本。先在本仓库的本地副本中拉取更新，再指定本次提交，确保下载的安装脚本来自确定的版本：

```bash
git pull --ff-only origin main
sudo bash scripts/remote-update.sh \
  --source https://github.com/mastalee928/incudal-oci \
  --ref "$(git rev-parse HEAD)"
```

脚本会自动识别 Docker Compose 与 systemd 产物包部署，并在升级前保留现有 `.env`、证书和数据库数据。

这些产物包脚本不参与网页 main 更新。Agent 仍通过独立的 `agent-v*` Release 发布和节点页面更新；面板不会再把 Agent Release 当成面板版本。私有仓库可在 `.env` 设置 `INCUDAL_UPDATE_GITHUB_TOKEN`（Contents / Actions 读取权限），与 Agent 的下载令牌分开。

## 主机池与接入

管理员按「机型分组 → 地区 → 宿主机」查看库存和实际客户归属。初始 E2、ARM 分组各含凤凰城、圣何塞、伦敦、首尔，机型与地区都可新增、改名、删除；空分组会保留，删除分组只清除归属。已结束的接入任务支持删除记录，宿主机和实例保留；排队或执行中的任务不能直接删除。

新增宿主机填写公网 IP/域名和 SSH 凭据，选择地区以及可选规格：

| 规格 | CPU 配额 | 客户内存 |
| --- | --- | --- |
| E2 | 200%（2 个逻辑 CPU 配额） | 768 MiB |
| ARM1C / ARM2C / ARM3C / ARM4C | 100% / 200% / 300% / 400% | 4 / 8 / 12 / 16 GiB |

所有规格都可选择 30、60、90、120 GiB 客户磁盘或自定义容量。自动模式实测架构、CPU、物理内存和可用磁盘；内存预留 `max(192 MiB, 物理内存的 20%)` 后向下取整到 64 MiB。预设与实测不匹配、物理资源不足时接入会明确失败，不会悄悄调小客户额度。

客户磁盘与底层存储池分开：池额外预留 `max(4 GiB, 客户磁盘的 10% 向上取整)`，宿主文件系统另外保留 4 GiB，以及需要新建时的 1 GiB swap。接入会复用足够大的磁盘 swap，或创建持久化 1 GiB swap；不把 zram/swap 当成物理或客户内存。

通过接入流程加入的机器实行一台宿主机一个客户实例，分配和数据库约束都防止重复占用；正在清理或结算删除账单的实例仍占库存。旧宿主机迁移保留原配额，不猜测历史客户磁盘额度。套餐、商品与购买页绑定机型/地区另行实现。

## 项目结构

```text
agent/          节点 Agent（Go）
client/         用户面板与管理后台（Vue）
server/         API、任务调度、计费和节点安装模板
invite-bot/     Telegram 群组 Bot
scripts/        部署与环境初始化工具
CHANGELOG.md    完整变更、原因和部署注意事项
```

## 安全建议

- 面板必须使用 HTTPS，并正确配置受信任代理。
- Agent 密钥、SMTP 密码、Telegram Token、数据库连接和 SSH 私钥只应保存在环境变量或受限配置文件中。
- PPS 阈值应根据上游封锁线调整，不要在未实测前随意提高。
- 当前尚未默认启用并发连接数封锁，避免误伤正常长连接业务。
- 不要用数据库级 `idle_in_transaction_session_timeout` 掩盖连接池耗尽；应优先保持短事务、限制 Worker 并发，并使用快速失败锁与退避重试。

## 许可证与免责声明

本项目使用 [BSD 3-Clause License](./LICENSE)。项目按“现状（As-is）”提供，部署者自行承担运行、数据、安全、计费及合规风险。Incudal 名称不构成对任何衍生网站、程序或仓库的认可或背书。
