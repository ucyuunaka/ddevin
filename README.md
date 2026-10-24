# ddevin

把自定义模型供应商接入 Devin 的原生模型列表。

> ddevin 是非官方项目，与 Devin、Cognition、Codeium 没有隶属或授权关系。使用前请自行确认相关服务条款。

## 功能

- 支持 OpenAI Chat Completions、OpenAI Responses、Anthropic Messages 三种 API 格式。
- 在控制面板中拉取或手动添加模型，模型会出现在 Devin 的 `ddevin` 分组。
- 支持三种模型列表模式：只显示官方模型、只显示自定义模型、两者共存。
- 支持 Fusion 预设：用一个模型作为 Lead，另一个模型作为 Sidekick，也可以组合官方模型。
- 支持推理档位（Effort）、请求重试、日志和请求统计。
- 可选的缓存保温：在缓存过期前重放最近一次请求，以较低成本维持上游 prompt cache。
- 不修改 Devin 应用文件；停用或卸载时可以恢复被改写的连接配置。

## 环境

- 主要面向 Devin 3.11，当前开发和验证环境为 Windows + Devin 3.11.216。
- 不同 Devin 版本或供应商网关的行为可能不同；升级 Devin 后如果模型列表异常，请先重新加载窗口或重新启用插件。
- 安装包是 VSIX，不需要单独安装 Node.js。

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

如果使用第三方网关，请以其文档给出的 API 根地址为准。地址通常需要包含 `/v1`，但不要包含 `/chat/completions`、`/responses` 或 `/messages` 这些具体端点。

## 模型列表模式

在 **设置** 页切换：

- **只显示官方**：不显示 ddevin 的模型。
- **只显示 BYOK**：只显示自定义供应商的模型。
- **共存**：官方模型和自定义模型同时显示。

如果切换后列表没有立即变化，可以新建对话，或在控制面板中重新启用插件。

## Fusion 预设

在 **Fusion 预设** 页创建组合：

1. 选择一个 Lead 模型。
2. 选择一个 Sidekick 模型。
3. 保存后，组合会出现在 Devin 模型列表的 `ddevin Fusion` 分组。

Lead 和 Sidekick 可以分别来自自定义供应商或官方模型。具体可用性取决于当前账号和供应商。

## 推理档位

支持推理档位的模型会按模型家族聚合，Devin 的模型列表会显示 Effort 下拉框。可以在 **模型** 页为每个模型设置：

- 档位来源：自动识别、手动填写或不指定。
- 可选档位：例如 `default,none,low,high`。
- 默认档位：模型组第一次选中时使用的档位。

不同供应商支持的档位名称不同；如果请求报错，请改成供应商支持的档位。

## 缓存保温

缓存保温默认关闭。开启后，ddevin 会在缓存临近过期时重放最近一次真实请求，并把输出上限压到很小，以维持上游缓存；重放结果不会进入对话。

这项功能会产生额外的模型请求和费用，也可能受供应商的缓存策略影响。建议先了解供应商的计费方式再开启。官方模型的缓存保温属于实验性功能，默认关闭。

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

优先使用命令 **ddevin：停用并恢复官方连接**。它会关闭本地代理并恢复之前的连接设置。

如果直接从扩展管理页禁用扩展，可能残留指向本地代理的 `agentEnv` 配置。遇到这种情况，可以重新启用扩展再执行停用命令，或手动删除 `devin.acp.agentEnv` 中 `devin-cli` 的 `WINDSURF_API_SERVER_URL`。

卸载扩展时，VSIX 自带的卸载钩子会尝试恢复配置并关闭本地后端。

## 常见问题

### 模型列表没有出现

1. 确认顶部 **启用** 开关已打开。
2. 确认供应商已保存，并且至少导入了一个模型。
3. 新建对话，让 Devin 重新读取模型列表。
4. 查看 **日志** 页是否有请求错误。
5. 重新加载窗口后再试一次。

### 请求返回 401 或 403

通常是 API Key、接口格式或 API 地址不匹配。确认供应商使用的是 Chat Completions、Responses 还是 Anthropic Messages，并检查地址是否包含了多余的端点路径。

### 修改系统代理后连接异常

后端在启动时读取代理设置。修改系统代理后，重启 Devin 再试。

## 从源码构建

公开源码包含可重新打包所需的运行代码和打包脚本。需要 Node.js 24.5+：

```bash
npm run package
```

生成的 `ddevin-<version>.vsix` 位于项目根目录。日常安装仍建议直接使用 Releases 中的构建产物。

## 许可证

本项目使用 [MIT License](LICENSE)。

实现过程中参考了 [CCursor](https://github.com/CometixSpace/CCursor)、[devin-byok-plus](https://github.com/jornlin/devin-byok-plus) 和 [devin-fusion-byok](https://github.com/kuobibulaien/devin-fusion-byok) 的思路。
