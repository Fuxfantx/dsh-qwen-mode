# DSH Qwen Mode / DSH Qwen 模式

[中文](#中文) · [English](#english)

---

## 中文

为 Qwen / GenieX 的 OpenAI 兼容端点提供 DSH 集成：自动维护模型 Provider，处理思考与推理内容，并展示每轮模型性能。

### 功能

- **关闭 / 自动** 两档模式；自动档只处理 `From GenieX` / `From QwenCloud` 下的模型。
- 自动创建并维护 **From GenieX** 或 **From QwenCloud** Provider。
- 从上游模型目录发现模型，并配置上下文窗口与最大输出。
- 自动识别 VLM，并为模型声明文本与图片输入。
- 处理思考参数与推理内容，兼容上游已分离和未分离两种输出。
- 为流式请求补充用量统计，显示模型名、TTFT、Decode TPS 与耗时；历史轮次也可查看。
- 可选模型预热；模型列表用颜色显示预热与驻留状态。
- 可配置 GenieX Compute、Vision Encoder 与采样默认值。
- 安装 **仅回复** 权限：只读、无审批，并隐藏和拒绝工具调用。

### 安装

- DSH 需支持 Cordis bundle 与 Plugin Manager。
- 从离线 zip 或插件目录安装，刷新 DSH 页面；详见 [INSTALL.md](INSTALL.md)。
- 本包没有 npm 依赖。

### 使用

1. 打开 **Settings → Qwen Mode**。
2. 选择 **关闭** 或 **自动**。
3. 选择来源并填写上游地址：
   - **GenieX**：填 `http://127.0.0.1:18181`，插件自动使用 `/v1`。
   - **QwenCloud**：填写完整兼容端点，插件不会自动追加 `/v1`。
4. 按需设置上下文窗口、最大输出、推理后端与采样默认值。
5. 点击「保存并应用」，插件自动创建或更新 Provider。
6. 在模型选择器中选择该 Provider 下的模型。

### 设置

- **API Key**：留空时使用 DSH credential `local`；QwenCloud 可填写环境变量名，例如 `DASHSCOPE_API_KEY`。
- **上下文窗口**：留空时 GenieX 使用服务端 `--nctx`；QwenCloud 使用 `262144`。
- **推理后端**（仅 GenieX）：
  - `Compute` 可留空，或填写 `cpu` / `gpu` / `npu` / `hybrid` / 设备列表。
  - `Vision Encoder` 可选 CPU / GPU / NPU；NPU 对应 GenieX 的 `HTP2`。
- **模型预热**：位于「接入来源 → 高级选项」，仅对 `From GenieX` 生效。预热与正式请求使用相同的加载参数，避免刚预热就因参数变化重新加载。
- **驻留圆点**：仅在来源为 GenieX、模式为自动且自动预热启用时显示：
  - 黄点：正在预热
  - 绿点：已预热并驻留
  - 红点：未预热
  - 蓝点：其它 Provider，无需预热
- **统计**：仅在该轮回复完成后显示。
- **仅回复**：隐藏并拒绝工具调用，适合纯聊天。
- **repetition_penalty**：可设为 `1.05`，降低 thinking 段落循环输出的概率。

### 限制

- 代理固定监听 `127.0.0.1:18182`；端口被占用时插件无法启动。
- 模型目录来自上游 `/v1/models`；上游不提供该端点时不会创建模型。
- 模型选择仍由 DSH 按会话管理；插件的预热/驻留状态是全局的，但不会改写各会话已选择的模型。
- GenieX 同一时刻只驻留一个模型。不同会话选择不同模型时，旧模型会被卸载，这是上游行为。

---

## English

DSH integration for OpenAI-compatible Qwen / GenieX endpoints: managed model providers, thinking and reasoning handling, and per-turn model performance.

### Features

- **Off / Auto** modes; Auto applies only to models under `From GenieX` / `From QwenCloud`.
- Creates and maintains the **From GenieX** or **From QwenCloud** provider.
- Discovers models from the upstream catalog and configures context and output limits.
- Detects VLM models and declares text plus image input.
- Handles thinking parameters and reasoning content, whether the upstream separates it or not.
- Adds streaming usage data and shows model name, TTFT, Decode TPS, and elapsed time; historical turns are included.
- Optional model warmup, with colored residency dots in the model list.
- GenieX Compute, Vision Encoder, and sampling defaults.
- **Reply Only** permission: read-only, no approvals, tools hidden and denied.

### Install

- DSH with Cordis bundle and Plugin Manager support.
- Install from the offline zip or plugin directory, then refresh DSH. See [INSTALL.md](INSTALL.md).
- The package has no npm dependencies.

### Usage

1. Open **Settings → Qwen Mode**.
2. Choose **Off** or **Auto**.
3. Choose a source and enter the upstream URL:
   - **GenieX**: `http://127.0.0.1:18181`; the plugin appends `/v1`.
   - **QwenCloud**: enter the full compatible endpoint; the plugin does not append `/v1`.
4. Adjust context, max output, inference backend, and sampling defaults as needed.
5. Click **Save and Apply**; the provider is created or updated.
6. Select a model under that provider in the model picker.

### Settings

- **API Key**: empty uses the DSH credential `local`; for QwenCloud, enter an environment variable such as `DASHSCOPE_API_KEY`.
- **Context window**: empty lets GenieX use its `--nctx`; QwenCloud falls back to `262144`.
- **Inference Backend** (GenieX only):
  - `Compute` may be empty or contain `cpu` / `gpu` / `npu` / `hybrid` / a device list.
  - `Vision Encoder` selects CPU / GPU / NPU; NPU maps to GenieX `HTP2`.
- **Model Warmup**: under **Source → Advanced**, GenieX only. Warmup uses the same load parameters as real requests, so it is not immediately reloaded.
- **Residency dots**: shown only when the source is GenieX, the mode is Auto, and warmup is enabled:
  - Yellow: warming up
  - Green: warmed and resident
  - Red: not warmed
  - Blue: another provider, no warmup needed
- **Stats**: shown after a reply completes.
- **Reply Only**: hides and denies tools for pure chat.
- **repetition_penalty**: try `1.05` to reduce looping in thinking output.

### Limitations

- The proxy listens on `127.0.0.1:18182`; it cannot start if the port is busy.
- Model catalogs come from the upstream `/v1/models` endpoint.
- Model selection stays per Session in DSH; the plugin's warm/residency state is global but does not rewrite session selections.
- GenieX keeps only one model resident at a time. Different models selected in different Sessions will unload the previous one; this is upstream behavior.

---

## Files / 文件

- `index.js` — proxy, provider maintenance, model discovery, reasoning, metrics, warm status.
- `client.js` — settings page, model list status, warmup spinner, permission icon, turn stats.
- `cordis.patch.yml` — installs the `qwen-mode` loader row.
- `locale/` — plugin inventory copy (`zh`, `en`).
- `icon.svg` — plugin icon.

## License / 许可证

MIT-0. See [LICENSE](LICENSE).
