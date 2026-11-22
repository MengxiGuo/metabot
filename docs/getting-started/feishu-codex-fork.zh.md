# 在自己的飞书里使用 MetaBot + Codex

在一台能保持在线的 macOS 或现代 Linux 电脑上运行 MetaBot，Linux 可以用 Debian 12。以下步骤按首次安装、一个飞书机器人编写。准备 Git、Node.js 22.22 或兼容版本、npm，以及可登录 Codex 的个人账号。单机安装，建议预留至少 2 GB 可写磁盘和 2 GB 可用内存。Debian 10 的系统运行库低于 SQLite 扩展预编译包要求，默认 GCC 8 也无法按依赖要求编译。飞书通过出站长连接接收消息，云服务器的 8100、9100 端口保持对公网关闭。

## 1. 创建自己的飞书应用

在飞书开放平台创建企业自建应用，添加「机器人」能力，在「凭证与基础信息」找到 App ID 和 App Secret。按接入指南配置消息和资源权限，先把应用可用范围设为自己。后面要用这台电脑上的 MetaBot 建立长连接。[飞书开发者后台](https://open.feishu.cn/app) · [权限配置步骤](https://github.com/MengxiGuo/metabot/blob/mengxi-fork-additions/docs/getting-started/feishu-app-setup.zh.md)

## 2. 安装源码并登录 Codex

在终端中执行。首次克隆使用空的安装路径。已经装好 Codex CLI 的用户可以跳过全局安装命令。

```bash
git clone https://github.com/MengxiGuo/metabot.git "$HOME/metabot" &&
  cd "$HOME/metabot" &&
  npm ci --include=dev
```

```bash
npm install -g @openai/codex && codex login && codex login status
```

## 3. 填写机器人配置

在终端执行以下命令。它会在安装目录创建仅自己可读写的配置，并用独立目录存放机器人操作的项目。按提示粘贴自己的飞书凭据，输入 Secret 时屏幕会隐藏字符。已有配置时命令会退出，以保留现有文件。

```bash
bash -c '
  set -eu
  cd "$HOME/metabot"
  umask 077
  mkdir -p "$HOME/metabot-workspace"
  read -rp "Feishu App ID: " app_id
  read -rsp "Feishu App Secret: " app_secret
  echo
  test -n "$app_id" && test -n "$app_secret" || exit 1
  api_secret=$(node --input-type=module -e "import {randomBytes} from \"node:crypto\"; console.log(randomBytes(32).toString(\"hex\"))")
  set -C
  {
    printf "FEISHU_APP_ID=%s\nFEISHU_APP_SECRET=%s\n" "$app_id" "$app_secret"
    printf "METABOT_ENGINE=codex\nCODEX_TRANSPORT=app-server\n"
    printf "CLAUDE_DEFAULT_WORKING_DIRECTORY=%s/metabot-workspace\n" "$HOME"
    printf "API_SECRET=%s\nWIKI_SYNC_ENABLED=false\n" "$api_secret"
  } > .env
'
```

## 4. 启动、发布并验证

```bash
cd "$HOME/metabot" && npm run dev
```

首次测试时保持这个终端打开。回到飞书应用的「事件与回调」，订阅方式选「使用长连接接收事件」，添加「接收消息」事件 `im.message.receive_v1`。创建版本并发布，如组织要求审批，等审批通过后再测试。

打开飞书，私聊自己的机器人发送 **只回复 PONG**。收到 **PONG** 即已验证飞书、MetaBot 和 Codex 的整条链路。群聊时先把机器人加入群，再 @它。

如果没有回复，在第二个终端运行以下命令。健康结果应包含 `"status": "ok"` 和 `"bots": 1`。若服务正常，检查飞书是否已发布、应用可用范围是否包含自己、事件是否订阅，以及同一系统用户的 `codex login status`。

```bash
METABOT_HOME="$HOME/metabot" "$HOME/metabot/bin/mb" health
```

需要关掉终端后继续使用时，先在前台运行窗口按 Ctrl+C，再交给 PM2 托管。电脑仍需保持开机且联网。

```bash
cd "$HOME/metabot" &&
  npm install -g pm2 &&
  pm2 start "$HOME/metabot/ecosystem.config.cjs" &&
  pm2 save
```
