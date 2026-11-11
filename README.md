# DSH Qwen Mode / DSH Qwen 模式

[中文](#中文) · [English](#english)

---

## 中文

在 DSH 中使用 Qwen：连接本机 GenieX，或连接阿里云百炼 QwenCloud。Qwen 模式会自动发现并维护可用模型，把思考模式、采样、预热和每轮统计集中到设置页与对话界面。

### 功能

- 自动维护 **From GenieX** / **From QwenCloud** 模型列表，来源变化后自动更新。
- 自动识别模型的上下文、输出上限、图片输入、思考与 MTP 能力。
- 思考模式：按模型支持的等级选择；QwenCloud 只发送模型支持的等级，GenieX 只在模型支持时开启思考。
- 每轮显示模型名、首字延迟、解码速度与耗时；包含工具调用的轮次显示本轮平均值。
- 可选预热：开始输入消息后，将选中的 From GenieX 模型预加载到内存，模型列表用圆点显示加载状态。
- 采样参数可手动填写，也可读取模型推荐值，并支持指定随机种子。
- 可选 MTP 加速，仅适用于支持的 From GenieX 本地模型。
- 破限 / 无审查模型名称高亮。
- 可选「仅回复」：隐藏并拒绝工具调用，只进行纯文本对话。

### 系统要求

- DSH 支持插件安装。
- 使用 GenieX 时，本机需要已安装并运行 GenieX，且模型已下载。
- 使用 QwenCloud 时，需要可用的阿里云百炼兼容端点与 API Key。

### 安装

1. 在 DSH 中执行 `dsh plugin --profile <profile> add github:Fuxfantx/dsh-qwen-mode`，或通过 DSH 的插件管理安装离线 zip 或插件目录。
2. 刷新 DSH 页面。
3. 打开 **设置 → Qwen 模式**。

### 使用

1. 选择 **关闭** 或 **自动**。只有自动模式会维护模型列表。
2. 选择来源并填写地址：
   - **GenieX**：填写本机地址，默认为 `http://127.0.0.1:18181`。
   - **QwenCloud**：填写完整的兼容端点，例如 `https://{WorkspaceId}.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1`。
3. 使用 QwenCloud 时，填写保存 API Key 的环境变量名（不是 Key 本身）。GenieX 不需要 Key。
4. 按需调整上下文、最大输出、思考、采样、预热、MTP 与推理后端。
5. 点击 **保存并应用**。
6. 在模型选择器中选择 **From GenieX** 或 **From QwenCloud** 下的模型。

### 设置说明

- **上下文窗口**：留空表示暂不指定；勾选「优先使用模型上下文阈限」会忽略手动值。
- **最大输出**：默认 16384，不会超过上下文窗口或模型自身的上限。
- **压缩提示**：设置页会提示当前上下文是否足够，以及压缩是否可用。
- **采样参数**：只补充请求中缺失的字段；留空表示不注入。部分参数仅对 GenieX 生效；可使用「读取推荐值」填入模型推荐参数；可指定随机种子。
- **预热**：启用后，开始输入消息时会将选中的 From GenieX 模型预加载到内存。圆点状态：黄色加载中、绿色已加载、红色未加载、蓝色其它来源。
- **MTP**：仅适用于支持的 From GenieX 本地模型。启用后发送图片时，会要求选择「直接发送」或「本次关闭 MTP」。
- **推理后端**：Compute 与 Vision Encoder 可留空，由 GenieX 决定；Vision Encoder 仅对图片模型生效。

### 限制

- 预热只减少模型加载时间，不减少长提示词的处理时间。
- GenieX 同一时间只加载一个模型；不同会话使用不同模型时会互相卸载。
- MTP 与图片不能同时生效，发送前需要选择。
- 模型列表由模型来源提供；来源不可达时不会出现模型，插件会在后台重试。
- 预热、MTP 与推理后端仅适用于 From GenieX；QwenCloud 保留模型管理、思考、采样、每轮统计与仅回复。


---

## English

Use Qwen in DSH: connect to models running on a local GenieX server, or to QwenCloud on Alibaba Cloud Model Studio. Qwen Mode discovers and maintains the available models automatically, and brings thinking mode, sampling, warmup, and per-turn statistics into the settings page and chat UI.

### Features

- Maintains the **From GenieX** / **From QwenCloud** model lists automatically and refreshes them when a source changes.
- Recognizes each model's context, output limit, image input, thinking, and MTP support.
- Thinking mode: choose a level the model supports. QwenCloud receives only supported levels, and GenieX enables thinking only on models that support it.
- Shows the model name, first-response delay, decode speed, and elapsed time per turn; turns that use tools show a turn average.
- Optional warmup: once you start typing, preload the selected From GenieX model ahead of time, with loading-status dots in the model list.
- Sampling parameters can be entered manually or read from the model's recommended values, including a random seed.
- Optional MTP acceleration for supported local From GenieX models.
- Highlights abliterated / uncensored model names.
- Optional **Reply Only**: hides and denies tool calls, keeping replies plain text.

### System requirements

- DSH with plugin installation support.
- For GenieX: GenieX installed and running locally, with the models already downloaded.
- For QwenCloud: a working Alibaba Cloud Model Studio compatible endpoint and an API key.

### Install

1. Run `dsh plugin --profile <profile> add github:Fuxfantx/dsh-qwen-mode` in DSH, or install the offline zip or plugin directory through DSH plugin management.
2. Refresh the DSH page.
3. Open **Settings → Qwen Mode**.

### Usage

1. Choose **Off** or **Auto**. Only Auto maintains the model lists.
2. Choose a source and enter its address:
   - **GenieX**: enter the local address, `http://127.0.0.1:18181` by default.
   - **QwenCloud**: enter the full compatible endpoint, for example `https://{WorkspaceId}.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1`.
3. With QwenCloud, enter the environment variable that stores the API key (not the key itself). GenieX needs no key.
4. Adjust context, output limit, thinking, sampling, warmup, MTP, and inference backend as needed.
5. Click **Save and apply**.
6. Select a model under **From GenieX** or **From QwenCloud** in the model picker.

### Settings and behavior

- **Context window**: empty means not specified; **Prefer model context limit** ignores a manual value.
- **Max output**: defaults to 16384 and never exceeds the context window or the model's own limit.
- **Compaction hints**: the settings page indicates whether the current context is sufficient and whether compaction is available.
- **Sampling parameters**: only fields missing from the request are filled; empty means not injected. Some parameters apply to GenieX only; **Read recommended** fills the model's values; a random seed can be set.
- **Warmup**: when enabled, start typing to preload the selected From GenieX model. Dots: yellow loading, green loaded, red not loaded, blue another source.
- **MTP**: for supported local From GenieX models only. While enabled, sending an image asks whether to send directly or disable MTP for that send.
- **Inference backend**: empty Compute and Vision Encoder values are decided by GenieX; Vision Encoder applies to image models only.

### Limitations

- Warmup reduces model load time, not time spent processing a long prompt.
- GenieX keeps one model loaded at a time; using different models in different sessions unloads the previous one.
- MTP and images cannot be active together; the send flow asks first.
- The model lists come from the model source. When the source is unreachable no models appear, and the plugin retries in the background.
- Warmup, MTP, and inference backends are From GenieX-only; QwenCloud keeps model management, thinking, sampling, per-turn statistics, and Reply Only.

---

## License / 许可证

MIT-0. See [LICENSE](LICENSE).
