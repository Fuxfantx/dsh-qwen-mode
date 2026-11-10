# DSH Qwen Mode / DSH Qwen 模式

[中文](#中文) · [English](#english)

---

## 中文

在 DSH 中接入 Qwen、GenieX 与 QwenCloud，自动维护模型 Provider，并提供预热、采样、MTP、图片模型和会话用量统计。

### 功能

- **关闭 / 自动** 两种模式；自动模式只管理 `From GenieX` / `From QwenCloud` 下的模型。
- 自动发现模型并创建 Provider，识别文本、图片和推理模型。
- GenieX 从本地缓存（`geniex.json` + GGUF 头）读取上下文、采样、MTP 与标签；QwenCloud 从百炼模型目录读取上下文、最大输出与模态，失败时回退到标准 `/models`。
- 统一处理上游的思考参数与推理内容：QwenCloud 使用 `enable_thinking` / `preserve_thinking` / 合法的 `reasoning_effort`，GenieX 使用 `enable_think` + `reasoning_format=auto`；出现行内 ` thinking` 标签时再重建 `reasoning_content`。
- 显示每轮模型名、TTFT、Decode TPS 与耗时。
- 可选模型预热（使用 GenieX 原生预热请求，不产生 token），并用圆点显示驻留状态。
- 从模型元数据读取推荐采样值。
- 可选 MTP 投机解码；GGUF 模型需要内含 mtp / nextn 张量并在模型目录注入 `mtp-*.gguf`，QAIRT 模型使用配对的 assistant 草稿模型。生效时显示接受率。
- 破限 / 无审查模型名称高亮。
- 可选「仅回复」权限（中英文名称/描述按界面语言同步，内容未变时不重写配置）。
- 为 From GenieX 会话提供精简的累计 token 用量视图。

### 系统要求与安装

- DSH 需支持 Cordis bundle 与 Plugin Manager。
- 通过 Plugin Manager 安装离线 zip 或插件目录，然后刷新页面。
- 本包没有 npm 依赖。

### 使用

1. 打开 **Settings → Qwen Mode**。
2. 选择 **关闭** 或 **自动**。
3. 选择来源并填写地址：
   - **GenieX**：`http://127.0.0.1:18181`
   - **QwenCloud**：填写完整的兼容端点，例如 `https://{WorkspaceId}.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1`
4. 按需设置上下文、最大输出、推理后端、采样与 MTP。
5. 点击「保存并应用」。
6. 在模型选择器中选择对应 Provider 下的模型。

### 设置与行为

- **上下文**：留空时优先采用模型自身上下文；没有元数据时 GenieX 取 131072。显式填写的值会覆盖模型元数据；启用「优先使用模型上下文阈限」后则强制使用模型值。GenieX 会把同一数值作为 `nctx` 下发，避免 DSH 声明的窗口与上游实际窗口不一致。
- **最大输出**：默认 16384，并被上下文窗口截断；模型目录给出 `max_output_tokens` 时也会一并限制。
- **压缩预算**：根据上下文和最大输出实时显示 DSH 压缩阈值与推荐 `bigGate`；两者无法同时容纳 64K 预留时会明确提示压缩不可用。
- **API Key**：填写保存 Key 的**环境变量名或 DSH 凭据名**（如 `DASHSCOPE_API_KEY`），不是 Key 本身；GenieX 不校验，留空即可。
- **预热**：选中 GenieX 模型时提前加载权重。圆点状态：黄色预热中、绿色已驻留、红色未驻留、蓝色其它 Provider。
- **采样默认值**：可手动填写，也可用「读取推荐值」填入模型推荐参数；之后仍需保存。数值会按上游合法范围校验/收敛。`min_p` 仅对 GenieX 生效。
- **MTP**：仅对支持的 GenieX 模型生效。GGUF 模型需要模型主体包含 mtp / nextn 张量，并在模型目录注入 `mtp-*.gguf`；请求会以该文件的绝对路径作为草稿模型（等价于 `--draft-model C:\my\mtp-model.gguf`）。QAIRT 模型使用名称配对的 assistant 草稿模型（会从聊天目录隐藏）。图片模型启用 MTP 时，发送图片会要求选择直接发送或关闭本次 MTP。
- **推理后端**：GenieX 可设置 Compute 与 Vision Encoder；留空使用上游默认值。
- **模型高亮**：破限 / 无审查模型使用明亮橙黄色名称。
- **会话用量**：含 From GenieX 回复的会话只显示累计 token；点击后显示输入与输出。
- **仅回复**：隐藏并拒绝工具调用。

### 限制

- 预热只减少模型加载时间，不减少长提示词的处理时间。
- GenieX 同一时刻只驻留一个模型；不同会话选择不同模型时会卸载前一个。
- MTP 与图片同时使用时，图片可能不被上游处理，发送前会要求选择。
- 模型目录来自上游模型列表；上游不可用时不会创建模型。QwenCloud 的模型目录来自 `/api/v1/models`，若网关只提供标准 `/models` 会自动回退。
- 预热、MTP、GGUF 元数据和推理后端仅适用于 GenieX 来源；QwenCloud 来源保留 Provider 管理、采样、思考参数、统计和仅回复。
- 上游不可达时插件仍会启动（设置页可用），Provider 刷新会在后台重试并显示错误。


---

## English

Connect DSH to Qwen, GenieX, and QwenCloud. Qwen Mode maintains the provider automatically and adds warmup, sampling, MTP, vision-model handling, and session usage views.

### Features

- **Off / Auto** modes; Auto manages only models under `From GenieX` / `From QwenCloud`.
- Discovers models, creates the provider, and recognizes text, image, and reasoning models.
- GenieX reads context, sampling, MTP, and tags from the local cache (`geniex.json` plus the GGUF header); QwenCloud reads context, max output, and modalities from the Model Studio catalog and falls back to the standard `/models` listing.
- Normalizes upstream thinking parameters and reasoning content: QwenCloud gets `enable_thinking` / `preserve_thinking` / only valid `reasoning_effort` values, GenieX gets `enable_think` + `reasoning_format=auto`; inline ` thinking` tags are rebuilt into `reasoning_content` only when the upstream does not separate them.
- Shows model name, TTFT, Decode TPS, and elapsed time per turn.
- Optional model warmup through GenieX's native warm-up request (no token generation) with residency dots.
- Reads recommended sampling values from model metadata.
- Optional MTP speculative decoding; GGUF models need their own mtp / nextn tensors plus an injected `mtp-*.gguf`, while QAIRT models use a paired assistant draft. Shows the acceptance rate while active.
- Highlights abliterated / uncensored model names.
- Optional **Reply Only** permission, with the preset label/description kept in sync with the UI language and no config rewrite when nothing changed.
- Provides a compact cumulative token view for sessions containing From GenieX replies.

### System requirements and install

- DSH with Cordis bundle and Plugin Manager support.
- Install the offline zip or plugin directory through Plugin Manager, then refresh the page.
- The package has no npm dependencies.

### Usage

1. Open **Settings → Qwen Mode**.
2. Choose **Off** or **Auto**.
3. Choose a source and enter its URL:
   - **GenieX**: `http://127.0.0.1:18181`
   - **QwenCloud**: the full compatible endpoint, e.g. `https://{WorkspaceId}.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1`
4. Adjust context, output, inference backend, sampling, and MTP as needed.
5. Click **Save and Apply**.
6. Select a model under that provider in the model picker.

### Settings and behavior

- **Context**: empty prefers the model's own context; without metadata GenieX uses 131072. An explicit value overrides the metadata, while **Prefer model context limit** forces the model value — the plugin sends the same number as GenieX `nctx`, so the window DSH declares and the window the upstream actually allocates cannot drift apart.
- **Max output**: defaults to 16384 and is capped by the context window and, when the catalog exposes it, by the model's `max_output_tokens`.
- **Compaction budget**: shows the DSH compaction threshold and recommended `bigGate` from the current context and output limit; when the 64K reserve cannot fit it says compaction is unavailable.
- **API key**: enter the **environment variable or DSH credential name** that stores the key (for example `DASHSCOPE_API_KEY`), not the key itself; GenieX ignores it.
- **Warmup**: loads GenieX model weights when selected. Dots: yellow warming, green resident, red not resident, blue another provider.
- **Sampling defaults**: enter values manually, or use **Read recommended** and then save. Values are validated/clamped to the upstream's accepted ranges. `min_p` applies to GenieX only.
- **MTP**: available only on supported GenieX models. A GGUF model needs mtp / nextn tensors in the weights plus an injected `mtp-*.gguf` in the model directory; the request names that file's absolute path as the draft (equivalent to `--draft-model C:\my\mtp-model.gguf`). A QAIRT model uses a name-paired assistant draft, which is hidden from the chat catalog. With an image model, an image send asks whether to send directly or disable MTP for that send.
- **Inference backend**: GenieX Compute and Vision Encoder; empty uses upstream defaults.
- **Model highlight**: abliterated / uncensored models use a bright orange-yellow name.
- **Session usage**: sessions containing From GenieX replies show cumulative tokens only; click to see input and output.
- **Reply Only**: hides and denies tools.

### Limitations

- Warmup reduces model load time, not time spent processing a long prompt.
- GenieX keeps one model resident at a time; selecting different models in different sessions unloads the previous one.
- MTP with images may prevent the upstream from processing the image; the send flow asks first.
- Model catalogs come from the upstream model list; no catalog means no models. QwenCloud uses `/api/v1/models` and falls back to the standard `/models` endpoint.
- Warmup, MTP, GGUF metadata, and inference backends are GenieX-only; QwenCloud keeps provider management, sampling, thinking parameters, stats, and Reply Only.
- An unreachable upstream no longer blocks activation: the settings page stays available, discovery retries in the background, and the failure is shown as an error.

---

## License / 许可证

MIT-0. See [LICENSE](LICENSE).
