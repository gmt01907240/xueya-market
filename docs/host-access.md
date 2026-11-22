# 公网 IP 与 SSH 密钥获取指引

用于完成 [deploy/upload.ps1](../deploy/upload.ps1) 一键上传部署前的准备。全部操作在 Windows 本机 PowerShell 中完成，无需额外软件（系统自带 OpenSSH 9.5）。

---

## 一、获取公网 IP

公网 IP 是云主机对外暴露的地址，与你电脑的出口 IP 不是一回事。

### 1. 云厂商控制台（最准确）

| 平台 | 路径 | 注意事项 |
| --- | --- | --- |
| 阿里云 ECS | 控制台 → 云服务器 ECS → 实例列表 → 「公网 IP」列 | 若为空，需绑定弹性公网 IP（EIP） |
| 阿里云轻量应用服务器 | 控制台 → 轻量应用服务器 → 服务器列表 → 公网 IP | 默认带公网 IP，含独立防火墙 |
| 腾讯云 CVM | 控制台 → 云服务器 → 实例列表 → 主 IP 地址（公网） | 无公网 IP 时需绑定 EIP |
| 腾讯云轻量 | 控制台 → 轻量应用服务器 → 实例 → 公网 IP | 防火墙规则需单独放行 3300 |
| 华为云 ECS | 控制台 → 弹性云服务器 → IP 地址列 | 需绑定弹性公网 IP |
| AWS EC2 | 控制台 → EC2 → Instances → Public IPv4 address | 重启后公网 IP 可能变化，建议绑定 Elastic IP |
| Azure VM | 门户 → 虚拟机 → 概述 → 公共 IP 地址 | 需在网络安全组放行端口 |
| 自建/VPS | 服务商面板「IP 地址」或开通邮件 | 常见于搬瓦工、Vultr、DigitalOcean |

### 2. 在主机上直接查（已能登录时）

```bash
curl -4 ifconfig.me
# 或
curl -4 https://api.ipify.org
```

### 3. 判断是否可直接使用

- **云服务器**：有公网 IP 或 EIP 即可，下一步只需确认安全组/防火墙放行 SSH（22）和业务端口（3300 或 80/443）。
- **家庭宽带 / 内网机器**：通常处于 NAT 后，没有独立公网 IP，无法直接被公网访问。需改用云主机，或做内网穿透（frp、Cloudflare Tunnel），不在本指引范围内。
- **IPv6**：若只有 IPv6 地址，访问地址需写成 `http://[2408:xxxx::1]:3300`，并确认本地网络支持 IPv6。

---

## 二、生成 SSH 密钥（Windows 本机）

当前机器 `C:\Users\管谟韬\.ssh` 尚不存在，执行以下命令会自动创建。

```powershell
# 1) 生成 ed25519 密钥（比 RSA 更短更安全）
ssh-keygen -t ed25519 -C "xueya-deploy" -f "$HOME\.ssh\xueya_deploy"

# 提示 Enter passphrase 时直接回车两次（空口令），便于脚本自动上传
# 生成的私钥：C:\Users\管谟韬\.ssh\xueya_deploy
# 生成的公钥：C:\Users\管谟韬\.ssh\xueya_deploy.pub
```

> 如果希望密钥带口令，可设置口令；此后每次上传需手动输入，`upload.ps1` 仍可正常工作（scp/ssh 会提示输入）。

查看公钥内容：

```powershell
Get-Content "$HOME\.ssh\xueya_deploy.pub"
```

输出形如 `ssh-ed25519 AAAAC3Nza... xueya-deploy`，这一整行就是要添加到主机的公钥。

### 权限收紧（可选但推荐）

Windows 上私钥权限默认已限定当前用户。如使用 WSL/Git Bash，需执行：

```bash
chmod 600 ~/.ssh/xueya_deploy
```

---

## 三、把公钥添加到主机

### 方式 A：创建实例时绑定（推荐）

1. 在云厂商控制台进入「密钥对」页面，选择「导入密钥对」。
2. 粘贴上一步 `.pub` 文件的全部内容，命名如 `xueya-deploy`。
3. 创建实例时选择该密钥对；已创建的实例可在控制台「绑定/重置密钥」中更换（多数平台需重启生效）。

