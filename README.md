# DSH Qwen Mode / DSH Qwen 模式

[中文](#中文) · [English](#english)

---

## 中文

把 Qwen 接入 DSH：既可以连接本机 GenieX 上运行的模型，也可以连接阿里云百炼 QwenCloud。Qwen 模式会自动创建并维护 Provider，把模型、思考模式、采样、预热和每轮统计统一到 DSH 的设置页与对话界面。

### 功能

- 自动维护 **From GenieX** / **From QwenCloud** Provider，模型变化后自动更新。
- 自动识别模型能力：上下文长度、最大输出、图片输入、推理模型与 MTP。
- 思考模式：在 DSH 中选择思考等级；QwenCloud 按模型支持的等级发送，GenieX 只在模型支持时启用思考。
- 每轮显示模型名、首字延迟（TTFT）、解码速度与耗时。
- 可选模型预热：选中 GenieX 模型时提前加载权重，模型列表用圆点显示驻留状态。
- 采样默认值可手动填写，也可读取模型推荐的参数。
- 可选 MTP 投机解码，并在生效时显示接受率。
- 破限 / 无审查模型名称高亮。
- 可选「仅回复」权限：隐藏并拒绝工具调用，只进行纯文本对话。

### 系统要求

- DSH 需要支持 Cordis bundle 与 Plugin Manager。
- 使用 GenieX 时，本机需要已安装并运行 GenieX，且模型已下载。
- 使用 QwenCloud 时，需要可用的阿里云百炼兼容端点与 API Key。
- 本插件没有 npm 依赖。

### 安装

1. 在 DSH 的 Plugin Manager 中安装离线 zip 或插件目录。
2. 刷新 DSH 页面。
3. 打开 **Settings → Qwen Mode**。

### 使用

1. 选择 **关闭** 或 **自动**。只有自动模式会创建和维护 Provider。
2. 选择来源：
   - **GenieX**：填写本机地址，默认为 `http://127.0.0.1:18181`。
   - **QwenCloud**：填写完整的兼容端点，例如 `https://{WorkspaceId}.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1`。
3. 使用 QwenCloud 时，在「高级选项」中填写保存 API Key 的环境变量名或 DSH 凭据名（例如 `DASHSCOPE_API_KEY`）。GenieX 不校验 Key，可以留空。
4. 按需设置上下文、最大输出、思考、采样、预热、MTP 与推理后端。
5. 点击 **保存并应用**。
6. 在模型选择器中选择 **From GenieX** 或 **From QwenCloud** 下的模型。

### 设置说明

- **上下文窗口**：留空时使用模型自身声明的上下文；模型没有声明时使用默认值。勾选「优先使用模型上下文阈限」会忽略手动值。
- **最大输出**：默认 16384，不会超过上下文窗口，也不会超过模型声明的最大输出。
- **压缩提示**：设置页显示 DSH 压缩阈值与推荐 bigGate；上下文放不下压缩预留时会提示压缩不可用。
- **采样默认值**：只补充请求中缺失的字段；留空表示不注入。可使用「读取推荐值」填入模型推荐参数，之后仍需保存。
- **预热**：启用后，选择 From GenieX 模型会提前加载权重。圆点状态：黄色预热中、绿色已驻留、红色未驻留、蓝色其它来源。
- **MTP**：适用于自带 MTP 张量并放置了配套草稿文件的本地 GGUF 模型。启用后发送图片时，会要求选择「直接发送」或「本次关闭 MTP」。
- **推理后端**：Compute 与 Vision Encoder 留空时使用 GenieX 默认值；Vision Encoder 仅对图片模型生效。

### 限制

- 预热只减少模型加载时间，不减少长提示词的处理时间。
- GenieX 同一时间只驻留一个模型；不同会话使用不同模型时会互相卸载。
- MTP 与图片不能同时生效，发送前需要选择。
- 模型目录来自上游；上游不可达时不会创建模型，插件会在后台重试。
- 预热、MTP、GGUF 元数据与推理后端仅适用于 GenieX；QwenCloud 保留 Provider 管理、思考、采样、每轮统计与仅回复。


---

## English

Connect DSH to Qwen: use models running on a local GenieX server, or QwenCloud on Alibaba Cloud Model Studio. Qwen Mode maintains the provider automatically and brings models, thinking mode, sampling, warmup, and per-turn statistics into the DSH settings page and chat UI.

### Features

- Maintains the **From GenieX** / **From QwenCloud** provider automatically and refreshes it when the model catalog changes.
- Recognizes each model's context length, output limit, image input, reasoning support, and MTP support.
- Thinking mode: choose a thinking level in DSH; QwenCloud receives only the levels the model supports, and GenieX enables thinking only on models that support it.
- Shows the model name, time to first token (TTFT), decode speed, and elapsed time per turn.
- Optional model warmup: loads GenieX weights ahead of time when a model is selected, with residency dots in the model list.
- Sampling defaults can be entered manually or read from the model's recommended values.
- Optional MTP speculative decoding, with the acceptance rate shown while active.
- Highlights abliterated / uncensored model names.
- Optional **Reply Only** permission: hides and denies tool calls, keeping replies plain text.

### System requirements

- DSH with Cordis bundle and Plugin Manager support.
- For GenieX: GenieX installed and running locally, with the models already downloaded.
- For QwenCloud: a working Alibaba Cloud Model Studio compatible endpoint and API key.
- The package has no npm dependencies.

### Install

1. Install the offline zip or plugin directory through DSH Plugin Manager.
2. Refresh the DSH page.
3. Open **Settings → Qwen Mode**.

### Usage

1. Choose **Off** or **Auto**. Only Auto creates and maintains the provider.
2. Choose a source:
   - **GenieX**: enter the local address, `http://127.0.0.1:18181` by default.
   - **QwenCloud**: enter the full compatible endpoint, for example `https://{WorkspaceId}.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1`.
3. With QwenCloud, enter the environment variable or DSH credential name that stores the API key under **Advanced** (for example `DASHSCOPE_API_KEY`). GenieX does not check the key, so it can stay empty.
4. Adjust context, output limit, thinking, sampling, warmup, MTP, and inference backend as needed.
5. Click **Save and apply**.
6. Select a model under **From GenieX** or **From QwenCloud** in the model picker.

### Settings and behavior

- **Context window**: empty uses the model's declared context, or a default when the model declares none. **Prefer model context limit** ignores a manual value.
- **Max output**: defaults to 16384 and never exceeds the context window or the model's declared output limit.
- **Compaction hints**: the settings page shows the DSH compaction threshold and recommended bigGate; when the context cannot hold the compaction reserve it says compaction is unavailable.
- **Sampling defaults**: only fields missing from the request are filled; empty means the field is omitted. **Read recommended** fills the model's values, which still need to be saved.
- **Warmup**: when enabled, selecting a From GenieX model loads its weights ahead of time. Dots: yellow warming, green resident, red not resident, blue another source.
- **MTP**: for local GGUF models that ship MTP tensors and a matching draft file. While enabled, sending an image asks whether to send directly or disable MTP for that send.
- **Inference backend**: empty Compute and Vision Encoder values use GenieX defaults; Vision Encoder applies to image models only.

### Limitations

- Warmup reduces model load time, not time spent processing a long prompt.
- GenieX keeps one model resident at a time; using different models in different sessions unloads the previous one.
- MTP and images cannot be active together; the send flow asks first.
- The model catalog comes from the upstream. When the upstream is unreachable no models are created, and the plugin retries in the background.
- Warmup, MTP, GGUF metadata, and inference backends are GenieX-only; QwenCloud keeps provider management, thinking, sampling, per-turn statistics, and Reply Only.

---

## License / 许可证

MIT-0. See [LICENSE](LICENSE).
