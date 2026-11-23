# FESTO Connector 离线部署指南

适用于 **Windows (Intel/AMD 64 位)**，应用与 PostgreSQL 均通过 Docker 运行，无需安装 Node.js 或本地数据库。

> 本交付包仅包含程序镜像与空表结构，不含开发环境配置数据；首次启动后请在网页中配置 MQTT 与 PLC。

## 交付文件清单

| 文件 | 说明 |
| --- | --- |
| `festo-connector-images.tar` | 离线镜像包（`festo-connector:1.0.2` + `postgres:17-bookworm`） |
| `festo-connector-images.tar.sha256` | 镜像包 SHA-256 校验值 |
| `compose.yaml` | Docker Compose 编排文件 |
| `.env` / `.env.example` | 端口（`APP_PORT`）、数据库密码与平台配置 |
| `init/01-schema.sql` | 首次启动自动执行的建表 SQL |

## 快速部署（Windows）

1. 确保已安装并启动 **Docker Desktop**（WSL 2 + Linux containers）。
2. 将整个 `deploy` 文件夹复制到目标电脑（例如 `C:\FESTO\deploy`），保留 `init` 子目录。
3. 在 PowerShell 中进入该目录，确认 `.env` 配置（若无 `.env` 可从 `.env.example` 复制并修改密码）：

```powershell
cd C:\FESTO\deploy
```

4. 导入离线镜像并启动服务（`.tar` 无需解压）：

```powershell
docker load -i festo-connector-images.tar
docker compose up -d --wait
docker compose ps
```

5. 浏览器打开 `http://localhost:<APP_PORT>`（详见 `.env` 中的 `APP_PORT`，默认 `8080` 或 `8087`）。
   - 健康检查：`http://localhost:<APP_PORT>/api/health`，返回 `{"ok":true,"database":true}` 即正常。

## 网页配置要点

1. 先配置并保存 **MQTT Broker**，再添加 **PLC**（支持 Modbus TCP、Siemens S7、OPC UA），点击 **Test connection** 后 **Save**。
2. **主机地址说明**（应用运行在容器内，不可填 `localhost` 指向宿主机）：
   - 局域网内的 PLC / Broker：填写设备实际 IP 或主机名
   - 本机（Windows 宿主机）运行的 MQTT Broker：填写 `host.docker.internal`
3. 内置 **Debug Bot**（顶部栏切换）：无需 API Key 即可在「实时巡检工作台」检查气缸未更新时长、MQTT 实时采样、Broker 消息堆积与配置体检；配置 DeepSeek 等大模型 Key 后可启用智能对话排障。
4. 容器重启后，已保存的 Modbus 采集任务会自动恢复；其他协议可在网页中点击 **Rescan** 恢复。

## 常用运维命令

在 `deploy` 目录的 PowerShell 中执行：

```powershell
# 查看运行日志
docker compose logs --tail=100

# 停止 / 启动（保留所有数据）
docker compose stop
docker compose up -d --wait
```

> 请勿执行 `docker compose down -v`，否则会清空 PostgreSQL 数据卷。

## 版本升级

保留客户原有的 `.env` 和 Docker 数据卷，仅替换新版本 `festo-connector-images.tar` 及 `compose.yaml`，然后执行：

```powershell
docker load -i festo-connector-images.tar
docker compose up -d --wait
```

## 开发者重新打包

在已启动 Docker 且可联网的开发机根目录执行：

```bash
bash deploy/build.sh linux/amd64
```