### 方式 B：已有密码登录权限，手动追加

先用密码登录一次：

```powershell
ssh root@<公网IP>
```

在主机上执行（把引号内替换为你的公钥整行）：

```bash
mkdir -p ~/.ssh && chmod 700 ~/.ssh
echo 'ssh-ed25519 AAAAC3Nza... xueya-deploy' >> ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys
```

### 方式 C：仅密码登录（不生成密钥）

可以跳过密钥，直接在上传时输入密码。但 `upload.ps1` 无法自动传入密码，需要手动执行 scp/ssh（见第四节备选命令）。生产环境建议使用密钥并关闭密码登录。

---

## 四、验证连接

```powershell
ssh -i "$HOME\.ssh\xueya_deploy" -p 22 root@<公网IP> "hostname && uname -a"
```

首次连接会提示确认主机指纹，输入 `yes` 回车。看到主机名与内核信息即表示成功。

常见失败与处理：

| 报错 | 原因 | 处理 |
| --- | --- | --- |
| `Connection timed out` | 安全组/防火墙未放行 22 | 控制台安全组添加入方向 TCP 22，来源填你的公网出口 IP |
| `Permission denied (publickey)` | 公钥未绑定或用户不对 | 确认实例绑定的是同一密钥；确认用户名（Ubuntu 镜像常为 `ubuntu`，Debian 为 `admin`） |
| `Permission denied (password)` | 密码错误或已禁用密码登录 | 用控制台 VNC 登录重置密码 |
| `Host key verification failed` | 主机重装导致指纹变化 | 删除旧记录：`ssh-keygen -R <公网IP>` |
| `ssh: connect to host ... port 22` | 端口被改 | 向服务商确认 SSH 端口，上传时用 `-SshPort` 指定 |

确认 SSH 端口是否被改动：

```bash
sudo grep -E '^Port|^#Port' /etc/ssh/sshd_config
```

---

## 五、还需要放行的端口

| 端口 | 用途 | 何时需要 |
| --- | --- | --- |
| 22 | SSH 登录与上传 | 必须 |
| 3300 | 直接访问应用 | 不用 Nginx 时 |
| 80 / 443 | HTTP/HTTPS 反向代理 | 配域名与证书时（推荐） |

阿里云/腾讯云在「安全组」放行，轻量应用服务器在「防火墙」放行，系统内还需检查 ufw/firewalld（`install.sh` 会在 ufw 已启用时自动放行 3300）。

---

## 六、提交给部署执行方的信息

拿到后按下表提供即可开始上传与上线：

| 项 | 示例 |
| --- | --- |
| 公网 IP 或域名 | `47.98.12.34` |
| SSH 用户名 | `root` / `ubuntu` |
| SSH 端口 | `22` |
| 私钥路径 | `C:\Users\管谟韬\.ssh\xueya_deploy` |
| 部署目录 | 默认 `/opt/xueya` |
| 是否配置域名 + HTTPS | 是/否；如是请提供域名 |

对应上传命令：

```powershell
powershell -ExecutionPolicy Bypass -File deploy\upload.ps1 `
  -Server 47.98.12.34 -SshUser root -SshPort 22 `
  -KeyPath "$HOME\.ssh\xueya_deploy"
```

### 备选：仅密码登录时手动上传

```powershell
# 打包
tar -czf "$env:TEMP\xueya-deploy.tar.gz" --exclude=node_modules --exclude=data --exclude=.git -C . .

# 上传（会提示输入密码）
scp "$env:TEMP\xueya-deploy.tar.gz" root@47.98.12.34:~/xueya-deploy.tar.gz

# 解压并部署
ssh root@47.98.12.34 "mkdir -p /opt/xueya && tar -xzf ~/xueya-deploy.tar.gz -C /opt/xueya && cd /opt/xueya && bash deploy/install.sh"
```

---

## 七、安全建议

- 私钥仅保存在本机 `~/.ssh`，不要贴到聊天、仓库或工单中；泄露后立即在控制台解绑并重建密钥对。
- 上线稳定后在 `/etc/ssh/sshd_config` 设置 `PasswordAuthentication no`，并重启 sshd。
- 安全组 SSH 来源尽量限定为你的固定出口 IP，而不是 `0.0.0.0/0`。
