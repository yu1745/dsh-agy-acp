# Antigravity ACP 插件维护

## Session 类身份回归

`Receiver must be an instance of class Session` 已复发三次。DSH CLI 安装目录和 Web profile 可以同时加载版本相同的 `@deepseek-ai/dsh-session`，每份模块都有独立的 `Session` 类。`appendPluginRecord` 访问这个类的私有方法，写入函数必须与收到的 Session 实例来自同一份模块。

- 生产入口与 `/google-acp-reset` 都通过 [记录写入模块](src/google-acp-records.ts) 的 `appendAcpRecord` 写记录。保留该模块从 `@deepseek-ai/dsh-session` 的静态导入，由 DSH profile 加载器统一模块身份。构建时保持此依赖 external。
- 切勿为 `appendPluginRecord` 使用 `hostModule()`、`process.argv[1]`、`createRequire()` 或 CLI 安装目录的绝对文件路径。CLI 和 profile 中的包版本相同也不能保证类身份一致。`hostModule()` 只负责现有组合辅助模块的解析。
- 修改记录写入、插件加载或打包配置后，通过安装目标 profile 的加载器导入插件并触发实际写入，或者用该 profile 跑一轮 ACP 对话并检查记录。仅用源码仓库里同一份依赖跑单测无法覆盖 CLI 与 profile 并存的情况。
