# 主机接入、分组与管理

管理入口位于管理员菜单的「主机接入与管理」，也可从节点列表进入。默认的「主机管理」页显示已有宿主机，包括名称、编号、公网 IP、管理地址、账号、在线状态、实例数量和当前协议。选择「管理」进入该宿主机的设置、实例、存储及运维页面；「协议」可以直接切换 TCP 或 TCP+UDP。

机型与地区是两个独立分组维度，例如 E2 / ARM 和法兰克福 / 东京。可组合筛选、单独修改或勾选本页机器批量调整。分组支持自定义名称；不会根据 CPU 架构猜测 OCI 机型。导入新机器时可指定默认分组，也可在 CSV 中逐台填写。已有机器无需重新接入即可分组。

「接入任务」页显示每台机器的安装进度、失败原因及重试入口。任务、分组和进度保存在 PostgreSQL；执行发生在主控，关闭浏览器或更换电脑不会中断任务。日常接入与管理在网页完成，SSH 作为额外的宿主机排障入口。

## 主控准备

主控需要运行 WireGuard 管理接口 `incudal-mgmt`，使用 `10.0.0.0/8` 内的独立 IPv4 网段（前缀长度 16–30）。请给控制端分配网段内的主机地址，并允许宿主机访问 WireGuard 的公网 UDP 端口。已有管理隧道和节点保持原配置。

在主控的项目目录，以 root 安装受限网关：

```bash
bash scripts/install-onboarding-gateway.sh /opt/incudal-oci/server/certs/onboarding-gateway.key
```

脚本安装 `/usr/local/sbin/incudal-onboarding-gateway`，并准备两套用途不同的密钥：

- `/root/.ssh/incudal-host-management`：由主控保存，用于管理员登录宿主机。新接入机器只接收它的公钥，并限制来源为主控的管理地址。
- `server/certs/onboarding-gateway.key`：应用使用的独立密钥，只能执行受限网关的状态检查与幂等注册操作，不能运行任意 shell 或建立转发。

将安装输出中的网关 SSH 指纹和实际网络信息填入主控 `.env`：

```dotenv
FRONTEND_URL=https://panel.example.com
ONBOARDING_GATEWAY_HOST=10.253.240.1
ONBOARDING_GATEWAY_PORT=22
ONBOARDING_GATEWAY_KEY_PATH=/app/server/certs/onboarding-gateway.key
ONBOARDING_GATEWAY_FINGERPRINT=SHA256:替换为安装输出中的指纹
ONBOARDING_WG_ENDPOINT=control.example.com:51820
ONBOARDING_SSH_JUMP_HOST=control.example.com
```

以上地址是示例。`ONBOARDING_GATEWAY_HOST` 必须能从应用容器访问；`ONBOARDING_SSH_JUMP_HOST` 是管理员在外部电脑登录主控时使用的地址。不要把主控 SSH 私钥放进浏览器、仓库或应用的证书挂载目录。

使用新的镜像重新创建应用容器。入口脚本会以 `0600` 权限复制受限网关密钥，并执行数据库迁移：

```bash
docker compose up -d --build app
```

Agent 需要 `v0.0.10` 或更新版本，该版本同时支持 systemd 和 Alpine OpenRC 的自动升级。自行部署时先发布自己的 Agent Release，并按现有方式配置 `INCUDAL_AGENT_RELEASE_REPOSITORY`。应用只有在收到 Agent 心跳及协议应用回执后，才将接入任务标记为就绪。

## 新增单台宿主机

先将宿主机 DD 为纯净 Alpine 或 Debian，并允许 root SSH 登录。在主机管理页点击「新增宿主机」，填写 IP / 域名、SSH 端口（默认 22）和 SSH 密码，点击「开始接入」。也可切换为私钥登录。

