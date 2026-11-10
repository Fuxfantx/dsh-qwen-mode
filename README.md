# DSH Qwen Mode / DSH Qwen 模式

[中文](#中文) · [English](#english)

---

## 中文

在 DSH 中接入 Qwen、GenieX 与 QwenCloud：自动管理模型 Provider，支持预热、采样推荐、MTP、图片模型和每轮性能统计。

### 功能

- **关闭 / 自动** 两种模式；自动模式只管理 `From GenieX` / `From QwenCloud` 下的模型。
- 自动发现模型并创建 Provider，识别文本、图片与推理模型。
- 兼容上游已分离和未分离的思考内容，统一显示推理过程。
- 显示每轮模型名、TTFT、Decode TPS 与总耗时。
- 可选的模型预热与驻留状态圆点。
- 从模型元数据读取推荐采样值，一键填入设置。
- 可选 MTP 投机解码；生效时显示接受率。
- 破限 / 无审查模型在模型列表中高亮显示。
- 可选「仅回复」权限，适合纯聊天。

### 安装

- DSH 需支持 Cordis bundle 与 Plugin Manager。
- 通过 Plugin Manager 安装离线 zip 或插件目录，然后刷新页面。
- 详见 [INSTALL.md](INSTALL.md)；本包没有 npm 依赖。

### 使用

1. 打开 **Settings → Qwen Mode**。
2. 选择 **关闭** 或 **自动**。
3. 选择来源并填写地址：
   - **GenieX**：`http://127.0.0.1:18181`
   - **QwenCloud**：填写完整的兼容端点
4. 按需设置上下文、最大输出、推理后端、采样与 MTP。
5. 点击「保存并应用」。
6. 在模型选择器中选择对应 Provider 下的模型。

### 设置说明

- **上下文**：留空时使用服务端默认值；启用「优先使用模型上下文阈限」后优先采用模型自身的上下文长度。
- **预热**：开启后，选中 GenieX 模型时提前加载权重。模型列表圆点表示状态：
  - 黄色：正在预热
  - 绿色：已驻留
  - 红色：未驻留
  - 蓝色：其它 Provider
- **采样默认值**：可手动填写，也可从「读取推荐值」选择模型并填入推荐参数；填入后仍需保存。
- **MTP 投机解码**：仅对支持的模型生效。开启后可设置投机参数；图片模型在启用 MTP 时发送图片会先询问处理方式。
- **推理后端**（GenieX）：可设置 Compute 与 Vision Encoder；留空使用 GenieX 默认值。
- **模型名高亮**：破限 / 无审查模型使用明亮橙黄色显示。
- **仅回复**：隐藏并拒绝工具调用。
- **推理内容**：历史思考内容是否保留由模型模板决定，插件不提供虚假开关。

### 限制

- 预热只减少模型加载时间，不减少长提示词的 prefill；因此“预热后首次 TTFT 仍较长”可能来自提示词本身。
- GenieX 同一时刻只驻留一个模型。不同会话选择不同模型时，前一个模型会被卸载。
- 图片与 MTP 同时使用时，图片可能不被上游处理；发送前会要求选择。
- 模型目录来自上游模型列表；上游不可用时不会创建模型。

---

## English

Connect DSH to Qwen, GenieX, and QwenCloud endpoints. Qwen Mode manages the model provider automatically and adds warmup, sampling recommendations, MTP, vision models, and per-turn performance stats.

### Features

- **Off / Auto** modes; Auto manages only models under `From GenieX` / `From QwenCloud`.
- Discovers models, creates the provider, and recognizes text, image, and reasoning models.
- Handles separated and inline reasoning content consistently.
- Shows model name, TTFT, Decode TPS, and elapsed time for each turn.
- Optional model warmup with colored residency dots.
- Reads recommended sampling values from model metadata.
- Optional MTP speculative decoding with acceptance rate.
- Highlights abliterated / uncensored models in the picker.
- Optional **Reply Only** permission for pure chat.

### Install

- DSH with Cordis bundle and Plugin Manager support.
- Install the offline zip or plugin directory through Plugin Manager, then refresh the page.
- See [INSTALL.md](INSTALL.md). The package has no npm dependencies.

### Usage

1. Open **Settings → Qwen Mode**.
2. Choose **Off** or **Auto**.
3. Choose a source and enter its URL:
   - **GenieX**: `http://127.0.0.1:18181`
   - **QwenCloud**: the full compatible endpoint
4. Adjust context, output, inference backend, sampling, and MTP as needed.
5. Click **Save and Apply**.
6. Select a model under that provider in the model picker.

### Settings

- **Context**: empty uses the server default; **Prefer model context limit** uses the model's own context length when available.
- **Warmup**: loads GenieX model weights ahead of the first request. Dots show:
  - Yellow: warming
  - Green: resident
  - Red: not resident
  - Blue: another provider
- **Sampling defaults**: enter values manually, or pick a model and use **Read recommended**, then save.
- **MTP speculative decoding**: available only on supported models. Draft parameters are configurable; image models ask how to handle an image send while MTP is enabled.
- **Inference backend** (GenieX): Compute and Vision Encoder; empty uses GenieX defaults.
- **Model highlight**: abliterated / uncensored models use a bright orange-yellow name.
- **Reply Only**: hides and denies tools.
- **Reasoning content**: whether historical thinking is preserved depends on the model template; no fake toggle is exposed.

### Limitations

- Warmup reduces model load time, not prompt prefill. A long first TTFT after warmup can come from the prompt itself.
- GenieX keeps one model resident at a time; selecting different models in different sessions unloads the previous one.
- When images and MTP are used together, the image may not be processed by the upstream; the send flow asks first.
- Model catalogs come from the upstream model list; no catalog means no models.

---

## License / 许可证

MIT-0. See [LICENSE](LICENSE).
