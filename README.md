<div align="center">
  <a href="https://nonebot.dev/store/plugins">
    <img src="https://raw.githubusercontent.com/fllesser/nonebot-plugin-template/refs/heads/resource/.docs/NoneBotPlugin.svg" width="310" alt="NoneBot Plugin">
  </a>

# Mimo Console

随 NoneBot2 运行的 WebUI 管理面板。

[![PyPI](https://img.shields.io/pypi/v/nonebot-plugin-mimo-console.svg)](https://pypi.org/project/nonebot-plugin-mimo-console/)
[![Python](https://img.shields.io/badge/Python-3.10%20--%203.14-3776ab?logo=python&logoColor=white)](https://www.python.org/)
[![CI](https://github.com/MimoKit/nonebot-plugin-mimo-console/actions/workflows/ci.yml/badge.svg)](https://github.com/MimoKit/nonebot-plugin-mimo-console/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/License-GPLv3-6b7280.svg)](./LICENSE)

</div>

## 能做什么

- 查看 CPU、内存、磁盘、网络、进程占用和运行时间。
- 查看当前连接的 Bot、适配器和已加载插件。
- 按插件、适配器、机器人账号、用户和群设置响应黑白名单，并预览权限结果。
- 搜索 NoneBot 官方插件商店，安装、更新或卸载插件。
- 在网页中修改 dotenv 配置，敏感字段自动脱敏，保存前自动备份。
- 搜索和筛选当前进程日志。
- 自定义 WebUI 背景图，支持远程链接或本地上传。
- 检测 GitHub 最新版本并一键更新，概览页支持重启 NoneBot。
- 使用初始化令牌创建管理员，后续通过账号密码登录。

前端资源随插件一起安装，不依赖单独的 Web 服务，也不绑定任何消息适配器。

## 安装

使用 NB-CLI：

```bash
nb plugin install nonebot-plugin-mimo-console
```

或使用 uv / pip：

```bash
uv add nonebot-plugin-mimo-console
# pip install nonebot-plugin-mimo-console
```

使用 uv 或 pip 安装后，请确认 NoneBot 项目的 `pyproject.toml` 已加载插件：

```toml
[tool.nonebot]
plugins = ["nonebot_plugin_mimo_console"]
```

项目需要启用 FastAPI 驱动：

```dotenv
DRIVER=~fastapi
```

启动 NoneBot 后，日志会显示 WebUI 地址和首次初始化令牌。默认地址：

```text
http://127.0.0.1:8080/mimo-console/
```

第一次打开时输入日志中的令牌并创建管理员；完成初始化后只需使用管理员账号登录。

## 更新插件

在「插件」页面点击卡片上的「更新插件」，或打开详情后点击更新按钮。
普通安装包通过当前项目的 uv / pip 更新，无需在官方商店中查找；通过面板安装并记录的 GitHub
源码插件沿用其原仓库更新。更新过程中显示执行状态，失败会提示原因，成功后会提示是否需要重启。
本地运行模式需要重启 NoneBot 才会加载新代码；Docker Agent 模式继续使用构建、健康检查和回滚流程。

详情显示当前安装版本。位于项目内独立 Git 工作树中的插件（包括 `plugins/` 下的克隆及可编辑安装）
会显示「更新 Git 插件」及当前分支、提交。控制台从当前分支配置的上游获取更新，只做快进合并，
不会切换分支、强制重置或自动暂存。工作区含未提交/未跟踪文件、未配置上游、分支分叉或
处于 detached HEAD 时会拒绝更新并提示处理方法。已是最新提交时会直接提示，不要求重启。
更新代码后若上游新增了依赖，请先同步依赖再重启。宿主项目自身的仓库不会被当作插件仓库更新，
Docker Agent 中的本地 Git 挂载需要在宿主机更新并重新构建容器。

没有 `.git` 信息的本地源码仍需手动更新；内置插件随 NoneBot 框架更新，
Mimo Console 自身的卡片和详情也提供「更新控制台」，与概览页「检测更新」共用专用自更新流程，
检查官方上游版本，确认后更新并重启。本地定制源码切换到上游安装时会在确认中说明。
更新不会改动面板设置的响应权限规则。

## 响应权限

侧栏的「响应权限」基于 [nonebot-plugin-access-control](https://github.com/bot-ssttkkl/nonebot-plugin-access-control)
保存和查询规则，依赖随控制台自动安装、加载。首次加入权限插件后，按照 ORM 启动提示完成数据库迁移，
或在 NoneBot 项目目录运行 `nb orm upgrade`。已有数据库请保留原有迁移流程；不需要开启
`ACCESS_CONTROL_AUTO_PATCH_ENABLED`，控制台自带消息响应拦截。

每条规则选择插件（或全部插件）、适配器、机器人账号（留空为该适配器的全部账号）、
对象范围和允许/禁止策略。对象支持所有人、所有私聊、指定用户、指定群、指定群内用户。
在线机器人账号自动提供建议，也可手动填写离线账号。用户和群 ID 按字符串保存，支持长 ID。

例如只让机器人 `111` 的用户 `123` 使用 `echo`：

1. 选择 `echo`、`OneBot V11`、机器人 `111`、所有人、禁止，保存。
2. 选择同一插件、适配器和机器人，范围改为指定用户，填写 `123`、允许，保存。
3. 在权限预览中分别输入机器人 `111` 和其他机器人，确认隔离效果。

黑名单只需添加指定用户/群的禁止规则。点击「调整」后，更换对象并保存会修改原规则，
不会保留旧对象或新增记录；新对象已有其他规则时会提示冲突，保留双方原规则。
点击「清空表单」退出编辑后可添加新规则。新增时相同对象再次保存会覆盖原策略；删除规则恢复继承。
规则立即生效并存储在 access-control 的 ORM 数据库中，重启不会丢失。

优先级从高到低：指定机器人 > 全部机器人；每个机器人范围内，群内用户 > 用户 > 群或私聊 > 所有人。
对于同一个主体，指定插件规则优先于全部插件规则。沿用 access-control 的主体优先级与服务继承语义。
插件原有「整体禁用」始终优先，控制台和权限管理插件受保护，无法通过面板规则封禁自身。

面板只展示自己创建的规则，与已有 `/ac` 原生规则并存。预览检查面板规则和整体禁用；
允许通过预览后，仍须满足插件原有 Permission、Rule、原生 `/ac` 权限与限流。
未加载插件的规则会保留，在该插件重新加载后显示。群范围依赖 session 的群 ID 提取，
OneBot V11 使用 QQ 号和群号；QQ 官方接口使用平台提供的用户/群标识。频道暂不支持群范围规则。
定时任务、主动推送和绕过 Matcher 的调用不在自动拦截范围内，需插件自行鉴权。

## 配置

所有配置均可省略。

| 配置项 | 默认值 | 作用 |
| --- | --- | --- |
| `MIMO_CONSOLE_PATH` | `/mimo-console` | WebUI 挂载路径 |
| `MIMO_CONSOLE_PROJECT_ROOT` | 当前工作目录 | NoneBot 项目目录 |
| `MIMO_CONSOLE_SESSION_HOURS` | `72` | 登录有效时长，范围 1-720 小时 |
| `MIMO_CONSOLE_ENABLE_STORE` | `true` | 显示官方插件商店 |
| `MIMO_CONSOLE_ALLOW_PACKAGE_MANAGEMENT` | `true` | 允许安装、更新和卸载插件 |
| `MIMO_CONSOLE_STORE_CACHE_SECONDS` | `600` | 商店数据缓存时间 |
| `MIMO_CONSOLE_PACKAGE_TIMEOUT` | `300` | 插件操作超时时间（秒） |
| `MIMO_CONSOLE_DEPLOYMENT_MODE` | `auto` | 安装方式：`auto` 自动识别，也可强制为 `local` 或 `docker-agent` |
| `MIMO_CONSOLE_INSTANCE_ID` | `default` | Docker Agent 中配置的实例 ID |
| `MIMO_CONSOLE_AGENT_SOCKET` | `/run/mimo-agent/agent.sock` | Docker Agent Unix Socket |
| `MIMO_CONSOLE_AGENT_TOKEN_FILE` | `/run/secrets/mimo-agent-token` | 当前实例的 Agent 令牌文件 |
| `MIMO_CONSOLE_GITHUB_PROXY` | 空 | GitHub 加速前缀或镜像仓库地址，用于 README、版本检查和自更新 |

超级用户也可以发送 `mimo控制台` 或 `NoneBot控制台` 获取访问地址。

### 核心配置界面

核心配置按用途分组，可搜索中文名称、字段名和用途。常用字段提供日志级别下拉选择、
逐行 ID 编辑与 JSON 校验；其他字段保留通用编辑。新增配置可以从常用字段中选择。
修改会显示待保存数量，切换页面时保留草稿，也可以统一撤销。

页面标明当前编辑的 dotenv 文件，公共 `.env` 与系统环境变量不合并展示；
插件专属配置在对应插件详情中编辑。保存时自动备份，重启 NoneBot 后生效。
OneBot 连接区域提供反向 WebSocket 多账号接入说明和地址复制，地址根据当前网页生成。
客户端位于其他设备或反向代理后时，请核对并使用客户端实际可访问的 NoneBot 地址。

### 自定义站点标识

在「外观 → 站点标识」中设置 WebUI 标题和图标。标题用于浏览器标签、登录页和侧边栏，
最多 80 个字符；图标支持 PNG、JPG、WebP、GIF、ICO，大小不超过 2MB，同时用于 favicon。
选择图片或编辑标题可实时预览，点击「保存站点标识」后立即应用，无需重启。
可以单独移除图标，也可以恢复默认标题与图标。

设置保存在 LocalStore 的 `branding.json` 和 `branding-icons/` 中；其他浏览器刷新后加载。
未登录访客可读取公开的站点标识，修改操作需要管理员登录。

## Docker 部署预览

默认会自动识别普通 Python、无 Agent 的 Docker 容器和 Docker + Mimo Agent。
普通 Python 环境会直接维护当前项目；无 Agent 的 Docker 容器也可操作，但变更
只作用于当前容器，重建后可能丢失。Docker + Agent 模式不会在运行中的 NoneBot
容器里安装依赖，也不会把 Docker Socket
暴露给插件。宿主机上的受限 Agent 会更新项目锁文件、构建并验证新镜像、替换
指定 Compose 服务，并在健康检查失败时自动回滚。WebUI 的配置编辑也由 Agent
持久化到宿主机项目的指定 dotenv 文件，容器重建后不会丢失。

第一版支持 Linux Docker Engine、Docker Compose 2.24.4+ 和带 `uv.lock` 的
标准 NoneBot 项目。完整安装和多实例配置见
[`agent/README.md`](https://github.com/MimoKit/nonebot-plugin-mimo-console/blob/master/agent/README.md)，
设计与安全边界见
[`docs/docker-deployment.md`](https://github.com/MimoKit/nonebot-plugin-mimo-console/blob/master/docs/docker-deployment.md)。

## 版本更新与重启

- 概览页显示当前版本，并与 GitHub 最新 release 比对，有新版时可一键通过 `nb plugin update` 自更新（结果缓存约 30 分钟）。
- 更新与修改配置一样，需要重启 NoneBot 才能生效。
- 概览页的「重启」按钮会发送 `SIGINT` 让进程优雅退出，**需要 NoneBot 进程由外部进程管理器托管**（systemd / MCSManager autoRestart / pm2 / Docker `restart=always` 等）才会自动重新拉起；未托管时进程会停止。

## 数据与安全

- Mimo Console 具有修改 dotenv、管理 Python 包、查看日志、禁用插件响应器和触发进程重启等高权限能力，其权限等同于运行 NoneBot 的系统用户。
- 不建议将 WebUI 直接暴露到公网；确需公网访问时，应在反向代理层启用 HTTPS、来源限制或额外认证。
- 不需要在线安装、更新和卸载插件时，建议设置 `MIMO_CONSOLE_ALLOW_PACKAGE_MANAGEMENT=false`。
- 管理员数据由 `nonebot-plugin-localstore` 保存，不会写进插件安装目录。
- Token、Secret、Password、Cookie、API Key 等配置值默认脱敏。
- 配置修改会生成备份，重启 NoneBot 后生效；修改项目配置和依赖前仍建议自行备份。
- 自定义背景图保存在 localstore 数据目录，上传文件名随机化；远程 URL 会由服务端下载为本地文件，并限制为公网 80/443 地址、受支持的图片格式和 5MB 以内。
- “禁用插件”只会阻止对应插件的 Matcher 继续响应事件，不会停止其已注册的后台任务；Mimo Console 自身不可被禁用。

## 本地开发

```bash
uv sync --all-groups
uv run poe test
uv run ruff check .
uv build
```

前端配置转换逻辑使用 Node.js 内置测试运行器检查，无需安装 npm 依赖：

```bash
node --test tests/config-fields.test.cjs
```

项目使用 GPL-3.0 协议。

## Star History

<a href="https://www.star-history.com/?repos=MimoKit%2Fnonebot-plugin-mimo-console&type=date&legend=top-left">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=MimoKit/nonebot-plugin-mimo-console&type=date&theme=dark&legend=top-left">
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=MimoKit/nonebot-plugin-mimo-console&type=date&legend=top-left">
    <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=MimoKit/nonebot-plugin-mimo-console&type=date&legend=top-left">
  </picture>
</a>

## 致谢

感谢所有参与 Mimo Console 开发、测试与改进的贡献者：

- [MimoKit](https://github.com/MimoKit)
- [M / yiwuerxin](https://github.com/yiwuerxin)
- [spaxie](https://github.com/spaxie)
- [syuan326](https://github.com/syuan326)
- [gufei233](https://github.com/gufei233)
