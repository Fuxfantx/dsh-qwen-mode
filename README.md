# DSH Qwen Mode / DSH Qwen 模式

[中文](#中文) · [English](#english)

---

## 中文

在 DSH 中接入 Qwen、GenieX 与 QwenCloud，自动维护模型 Provider，并提供预热、采样、MTP、图片模型和会话用量统计。

### 功能

- **关闭 / 自动** 两种模式；自动模式只管理 `From GenieX` / `From QwenCloud` 下的模型。
- 自动发现模型并创建 Provider，识别文本、图片和推理模型。
- 统一处理上游的思考参数与推理内容。
- 显示每轮模型名、TTFT、Decode TPS 与耗时。
- 可选模型预热，并用圆点显示驻留状态。
- 从模型元数据读取推荐采样值。
- 可选 MTP 投机解码；生效时显示接受率。
- 破限 / 无审查模型名称高亮。
- 可选「仅回复」权限。
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
   - **QwenCloud**：填写完整的兼容端点
4. 按需设置上下文、最大输出、推理后端、采样与 MTP。
5. 点击「保存并应用」。
6. 在模型选择器中选择对应 Provider 下的模型。

### 设置与行为

- **上下文**：留空时使用上游默认值；启用「优先使用模型上下文阈限」后优先采用模型自身的上下文长度。
- **压缩预算**：根据上下文和最大输出实时显示 DSH 压缩阈值与推荐 `bigGate`。
- **预热**：选中 GenieX 模型时提前加载权重。圆点状态：黄色预热中、绿色已驻留、红色未驻留、蓝色其它 Provider。
- **采样默认值**：可手动填写，也可用「读取推荐值」填入模型推荐参数；之后仍需保存。
- **MTP**：仅对支持的 GenieX 模型生效。图片模型启用 MTP 时，发送图片会要求选择直接发送或关闭本次 MTP。
- **推理后端**：GenieX 可设置 Compute 与 Vision Encoder；留空使用上游默认值。
- **模型高亮**：破限 / 无审查模型使用明亮橙黄色名称。
- **会话用量**：含 From GenieX 回复的会话只显示累计 token；点击后显示输入与输出。
- **仅回复**：隐藏并拒绝工具调用。

### 限制

- 预热只减少模型加载时间，不减少长提示词的处理时间。
- GenieX 同一时刻只驻留一个模型；不同会话选择不同模型时会卸载前一个。
- MTP 与图片同时使用时，图片可能不被上游处理，发送前会要求选择。
- 模型目录来自上游模型列表；上游不可用时不会创建模型。
- 预热、MTP、GGUF 元数据和推理后端仅适用于 GenieX 来源；QwenCloud 来源保留 Provider 管理、采样、思考参数、统计和仅回复。

---

## English

Connect DSH to Qwen, GenieX, and QwenCloud. Qwen Mode maintains the provider automatically and adds warmup, sampling, MTP, vision-model handling, and session usage views.

### Features

- **Off / Auto** modes; Auto manages only models under `From GenieX` / `From QwenCloud`.
- Discovers models, creates the provider, and recognizes text, image, and reasoning models.
- Normalizes upstream thinking parameters and reasoning content.
- Shows model name, TTFT, Decode TPS, and elapsed time per turn.
- Optional model warmup with residency dots.
- Reads recommended sampling values from model metadata.
- Optional MTP speculative decoding with acceptance rate.
- Highlights abliterated / uncensored model names.
- Optional **Reply Only** permission.
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
   - **QwenCloud**: the full compatible endpoint
4. Adjust context, output, inference backend, sampling, and MTP as needed.
5. Click **Save and Apply**.
6. Select a model under that provider in the model picker.

### Settings and behavior

- **Context**: empty uses the upstream default; **Prefer model context limit** uses the model's own context length when available.
- **Compaction budget**: shows the DSH compaction threshold and recommended `bigGate` from the current context and output limit.
- **Warmup**: loads GenieX model weights when selected. Dots: yellow warming, green resident, red not resident, blue another provider.
- **Sampling defaults**: enter values manually, or use **Read recommended** and then save.
- **MTP**: available only on supported GenieX models. With an image model, an image send asks whether to send directly or disable MTP for that send.
- **Inference backend**: GenieX Compute and Vision Encoder; empty uses upstream defaults.
- **Model highlight**: abliterated / uncensored models use a bright orange-yellow name.
- **Session usage**: sessions containing From GenieX replies show cumulative tokens only; click to see input and output.
- **Reply Only**: hides and denies tools.

### Limitations

- Warmup reduces model load time, not time spent processing a long prompt.
- GenieX keeps one model resident at a time; selecting different models in different sessions unloads the previous one.
- MTP with images may prevent the upstream from processing the image; the send flow asks first.
- Model catalogs come from the upstream model list; no catalog means no models.
- Warmup, MTP, GGUF metadata, and inference backends are GenieX-only; QwenCloud keeps provider management, sampling, thinking parameters, stats, and Reply Only.

---

## License / 许可证

MIT-0. See [LICENSE](LICENSE).
