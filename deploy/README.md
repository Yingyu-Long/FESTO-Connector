# 客户电脑部署

本部署包适用于 **Windows + Intel/AMD 64 位电脑**。应用和 PostgreSQL 都通过 Docker 运行，客户不需要另外安装 Node.js、npm 或 PostgreSQL。

**本次只复制数据库表结构，不包含开发电脑上的 PLC 配置、MQTT 配置或其他业务数据。** 客户首次启动后，在网页中填写自己的连接配置。

## 部署包内容

| 文件 | 用途 |
| --- | --- |
| `festo-connector-images.tar` | 离线镜像包，包含 `festo-connector:1.0.2` 和 `postgres:17-bookworm` |
| `festo-connector-images.tar.sha256` | 镜像包校验值，用于检查复制是否完整 |
| `compose.yaml` | 启动应用、数据库和持久化数据卷 |
| `.env.example` | 部署参数示例 |
| `.env` | 实际部署参数；构建脚本会在该文件不存在时生成密码 |
| `init/01-schema.sql` | 仅数据库表结构，首次启动时自动执行 |

镜像 `.tar` 用 `docker load` 导入，不需要解压。它不包含运行期间的数据卷；数据库的后续备份需要单独进行。[Docker 镜像导出说明](https://docs.docker.com/reference/cli/docker/image/save/)

## Windows 首次启动

1. 安装并启动 Docker Desktop，使用 **WSL 2 后端和 Linux containers**。先确认 PowerShell 中 `docker version`、`docker compose version` 能正常运行。Docker Desktop/WSL 2 的安装需提前完成；应用镜像导入后可以离线启动。[Windows 安装说明](https://docs.docker.com/desktop/setup/install/windows-install/)
2. 把完整的 `deploy` 文件夹复制到客户电脑，例如 `C:\FESTO\deploy`，保留 `init` 子文件夹。
3. 在 PowerShell 中进入该目录：

```powershell
cd C:\FESTO\deploy
```

如果目录中没有 `.env`，执行：

```powershell
Copy-Item .env.example .env
notepad .env
```

把 `POSTGRES_PASSWORD` 改为客户自己的随机密码并保存。如果已有构建脚本生成的 `.env`，直接使用或在**首次启动前**修改，不必覆盖。包含 `$` 等特殊字符的值请用单引号包围，例如 `POSTGRES_PASSWORD='your-password'`。

4. 导入镜像并启动：

```powershell
docker load -i festo-connector-images.tar
docker compose up -d --wait
docker compose ps
```

如果复制后怀疑文件不完整，可用 `Get-FileHash .\festo-connector-images.tar -Algorithm SHA256`，将结果与 `.sha256` 文件中的值比较（忽略大小写）。

Compose 使用本地镜像，设置了 `pull_policy: never`；离线环境下若提示找不到镜像，请先检查上一步 `docker load` 是否成功。

5. 按 `.env` 中的 `APP_PORT` 打开网页。本交付包当前设置为 `8081`，访问 **http://localhost:8081**；数据库检查地址为 **http://localhost:8081/api/health**，正常时返回 `{"ok":true,"database":true}`。如果使用 `.env.example` 的默认 `8080`，请相应使用端口 `8080`。

默认只允许客户本机访问网页。数据库没有对外开放端口，数据库名为 `festo_connector`，用户名为 `festo`。

## 配置 PLC 和 MQTT

MQTT broker 由客户提供，不包含在此部署包中。先在网页中设置 MQTT，再添加 PLC，测试连接并保存。

对于 **PLC → PC（本软件）→ Server（MQTT Broker）** 架构，MQTT Host 填写 Server 的实际 IP 或域名，Port 填写 Server 对外开放的 MQTT 端口。Broker 在 Server 的 Docker 中运行时，填写宿主机映射端口；PC 必须能够访问该端口。当前页面支持普通 MQTT TCP 和用户名/密码认证，TLS/客户端证书尚未实现。

**1.0.2 的 Modbus 数据块发布规则：** 每个 FB 首次读取后发送整组 11 个字段；之后仅当该 FB 的 `timestamp_DI_IPos_ON` 改变时，才再次发送整组数据。其他字段单独改变不会触发发送。PLC 仍按设置的轮询间隔读取，MQTT 发送失败后会重试。重启采集、切换读取模式、修改 MQTT 目标、FB 起始地址或 Topic 后会重新发送首次快照；相同配置的 Save/Rescan 不会重复发送。当前数据布局仍是每块 58 个寄存器，时间戳为 64 位 ULINT。

**本版包含的最新更改：**

- S7 支持手动填写 MQTT Topic，留空按 PLC ID 自动生成；保存、重连及配置导入导出均保留设置，仪表盘显示实际 Topic。
- S7 输出字段统一为 `cycle_counter`、`timestamp_DI_IPos_ON/OFF`、`timestamp_DI_EPos_ON/OFF`、`timestamp_DO_MCtrl12_ON/OFF` 和 `timestamp_DO_MCtrl14_ON/OFF`。
- Modbus 的 Read by Datablocks 输出为平铺 JSON：8 个数字时间戳、数字 `cycle_counter`、PLC 读取的字符串 `part_number`，以及写死的布尔值 `isThisAutomaticMode: true`。时间戳使用 PLC 原值，不转换单位；超过 JavaScript 安全整数上限 9007199254740991 时报告发布错误，避免丢失精度。
- Modbus 数据块支持字序选择、手动 Topic、Excel 模板导入导出以及 Test mode；开启 Test mode 后，每轮读取均发布整组 11 个字段。

| 连接目标 | 网页中应填写的主机地址 |
| --- | --- |
| 局域网中的 PLC 或 MQTT broker | 设备实际 IP 地址或可解析的主机名 |
| 客户这台 Windows 电脑上运行的 MQTT broker | `host.docker.internal` |

网页里填写的地址由应用容器访问，所以 `localhost` 或 `127.0.0.1` 指向应用容器自身。客户电脑必须能访问 PLC/MQTT 所在网络，宿主机 broker 也需允许来自 Docker 的连接。

**当前应用在容器或电脑重启后，需要打开网页点击 Rescan，才会恢复 PLC 采集和 MQTT 发布。** 数据库中的连接配置会保留。

当前后端支持 Siemens S7、Modbus TCP，以及匿名、`NONE_MODE` 的 OPC UA。Beckhoff 和 Rockwell 的实际连接尚未实现。

## 日常使用与数据保存

以下命令都在 `deploy` 目录的 PowerShell 中执行：

```powershell
# 查看日志
docker compose logs --tail=100

# 停止应用和数据库，保留数据
docker compose stop

# 再次启动
docker compose up -d --wait
```

重新启动后，在网页中点击 **Rescan**。Docker Desktop 未运行时，应用也无法运行。

客户保存的配置写入 PostgreSQL 数据卷。普通 `docker compose down` 会保留数据，**不要使用 `docker compose down -v`，它会删除数据库数据卷**。

初始化 SQL 只在数据库数据卷为空时执行。之后替换 `init/01-schema.sql` 或修改 `.env` 中的数据库密码，不会自动修改现有数据库。[PostgreSQL 镜像初始化说明](https://hub.docker.com/_/postgres)

## 后续备份客户配置

以下操作是客户使用后的备份，**本次交付包没有预装任何配置数据**。备份中可能包含客户填写的 MQTT 密码，应妥善保存。

```powershell
docker compose exec -T db pg_dump -U festo -d festo_connector --format=custom --no-owner --no-privileges --table=public.connector_configurations --file=/tmp/festo-connector.dump
docker compose cp db:/tmp/festo-connector.dump ./festo-connector-backup.dump
```

需要恢复到另一个刚部署、尚未保存任何配置的实例时，先把备份复制到新实例的 `deploy` 目录，再执行：

```powershell
docker compose stop app
docker compose cp ./festo-connector-backup.dump db:/tmp/festo-connector-restore.dump
docker compose exec -T db pg_restore -U festo -d festo_connector --data-only --no-owner --no-privileges --single-transaction --exit-on-error /tmp/festo-connector-restore.dump
docker compose start app
```

这些恢复命令要求目标配置表为空；已有客户配置时先备份，再安排覆盖恢复。恢复后刷新网页并点击 **Rescan**。

## 已有部署升级

已有客户部署升级到 1.0.2 时，保留客户原有的 `.env` 和 Docker 数据卷，替换镜像包及 `compose.yaml` 等交付文件。在客户 `deploy` 目录中执行：

```powershell
docker load -i festo-connector-images.tar
docker compose up -d --wait
```

随后打开网页点击 **Rescan**。复制文件本身不会更新正在运行的容器；需要执行上面的导入和启动命令。不要用交付包中的 `.env` 覆盖已有客户密码和端口配置。

## 开发者重新构建交付包

在可联网、已启动 Docker 的开发电脑上，从项目根目录执行：

```bash
bash deploy/build.sh
```

脚本默认构建 `linux/amd64`，适用于客户的 Windows Intel/AMD 电脑。也可以显式传入平台：

```bash
bash deploy/build.sh linux/amd64
```

脚本构建应用镜像、准备 PostgreSQL 镜像并生成 `deploy/festo-connector-images.tar`，在缺少 `deploy/.env` 时生成部署密码。交付前核对上方文件清单，并保留目录结构。

数据库“格式”使用 SQL 表结构文件表示。当前 `init/01-schema.sql` 根据项目中的表定义编写，只创建 `public.connector_configurations` 表及主键；客户启动后表中没有记录。若今后需要从运行中的源数据库重新导出该表结构，可用源数据库的连接参数执行：

```bash
pg_dump --host=127.0.0.1 --port=5432 --username=postgres --dbname=source_database \
  --schema-only --no-owner --no-privileges \
  --table=public.connector_configurations \
  --file=deploy/init/01-schema.sql
```

将 `source_database`、用户名、地址及端口替换为源数据库的实际值；密码在提示时输入。`--schema-only` 只导出表和约束，不导出表中的记录。请使用与源数据库兼容的 `pg_dump`，并在交付前验证 SQL 能在包内 PostgreSQL 版本上执行。[pg_dump 官方说明](https://www.postgresql.org/docs/current/app-pgdump.html)
