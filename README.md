# ddevin

把自定义模型供应商接入 Devin Desktop 的原生模型列表。

> **当前最新支持：Devin 3.11.216**（Windows 11）

## 功能

- 支持 OpenAI Chat Completions、OpenAI Responses、Anthropic Messages 三种 API 格式；请求体、流式响应、工具调用、推理内容和图片会自动转换。
- 在控制面板中拉取或手动添加模型，模型会出现在 Devin 的 `ddevin` 分组。
- 支持三种模型列表模式：只显示官方模型、只显示 BYOK 模型、两者共存。
- 支持 Fusion 预设：用一个模型作为 Lead，另一个模型作为 Sidekick，也可以组合官方模型。
- 支持推理档位（Effort）、请求重试、日志和请求统计。
- 不修改 Devin 应用文件；停用或卸载时可以恢复被改写的连接配置。

## 环境

- 当前验证版本：Devin 3.11.216（Windows 11）。
- 面向 Devin 3.11.x；更早或更新的版本可能缺少对应设置项，行为也可能不同。
- Devin 更新比较频繁。升级后如果模型列表异常，先重新加载窗口，或在控制面板里把 **启用** 关掉再打开。

## 安装

1. 打开 [Releases](https://github.com/ucyuunaka/ddevin/releases/latest)，下载最新 `ddevin-<version>.vsix`。
2. 在 Devin 中打开命令面板，运行 **Extensions: Install from VSIX...**。
3. 选择刚下载的 VSIX，安装完成后重新加载窗口。
4. 左侧活动栏会出现 **ddevin** 图标；也可以运行命令 **ddevin：控制面板**。

## 第一次使用

1. 打开控制面板，确认顶部 **启用** 开关已打开。
2. 在 **模型** 页添加供应商，填写名称、API 地址、接口格式和 API Key。
3. 点击 **获取模型**，选择需要导入的模型；也可以手动添加模型名。
4. 新建一个对话，在 Devin 的模型列表中选择 `ddevin` 分组下的模型。

常见 API 地址写法：

| 接口格式 | 地址示例 |
| --- | --- |
| OpenAI Chat | `https://api.openai.com/v1` |
| OpenAI Responses | `https://api.openai.com/v1` |
| Anthropic | `https://api.anthropic.com/v1` |


ddevin 在保存供应商时会整理地址，因此两种写法都能用：

1. 去掉结尾的 `/chat/completions`、`/responses` 或 `/messages`。
2. 路径里没有 `v1`、`v2` 这类版本段时，自动补一个 `/v1`。
3. 发请求时再按上表拼接具体端点。

总之：填 API 根地址即可，不要填 `/chat/completions`、`/responses`、`/messages` 这些具体端点。

## 模型列表模式

在 **设置** 页切换：

- **只显示官方**：不显示 ddevin 的模型。
- **只显示 BYOK**：只显示自定义供应商的模型。
- **共存**：官方模型和自定义模型同时显示。

如果切换后列表没有立即变化，可以新建对话，或在reload windows窗口。

## Fusion 预设

在 **Fusion 预设** 页创建组合：

1. 选择一个 Lead 模型。
2. 选择一个 Sidekick 模型。
3. 保存后，组合会出现在 Devin 模型列表的 `ddevin Fusion` 分组。

Lead 和 Sidekick 可以分别来自自定义供应商或可用的官方模型。

## 推理档位

支持推理档位的模型会按模型家族聚合，Devin 的模型列表会显示 Effort 下拉框。可以在 **模型** 页为每个模型设置三项：

- **档位来源**：自动 = 按模型 ID 识别；手动 = 只使用「可选」里填的档位；不指定 = 永远不发送推理参数。
- **可选档位**：Devin 的 Effort 下拉里出现的选项，例如 `default,none,low,high`。`default` 表示使用供应商默认值，不额外传参数。
- **默认档位**：从「可选档位」里挑一个，模型组第一次被选中时使用；留空则交给 Devin 自动选择。

不同供应商支持的档位名称不同；如果请求报错，请改成供应商支持的档位。

## 缓存保温（实验性，不稳定，建议暂不启用）

这一功能还在验证阶段，**目前建议保持关闭，先不要启用**。

缓存保温默认关闭。开启后，ddevin 会在缓存临近过期时重放最近一次真实请求，并把输出上限压到很小（默认 4 token），以维持上游缓存；重放结果不会进入对话，也不会插入任何消息。

需要知道的代价和风险：

- 每次保温都是一次真实请求，会产生额外费用，供应商通常按缓存读取计价。
- BYOK 模型的保温相对可控，但仍取决于供应商的缓存策略和有效期设置。
- 官方模型的保温实验性更强，官方侧可能按条计费，行为也不完全可预期。确实要尝试时，请先到 **日志** 页确认官方请求的计费列。
- 功能和参数可能随 Devin 版本调整，暂不保证稳定。



## 日志与统计

- 命令 **ddevin：状态日志** 打开插件日志。
- **日志** 页提供最近请求、错误、首字延迟、token、缓存命中和重试统计。
- 运行时日志保存在本机 `~/.ddevin/runtime.log`，不会把 API Key 写入日志。

## 密钥、网络与隐私

- API Key 保存在本机 `~/.ddevin/config.json`，不会上传到项目方。
- 配置文件权限在本机支持的情况下设为 `0600`。这仍然意味着同一台电脑上的其他程序可能读取它，请自行保护好本机账号。
- 插件在本机启动一个监听 `127.0.0.1:39927` 的代理，用于连接 Devin 和你配置的供应商。
- 自定义供应商的请求会直接发送到你填写的 API 地址；官方模型请求仍会发往 Devin 官方服务。
- 使用 `http://` 地址时，API Key 会以明文经过网络，只建议用于本机或可信内网。
- ddevin 不收集遥测，也不会把你的配置或日志上传到项目方。

## 停用与卸载

推荐用下面任意一种方式停用，两者效果相同：

- 在控制面板顶部把 **启用** 开关关掉。
- 运行命令 **ddevin：停用并恢复官方连接**。

停用后会关闭本地代理，并把之前改写过的 `devin.acp.agentEnv`、`devin.acp.agentPreferences` 恢复原样，提示"ddevin 已停用，原生连接已恢复"。之后重新打开 **启用** 开关即可再次接入。

如果直接从扩展管理页禁用扩展，可能残留指向本地代理的 `agentEnv` 配置。遇到这种情况，可以重新启用扩展再执行停用命令，或手动删除 `devin.acp.agentEnv` 中 `devin-cli` 的 `WINDSURF_API_SERVER_URL`。

卸载扩展时，VSIX 自带的卸载钩子会尝试恢复配置并关闭本地后端。

## 从源码构建

公开源码包含可重新打包所需的运行代码和打包脚本。需要 Node.js 24.5+：

```bash
npm run package
```

## 许可证

本项目使用 [MIT License](LICENSE)。

特别感谢🙏

实现过程中学习参考了 [CCursor](https://github.com/CometixSpace/CCursor)、[devin-byok-plus](https://github.com/jornlin/devin-byok-plus) 和 [devin-fusion-byok](https://github.com/kuobibulaien/devin-fusion-byok) 的思路。
