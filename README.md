# AGY ACP for DSH

独立的 Antigravity ACP 插件，支持 DSH 0.2.2-rc.3 和 Node.js 22 及以上。

提供官方 `agy acp` 模型接入、模型发现、原生会话恢复、工具调用与消息展示、权限请求、MCP 桥接、上下文用量和原生压缩。构建及运行不依赖原来的 dsh-extensions 仓库。

## 安装

在 DSH 的「自定义插件索引」添加：

```text
https://raw.githubusercontent.com/yu1745/dsh-session-tools/main/market/index.json
```

进入「插件 → 发现」，选择 **AGY ACP** 并安装。索引使用固定 Git 提交，仓库包含构建好的 `lib/`，无需安装时执行构建脚本，也无需 npm 发布。启用后刷新 Web 页面；如 DSH 提示需要重启，重启服务后再使用。

从旧版迁移时，请先移除旧包里的 `yu-google-acp` 注册和 ACP 客户端安装调用，避免重复注册。现有 `google-acp` provider、`yu-google-acp` entry、`yuGoogleAcp` 服务及会话记录标识保持兼容。

## 外部 CLI 与登录

从 Antigravity 官方渠道安装支持 `agy acp` 的 CLI，并按官方流程登录。运行 DSH 的用户及进程环境需要能在 PATH 中找到 `agy`；也可以在插件配置里指定命令绝对路径。本插件不安装 CLI、不代为登录、不包含账号凭据。

模型和账号能力由官方代理决定。默认 `credentialStore: auto` 沿用官方凭据选择；Linux 上需要文件凭据时可显式设为 `file`。更改凭据模式后新建会话。模型缓存只检查官方凭据文件的元数据，不读取令牌正文。

## 配置

默认配置：

```yaml
- id: yu-google-acp
  config:
    command: agy
    args: [acp]
    credentialStore: auto
    mcpTools: []
    requestTimeoutMs: 1800000
```

`mcpTools` 是允许官方代理调用的 DSH 工具列表，默认不开放工具。需要时填写宿主已提供的工具名，例如 `[web_reader]`。MCP 只监听回环地址，使用随机令牌认证，并通过 DSH 工具执行器处理权限与审批。

ACP 模型由官方代理维护历史。要启用原生 `/compact` 并避免宿主自动摘要，请在实际使用的 Agent 预设压缩作用域中将 `compaction-basic` 指向 `@yu1745/dsh-agy-acp/google-acp-compaction`，将 `command-compact` 指向 `@yu1745/dsh-agy-acp/google-acp-compact`。

官方代理及其本机工具独立执行任务。只有代理发回的权限请求才映射到 DSH 审批，原生操作不经过 DSH 的工具执行器；CLI 子进程继承启动 DSH 时的环境。会话记录包含原生工具参数、输出、路径和文件差异，导出或分享前请检查内容。

## 开发与验证

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm run build
pnpm test
git diff --exit-code -- lib
```

使用 pnpm 11.5.1、Node.js 22、esbuild 0.28.2 和 React 18.3.1。没有 install、postinstall 或 prepare 生命周期脚本。提交源码和构建产物；MCP stdio 辅助文件随构建复制到产物目录。

测试使用本地模拟 ACP 代理，覆盖流式消息、原生工具展示、审批、取消、恢复、模型目录、凭据切换、MCP、图片、用量和记录回放。真实账号与官方服务可用性取决于部署环境。

## 许可证

MIT。作者与来源见 LICENSE 和 NOTICE.md。
