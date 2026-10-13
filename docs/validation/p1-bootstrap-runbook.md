# P1 单 Bot / Codex 受监督首装 runbook

N2 基点 `6ed0b65d2737473f1f36d676be4398c9bc4c296c`；沿用 v1.3、[readiness N2](../plans/p1b-readiness-plan.md#4-n2--把首次安装从说明拼成可复现路径) 和 [原 bootstrap 边界](../../native/macos-sandbox-host/BOOTSTRAP.md)。这是一条**待具名授权执行的准备配方**，不是已安装镜像/VM/CLI 就绪记录。当前只做代码、文档、小合成文件和公开元数据核对；没有大制品下载、真实磁盘分配/挂载、软件安装、VM/用户 Mac/CLI 初始化/登录/模型操作。默认 CI 不执行本文安装命令。

## 1. 单一路径、执行位置和输入

采用固定 Ubuntu Noble ARM64 cloud qcow2 → 新 raw → **获准 ARM64 Linux 准备环境离线 chroot 配置** → 卸载并封存 → 交给获准 ARM64 Mac 的 helper。现有 helper 没有图形/串口交互安装控制台，ISO 的校验入口保留，但本配方不把它称为可操作的交互安装器。当前 Linux x64 云工作区可编译公开 JS，不能直接执行 ARM64 chroot；不隐式安装 qemu-user/改成另一安装路线。

| 执行位置 | 工作与输出 | 前置 / 当前状态 |
|---|---|---|
| 当前云端开发环境 | `npm ci` / typecheck / test / build；公开 `build/guest-node.cjs`、启动脚本、gate、bridge 的源版本/摘要 | 已有无账号代码授权；可执行，不接目标 |
| 单独具名 ARM64 Linux 准备环境 | 校验已批准制品、转换新 raw、离线挂载、安装公开依赖和 AN 文件、配置 rootfs/私有服务、封存 BOM | 下载/安装/挂载/磁盘操作尚未授权或执行 |
| 具名 ARM64 Mac | helper 编译/只读 preflight；经分项批准后 development entitlement、私有盘/EFI、同一 helper 生命周期/连接 | Mac mini M4 仅 UNCONFIRMED 候选；无实际接入 |
| 首次启动后的 guest | systemd → Node Unix socket → vsock bridge；受信 Core 请求 initialize；实际隔离/停写观察 | NOT_RUN；不自动登录或 startTurn |

首轮 `network:none`、helper 无 NIC、guest `actions:["initialize-runtime"]`，空 Bot HOME/认证目录；不配置 login/model.request、不传宿主 Home/SSH/auth/Core DB。N4 网络/账号路线另行核验，不能把 none 改为全网或从 IP allowlist 推定域名/请求控制。

## 2. 固定公开来源与验证层级

2026-10-13 仅核对元数据。每份二进制仍需在获准准备环境实际验签/验 hash 后才能安装。摘要与 publisher signature、集成/再分发许可分别记录；不选择本项目开源许可证。

| 制品 | 固定版本/文件与 SHA256 | 来源与实际证据 |
|---|---|---|
| 基础盘 | Noble `release-20260926` / `ubuntu-24.04-server-cloudimg-arm64.img`（qcow2）；`1d6bffe64b848468ac97f821d369a4846d983de1800ccf6b5ec8853e85cefc55` | [Canonical checksum](https://cloud-images.ubuntu.com/releases/noble/release-20260926/SHA256SUMS)；HTTPS 元数据核对，未验实际大盘/PGP |
| Node | `node-v24.19.0-linux-arm64.tar.xz`；`01443c1e1a29e531ccad5a46fefa6df490d2189c49f7955904aecdbb0fe86fdc` | [Node SHASUMS](https://nodejs.org/dist/v24.19.0/SHASUMS256.txt)、[archive / signed SHASUMS](https://nodejs.org/en/download/archive/v24.19.0)；小文本已读取，tar/签名验证未执行 |
| Codex | `rust-v0.159.2` / `codex-aarch64-unknown-linux-musl.tar.gz`，100955214 bytes；`472ee4d49464a4f8792bbf0162bd9ac18d7036dbc00900a03e95f715887e930f` | [官方 release](https://github.com/openai/codex/releases/tag/rust-v0.159.2)、[API](https://api.github.com/repos/openai/codex/releases/tags/rust-v0.159.2)；此 tag 非 immutable，文件以批准摘要固定，禁止跟 latest |
| Codex 签名元数据 | 同目录 `.sigstore`，8585 bytes；`177267105badf9912855e6933a46e531dc2083feaed86d37fdcec58cfd87f7da` | 小公开 bundle 已读取/解析，**未执行密码学验签**；legacy JSON 包含 cert/base64Signature/rekorBundle |

Codex bundle 载荷声明的原始 binary SHA256 是 `113aa5d5952a6fd3950a88323219747d0c91978ebee948509a540c8a460e59a3`（不是 tar digest）。证书元数据指向 `https://github.com/openai/codex/.github/workflows/rust-release.yml@refs/tags/rust-v0.159.2`，OIDC issuer `https://token.actions.githubusercontent.com`。这些解析字段本身不证明签名通过。

获准后，对**安全解包得到的原始 binary**用批准版本的 cosign 执行：

```sh
cosign verify-blob "$AN_CODEX_BINARY" --bundle "$AN_CODEX_BUNDLE" \
  --certificate-identity 'https://github.com/openai/codex/.github/workflows/rust-release.yml@refs/tags/rust-v0.159.2' \
  --certificate-oidc-issuer 'https://token.actions.githubusercontent.com'
```

遵循 [Sigstore verify-blob](https://docs.sigstore.dev/cosign/verifying/verify/)；工具必须支持该 legacy bundle、正常校验信任根/透明日志，失败时 BLOCKED，不跳过 identity/log/claims。Node signed SHASUMS 和 Ubuntu `SHA256SUMS.gpg` 使用另外准入的官方 trusted public keyring 进行 `gpgv`，再检查文件 hash；不从制品提供的任意 key 自动建立信任。缺 keyring/工具/签名证据是输入缺口，不声称已通过。保留 Canonical [IP policy](https://canonical.com/legal/intellectual-property-policy)、安装包 copyright、Node/Codex 上游许可/用途核验引用；本配方仅私有安装，不推定 bundled redistribution 获准。

准备环境工具 qemu-img/qemu-nbd、cloud-guest-utils、mount/e2fsprogs、tar/xz、gpgv/cosign 也要有批准来源/版本/摘要。guest 使用 Ubuntu 签名仓库的 systemd、bubblewrap、python3、bpftool、git、bash、ca-certificates；禁止 allow-unauthenticated/trusted=yes。未实际安装，故不编造它们的最终 package versions/完整镜像摘要。首次获准解析需保存 signed InRelease、Packages 索引和 `package=version` 下载清单/所有 .deb SHA256；复现使用同一缓存和精确 versions，源撤回/不可用就阻塞，不跟新版本悄然替换。[Ubuntu 包管理](https://ubuntu.com/server/docs/how-to/software/package-management/)

## 3. 可安全执行的当前入口与输出

| 入口 | 能做什么 | 明确限制 |
|---|---|---|
| `npm run build` | 当前源/锁文件构建 guest-node.cjs；JS 可在云端构建 | 不安装 guest；不把 macOS verifier 当 Linux evaluator |
| `node scripts/mac-vm-preflight.mjs` | Mac sw_vers/xcrun 只读；非 ARM64 Mac exit2 | PREFLIGHT_ONLY，不分配/启动；设备上执行仍待目标批准 |
| `node scripts/verify-bootstrap.mjs <iso>` | 只读检查固定 ISO hash/常规文件 | 仅 ISO，不可用来验证本 cloud image；无参数 exit2 |
| `node scripts/prepare-vm-disk.mjs --apply <protected.json> <cloud.img>` | 实际 pin 校验、qemu 转换/扩容、新目标排他发布 | 需要保护授权和真实输入；不安装包、不启动 VM；默认 exit2 |
| `node scripts/start-guest-node.mjs --apply <guest.json>` | 校验显式 guest/listen/key/policy，打开 Runner DB/监听 | 只在授权 guest；没有账号/模型动作由启动隐式触发；无参拒绝 |
| `python3 .../vsock-bridge.py <bridge.json>` | protected target/port/socket 校验，host-CID 转发 | 不启动 CLI/决定 Core 权限；Node/HMAC/expiry 才是上层准入 |
| `node scripts/accountless-node-probe.mjs` | 前置检查，始终 BLOCKED / cliStarted:false | **不是可执行正向 initialize**；不能当 N3 成功探针 |

磁盘脚本现用同一文件系统的 link 排他发布，已有 destination（包括转换期间出现）保留；unlink 仅移除本 operation 的 staging raw。授权在每个副作用前重读，timeout 为一次时钟读取得到的正数剩余期限；真实 converter timeout 未执行。Node初始监听、policy、authority期限/目标和只读journal/目录校验在创建Runner DB/Unix socket之前拒绝；校验后授权/文件变更或启动竞争仍可能留下本次私有状态，必须核查，不自动抹除历史。

## 4. 获准后的准备环境步骤（当前全部 NOT_RUN）

每段都由操作者监督，独立检查退出码和输出后才到下一段；`AN_*` 路径/目标取自获准私有配置，没有默认设备或真实授权示例。不得复制这些安装命令到普通 CI。下列是离线盘安装方法，不是无人值守安装器。

1. 核对准备主机 `uname -m` 为 aarch64、目标/窗口/磁盘/网络动作获准。取得 §2 批准制品和来源证据，检查 archive listing：**仅选取要安装的成员**，它们必须是预期相对常规文件，拒绝绝对路径/`..`/symlink/hardlink/特殊文件；不要完整解包。Node发行包里的npm/npx链接可以存在，但本guest不安装/使用它们（公开JS在云构建）。在新私有staging显式选择regular `node-v24.19.0-linux-arm64/bin/node` 与 `node-v24.19.0-linux-arm64/LICENSE`：

```sh
tar --extract --xz --file="$AN_NODE_ARCHIVE" --directory="$AN_NEW_STAGE" --no-same-owner   node-v24.19.0-linux-arm64/bin/node node-v24.19.0-linux-arm64/LICENSE
# Codex仅提取批准listing中的regular binary成员，保留上游许可；不执行其他成员。
tar --extract --gzip --file="$AN_CODEX_ARCHIVE" --directory="$AN_NEW_CODEX_STAGE" --no-same-owner "$AN_CODEX_MEMBER"
```

实际ARM64 tar listing未下载/验证，若成员名/type/输出hash不同则STOP，不用通配符解包。不要执行 archive 内安装脚本。把 Node/Codex **binary** hash、architecture/version、验签结果、许可引用写入 private installation manifest。
2. 以 owner 0700 新根、0600 preparation.json 运行现有 disk 脚本；root/destination 必须同父，源固定 cloud hash，qemuImg 为准入绝对路径/实际 hash，operationId 稳定。JSON 必需字段为 `targetId,expiresAt,action:"prepare-disk",operationId,root,destination,diskBytes,qemuImg,qemuImgSHA256`。diskBytes 1–128GiB、实际 VM 内存另限，所有 placeholder/expired 示例都不能作为授权。输出 DISK_PREPARED 仅证明 base raw 转换；记下原结果，后续安装会改变它的 hash。
3. 在 Linux 准备主机选择一个**确认未连接、未挂载、已批准**的 NBD 设备与新私有 mount 目录。保存设备原状态，连接仅此 raw，不连接原 qcow2/用户盘：

```sh
: "${AN_NEW_RAW:?}" "${AN_NBD_DEVICE:?}" "${AN_GUEST_MOUNT:?}"
# 人工确认 /sys/block/<nbd>/pid、lsblk/findmnt 没有既有使用者；有则 STOP。
qemu-nbd --format=raw --connect="$AN_NBD_DEVICE" "$AN_NEW_RAW"
lsblk -o NAME,SIZE,FSTYPE,LABEL,PARTLABEL "$AN_NBD_DEVICE"
# 记录实际 cloudimg-rootfs 分区和 EFI 分区；不得猜固定 p1/p15 后执行。
mount "$AN_GUEST_ROOT_PARTITION" "$AN_GUEST_MOUNT"
```

[qemu-nbd](https://www.qemu.org/docs/master/tools/qemu-nbd.html) 接口只提供块设备；不启动 VM。镜像扩容不等于 root filesystem 扩容：确认 ext4/分区布局后，只有对该新盘的实际 root 分区使用 growpart + resize2fs，保留 EFI；未知布局/已有挂载/其他 writer 阻塞。不得对任意 `/dev/nbd0` 自动操作。仅卸载本次 mount、断开本次设备；失败不扫盘清理。
4. 离线 chroot 使用相同 ARM64 ISA。需要的 /proc、/sys、/dev 仅是明确批准的准备挂载，不共享宿主 Home、SSH、auth 或 Core DB；记录挂载列表，结束严格反序卸载。写入临时 `/usr/sbin/policy-rc.d` 返回101，阻止包安装期间自动启动服务；原已存在文件不得覆盖，结束移除仅自己创建的文件。临时 /dev 仅 null/zero/random/urandom 等必要设备，不 bind 宿主整份 /dev/块盘；/sys 只读，不暴露管理 socket。首次获准解析使用该新 guest 的 Noble signed apt sources 和批准的临时 DNS（不读取/复制宿主现有 DNS 配置），包只下载到本 operation 新 cache：

```sh
# 仅获准 chroot 内，AN_DEB_CACHE 是本次新建的私有 guest 路径。
: "${AN_DEB_CACHE:?}"
apt-get update                         # 保存此轮 signed InRelease/Packages
apt-get -o "Dir::Cache::archives=$AN_DEB_CACHE" --download-only install   systemd bubblewrap python3 bpftool git bash ca-certificates
# 检查只有准入的 arm64/all .deb，逐个记录 package/version/arch/hash。
for deb in "$AN_DEB_CACHE"/*.deb; do
  dpkg-deb -f "$deb" Package Version Architecture
  sha256sum "$deb"
done
```

暂停，批准这一轮实际解析的完整依赖锁与 signed-index/hash证据，再用锁中的 `package=version` 数组（包括实际新增依赖）进行 `apt-get --no-download -o Dir::Cache::archives=<同cache> install <精确锁列表>`。**第一次解析本身不是已冻结版本安装**；下次从相同固定基础盘、同一索引/cache/锁执行，缺任何版本或额外下载要求即STOP。记录原base已有包与最终 `dpkg-query -W`，无需为已由固定base提供的包虚构 .deb hash；两个清单都写入manifest。临时 DNS/policy-rc.d恢复仅自己记录的新盘变更；不恢复/清理宿主配置。
5. 在 chroot 内，仅将验签Node archive中选定的node binary安装为 `/opt/an/runtime/bin/node` 并保存LICENSE，将同一binary安装为 `/usr/bin/node`（先检查 base 是否已有目标；有则停止并准入明确替换，不覆盖）。Codex 原始 binary 安装 `/usr/bin/codex`。两个文件 ELF architecture 必须 ARM64，hash 必须等于已批准 binary；不要在准备主机启动 Codex，即使 `--version` 也不是本次已执行证据。
6. 云端用确切获准 Git SHA、Node24.19.0/npm11.9.0、锁文件 `npm ci && npm run build`，生成**公开代码**包。目标内按如下布局安装；逐个目标 `test ! -e` 后才 `install`，不能覆盖旧 operation/管理配置：

```text
/opt/an/node/build/guest-node.cjs
/opt/an/node/scripts/start-guest-node.mjs  # ../build 相对加载必须保持
/opt/an/node/enforcement-gate.mjs        # NodeController 固定路径
/opt/an/node/vsock-bridge.py
/opt/an/runtime/bin/node                # 固定 clean PATH
/usr/bin/node                           # systemd gate 固定路径
/usr/bin/codex                          # bwrap 内固定原生路径
```

文件/父目录 root-owned、代码不可由 Bot 写；记录源SHA及各 hash。不复制 node_modules/宿主 Node/credential caches。guest-node.cjs 不运行 macOS JSC verifier；独立 evaluator 仍在 Mac。
7. **先于任何私有 key/管理配置**，只从干净 public base+已验证 packages/runtime 形成新 `/opt/an/rootfs/codex-0.159.2`。在 chroot 内仅复制 `/usr,/bin,/sbin,/lib` 与存在的 `/lib64`、公开 `/opt/an/runtime`，保留发行版内部正常 usr-merge links；不复制 `/etc/shadow,/root,/home,/run,/var` 或 `/opt/an/node`。`/etc` 只放公开 CA cert、最小 passwd/group/nsswitch（root home=/bot/home，无密码哈希）；保持复制目录的公开来源清单。创建空 `/bot/home,/workspace,/proc,/dev,/tmp,/run` mount points；配置所在父目录本身不能是 symlink。Node mount privatePath 要求**被挂载根及祖先** canonical/non-symlink；内部发行版 symlink 不据此伪称全文件禁止。
8. 新建 root-owned 0700 `/var/lib/an/bots/<bot-id>/{home,project,cache}`、`/var/lib/an/runner/<bot-id>`、`/var/lib/an/node-state/<node-id>`。后三者互不嵌套且管理 DB/journal 不在任何 Bot mount 内。project 放公开/合成固定 Task 项目；HOME/.codex 为空。privateRoot=`/var/lib/an/bots`、rootfsRoot=`/opt/an/rootfs`；policy.rootfs 用它的子目录，不能是管理根 `/`；Node state/runner 使用不同管理目录。选定目录不是有效 sandbox evidence。
9. 配置离线 cloud-init [None datasource](https://docs.cloud-init.io/en/latest/reference/datasources/none.html)，不注入 user-data/key/账号，N3 没有网卡、无需从云 metadata 获取配置。若基础盘实际配置或 boot behavior 不相容则 STOP，不能偷偷改安全保护或加全网。先准备 systemd unit 文件及 `enable` 链接，**不在 chroot 执行 start/restart**：

```ini
# /etc/systemd/system/an-node.service — future authorized guest only
[Unit]
After=local-fs.target
[Service]
Type=simple
User=root
UMask=0077
RuntimeDirectory=an-node
RuntimeDirectoryMode=0700
RuntimeDirectoryPreserve=yes
ExecStart=/usr/bin/node /opt/an/node/scripts/start-guest-node.mjs --apply /etc/an/guest.json
Restart=no
[Install]
WantedBy=multi-user.target
```

bridge 单独 unit `After=an-node.service`/`Requires=an-node.service`，`ExecStartPre=/usr/bin/test -S /run/an-node/node.sock`、`ExecStart=/usr/bin/python3 /opt/an/node/vsock-bridge.py /etc/an/bridge.json`，User=root/UMask0077/Restart=no。Type=simple 不保证 Node socket 已创建；首次 guest 中必须观察该 socket 后手动启动 bridge，失败只检查本 unit，不循环清理/重启。配置和 key 没有准入时 unit 正确行为是失败，不能因此改为空校验。
10. 文件系统仍挂载时记录公开 BOM 和服务/目录检查，不称 runtime-ready。仅在**目标专用**私有安装阶段按 §5 写入真实受保护配置/短期 key；普通可共享镜像不能含它们。退出 chroot、sync、反序卸载所有本次 mounts、断开本次 NBD。确认没有 writer 后计算最终 raw size/SHA256，更新私有 installation manifest（base hash、packages+archives+binary hashes、GitSHA/guest artifacts、rootfs完整文件/链接manifest及digest、服务文件、配置 scope、签名/许可证据、diskBytes）。只把 raw 与脱敏公开 BOM 通过获准通道交给 Mac；目标专用盘包含秘密时按敏感私有制品处理，不传公开 Resource Server。

## 5. 配置映射与失效示例

真实值来自被批准私有文件，**本文件不含可生效授权或 key**。所有示例的 expiresAt 为0、摘要/ID/path为 PLACEHOLDER，必须被现有入口拒绝。配置文件常规/非硬链/非符号链接、owner-only0600，父目录0700，路径 canonical；保护后的 keyRef 不能当作 HMAC key。

```json
{"version":1,"listenConfigPath":"/etc/an/listen.json","runnerDirectory":"/var/lib/an/runner/PLACEHOLDER","botId":"PLACEHOLDER","projectId":"PLACEHOLDER","connectionId":"PLACEHOLDER","grantId":"PLACEHOLDER","expiresAt":0,"actions":["initialize-runtime"],"authority":{"nodeId":"PLACEHOLDER","sandboxId":"PLACEHOLDER","generation":1,"privateRoot":"/var/lib/an/bots","rootfsRoot":"/opt/an/rootfs","stateDirectory":"/var/lib/an/node-state/PLACEHOLDER","nativeRuntime":{"version":"0.159.2","sha256":"PLACEHOLDER"},"authorization":{"targetId":"PLACEHOLDER","expiresAt":0,"actions":["sandbox-exec","accountless-probe"]}},"policy":{"network":"none","discussion":false,"rootfs":"/opt/an/rootfs/codex-0.159.2","home":"/var/lib/an/bots/PLACEHOLDER/home","project":"/var/lib/an/bots/PLACEHOLDER/project","cache":"/var/lib/an/bots/PLACEHOLDER/cache","limits":{"cpuPercent":50,"memoryBytes":536870912,"pids":128}}}
```

| 文件 / 实际消费者 | 精确字段/一致性 |
|---|---|
| guest.json / readP1GuestConfiguration | 上述top-level shape；authority target/期限/allowed actions与只读journal/目录准入在Runner DB前；authority scope与listen绑定 node/sandbox/generation相等；guest期限不超过authority/listen；policy limits/buildSandboxCommand校验在DB前；initialize不授权model/login |
| listen.json / readNodeListenConfig + listenNode | `socketPath:"/run/an-node/node.sock", keyPath:"/etc/an/channel-key.json", binding:{nodeId,sandboxId,generation,transportInstanceId}, expiresAt`；四字段、保护/owner/socket parent/key32bytes检查；只支持一条活动Core channel |
| channel-key.json / Node & Mac protected key reader | `{keyBase64:<实际32byte的canonical base64>}`；只有获准私有阶段生成/传输，不提供默认key；Mac与guest同秘密但文件owner分别为当地运行用户/root |
| bridge.json / Python bridge | `targetId, port:47001, nodeSocket:"/run/an-node/node.sock"`；此config本身没有lease expiry控制，转发不代表授权，Node/driver期限检查仍必需；host CID only |
| Mac helper authority / Swift Host | `protocolVersion:1,nodeId,targetId,expiresAt,root,actions,sandboxes:{<sandboxId>:{botId,disk,efi,cpuCount,memoryBytes,diskBytes,networkMode:"none"}}`；不加bootISO；raw实际size必须等于diskBytes；create generation0、首次start→1 |
| Mac installed runtime / readInstalledRuntime | `version,targetId,expiresAt,botId,nodeId,sandboxId,generation,helper:{helperPath,helperSHA256,authorityPath},node:{privateRoot,keyPath,transportInstanceId,runtimeDigest,policyDigest},profile`；具体profile/Connection在既有[准入表](p1-connection-preflight.md)，N3不配置loginKind/model.request，不伪造Native auth-ready |

**policy相容性：** 该单一路径用 `discussion:false`，仅挂载获准空/公开合成project；它不授权startTurn或模型。当前installed factory拒绝projectReadOnly:true的runtime attestation，不能放宽其校验迁就样例。Discussion真实只读负向使用另一个明确批准的policy/探针，不作为此installed路线的成功报告；policyDigest从确切policy内容计算，不手填假的摘要。

初次generation1需与真实helper start一致；后续冷启动增加 generation，guest target-specific config须由批准的维护更新与真实停写证明协调。不能仅改JSON代际/删除journal绕过same-boot UNKNOWN。权限范围、公有基础镜像与私有实例分开；没有完整、可信安装 manifest 时 `adoptInstalled` 必须保持 blocked。

## 6. Mac 交接与尚缺的首次生命周期调用

Mac只读批准后：`node scripts/mac-vm-preflight.mjs`；`swift build/test --package-path native/macos-sandbox-host`；built helper `--preflight`。真实development签名/`com.apple.security.virtualization`、导入raw、create/start/connect是另外分项批准；不自动使用证书/关闭Gatekeeper。编译通过不能推定虚拟化可用。

**当前源代码接入缺口（不是仅缺设备权限）：** `p1-installed.ts` 构造新 `VMHelperProcessTransport`，prepareInstalled/connectRun只inspect/connect；该factory的provisionRequest是 `PREINSTALLED_TARGET_REQUIRED`，没有首次create/start调用。Swift helper的in-memory VM由该helper实例持有，global writer flock不能由第二个 helper共用。手动另启动helper持有VM，再让桌面创建另一个helper不是可用接入路线。

N3在实际启动前需补/验证**同一受信Main/Core helper transport**的受控首次create/start与后续inspect/connect，保持既有Node/provision readiness、精确generation/owned stop。不另造常驻控制平面、不取消锁、不把persisted running当liveVM。重新按用户要求判断：现有 `assertAdmitted` 固定要求 `model.request`（p1-installed.ts），`P1Application.provision`使用该权限且provisionRequest拒绝；官方授权会话另要求login。N3 **initialize-only** 没有可复用的独立桌面业务入口。只加provider.start会让初装依赖模型/登录权限或生成无使用者的API，不满足明确门禁，故不把它作为N2现有脚本的小修。

最小下一代码切片 **N3-0（仍无真实操作）**：在现有Main/Core增加一个具名环境prepare/initialize入口，独立于model/login；复用唯一helper transport及Bot/provision记录、既有完整绑定/fence/epoch，受保护的目标安装批准只允许create/start/connect/owned stop；初次0→1，当前已running的确切代际可复用，UNKNOWN/错代际/租约失效/未知结果拒绝重播；调用guest固定initialize后立即owned cleanup，并分别记录environment/runner/runtime/auth事实。补默认无副作用、无权限零调用、错误目标/未知状态不重复启动、同一helper对象、generation和cleanup失败保留的合成回归。该切片涉及**新的受信业务入口与准入映射**，不是仅补安装脚本；不需要新控制平面或通用installer，代码可以在下一明确切片无账号验证，真实VM仍另等N3操作许可。

本runbook交付离线guest准备步骤，**不宣称现有桌面已能首次启动/接入该盘**。现有`accountless-node-probe`也仅BLOCKED，正向initialize需通过这条受信生命周期/Node channel接线，不能用宿主CLI替代。

## 7. 故障、已有目标与重试

| 条件 | 动作 / 保留项 |
|---|---|
| hash/signature/license/scope/expiry/config失败 | STOP；初始disk授权失败不创建staging，初始listen/policy/authority/journal错误不建Runner DB；公开制品验证失败不进入安装；不要扩大权限 |
| destination已存在或转换期间出现 | DISK_DESTINATION_DENIED，保持原字节；不force/rename覆盖。核对实际归属与摘要，不把existing当成功 |
| 同operation staging已有/转换中断/expiry | INTERRUPTED_PREPARATION_REQUIRES_REVIEW或BLOCKED；保留本operation staging，人工核查唯一owned进程后才决定后续，不能盲重跑/清用户目录 |
| 排他link成功但后续hash/报告/清理失败 | 目标可能已发布，按UNKNOWN核对该operation实际raw/摘要/size；不重复转换或删除目标，不假称失败没有副作用 |
| 离线安装/挂载失败 | 记录步骤、包/设备/挂载实际状态，仅卸载自己创建的mount/NBD；保留新盘供核查。不能从base conversion报告推定AN安装完成 |
| guest bind失败/旧socket/journal存在 | 不unlink旧socket、重置DB或循环自动restart。可信证明旧owner/writer停止后按获准维护处理；未知保留UNKNOWN |
| helper同主机boot崩溃 | UNKNOWN；无same-boot完整恢复支持，不能双writer。不同实际kernel bootUUID恢复另有generation门禁 |
| BPF/userns/bwrap/资源/route不足 | 执行点拒绝，无宿主/全网fallback；细于IP出口、每Bot配额、硬RAM仍未支持/未证 |

完整 VM 初装、UEFI boot、cloud-init behavior、BPF/cgroup正负例、guest关闭→helper退休、真实子writer停写与TaskA/B都未执行。160000byte workspace transfer上限、A5 UTF8文本prefix/结构test检查范围和硬RAM限制保留，不删GATE或人工项。

## 8. 本轮验证与 N3 最小分项授权

脚本边界新增回归先RED：转换期间出现目标被覆盖、三种监听错误仍建Runner DB；最小修复后定向与全套通过。独立一次审查另指出policy/archive相容性及journal准入顺序，已在根的一次fix pass修文档并新增journal/authority RED→GREEN，保留未执行actual install状态。磁盘harness采用合成源pin/小输出size和converter记录桩，证明控制流/真实小文件排他发布，不是大盘、qemu或超时kill证明。Node测试只读合成配置，不读用户凭据、不启动CLI。实际数量与当前SHA的四组CI最终记于[P1报告](p1-report.md)及Issue1。

推进N3前一次确认：**Mac validationTargetId/owner/操作者/窗口**及**ARM64 Linux准备目标/owner/窗口**；是否分别允许①只读探针②制品下载/签名工具与公开包安装③新私有盘分配/挂载/chroot/配置及封存④development entitlement/导入/create/start/connect/owned stop⑤无账号initialize/合成隔离与停写负向；路径/设备/资源/网络/时限/清理保留范围只进私有配置。**登录/模型/费用N4未请求或授权**。缺首次helper接线、trusted package lock/signatures、真实boot/enforcement证据仍分别BLOCKED；给出设备批准不会抹去实现缺口。N2到此停止，不自动推进N3。