名称默认按地址生成；无需填写批次名称或账号。「分组与更多设置」可选填自定义名称、账号、E2 / ARM 等机型、地区和 SSH 指纹，并调整国家、协议及资源。默认 CPU 上限 200%、内存 768 MB、存储池 30 GiB，较大规格机器可在提交前调整。接入成功后，在主机管理页查看和操作。

域名由主控解析，需要一个直接指向该宿主机公网 IPv4 的 A 记录。解析结果固定保存到任务，后续安装及重试使用此 IP，任务页显示实际地址。多个不同 A 记录、内网地址或无 A 记录会返回明确错误；可改填具体公网 IP。域名后续变更不会改变已有任务的连接目标。

## 批量导入机器

支持已准备好的 Alpine、Debian、Ubuntu、Rocky Linux 宿主机，必须允许 root SSH 登录。每批最多 50 台，支持 CSV、TSV 或直接粘贴清单：

```csv
name,publicIp,sshPort,machineGroup,regionGroup,countryCode
node-01,203.0.113.10,22,E2,Frankfurt,de
node-02,203.0.113.11,2222,ARM,Tokyo,jp
```

替换示例 IP 后使用。`name`、`publicIp` 必填；`sshPort` 默认为 22。可选列包括 `machineGroup`、`regionGroup`、`countryCode`、`sshFingerprint`、`password`、`privateKey`。单行分组优先于批次默认值，空白分组或国家使用批次默认值。含逗号、引号或换行的内容应按 CSV 规则引用；空白凭据使用表单中的共用凭据。凭据不会进入任务列表或错误日志。

建议填写 OpenSSH `SHA256:` 主机指纹。省略时会固定第一次连接得到的指纹，后续连接及重试均拒绝不一致的指纹。

每台机器依次执行检查、管理隧道配置、Incus/Agent 安装、网络配置和服务验证。检查失败时不会继续安装；已有 Incus/LXD 或客户实例的机器不会作为空机处理。CPU 百分比、内存与存储池大小按批次设定，应给宿主系统预留资源。

安装任务通过数据库租约领取，并发执行最多每个应用进程 2 台。远端安装独立运行，进程、开机标识及退出记录保存在 `/root/.incudal-onboarding/<任务 ID>/`；主控重启后继续检查，避免重复安装。单次尝试上限 45 分钟。

失败任务可重试；排队中或失败任务可取消。取消会停止后续执行并删除暂存凭据，保留已有宿主机及部分配置。凭据在成功或取消后立即清除，失败时加密保留最多 24 小时供重试使用；过期后需重新输入。安装日志仅保存在宿主机受限目录，不回传原始输出。

## 从其他电脑管理宿主机

先使用主控自己的 SSH 登录凭据连接主控：

```bash
ssh root@control.example.com
```

随后在主控执行页面中该机器的 SSH 命令，例如：

```bash
ssh -i /root/.ssh/incudal-host-management -p 22 root@10.253.240.3
```

首次连接时对照页面显示的固定指纹。公网 22 端口可能分配给客户容器；宿主机使用管理地址，操作不依赖开发电脑。主控的常规备份应包含面板数据库、`/etc/wireguard/`、`/var/lib/incudal-onboarding/` 和 `/root/.ssh/incudal-host-management*`，凭据仍需保存在受限位置。

## TCP / TCP+UDP

节点设置中的公网端口协议由 Agent 在宿主机执行。仅 TCP 阻止转发至 Incus 管理网桥的 UDP 入站，包括已有入站 UDP 流；实例发起的 UDP 请求及其返回、DNS 和主控管理连接保留。设置覆盖 IPv4 与 IPv6。

界面分别显示已生效协议、等待生效和失败状态，只有当前配置对应的 Agent 回执可更新状态。节点不允许 UDP 时，单个及批量端口申请接口都会拒绝 UDP。恢复规则会在 Incus 启动前加载，Agent 运行时也会重新校验。

批量接入登记宿主机，不自动创建客户实例、出售整机、执行故障换机或恢复备份。
