# DSH Qwen mode / DSH Qwen 模式

[中文](#中文) · [English](#english)

---

## 中文

为 Qwen / GenieX 的 OpenAI 兼容端点提供 DSH 集成：自动维护 Provider、补齐思考参数、解析推理内容，并显示每轮模型性能。

### 功能

- **关闭 / 自动** 两档模式；自动档只处理 `From GenieX` / `From QwenCloud` 下的模型。
- GenieX 自动创建 **From GenieX**，QwenCloud 自动创建 **From QwenCloud**。
- 从上游模型目录发现模型，生成上下文窗口与最大输出限制。
- GenieX 注入顶层 `enable_think`；QwenCloud 注入 `enable_thinking` 并保留 `reasoning_effort`。
- 将 `<think>...</think>` 拆为 `reasoning_content`；无标签时识别 GenieX 的“推理段落 + 空行 + 正文”结构。
- 为流式请求补 `stream_options.include_usage`，并在回复结束后显示模型名、TTFT、Decode TPS 和时间。
- 安装 **仅回复 / Reply Only** 权限：只读、无审批，并隐藏/拒绝工具调用。
- 可选模型预热：选择 `From GenieX` 模型时提前加载；预热请求串行执行，避免模型互相换出内存。
- 模型选择器显示量化精度（如 `Q4_0`），并隐藏官方 trigger 图标。
- 可配置上下文窗口、最大输出长度、思考模式、采样默认值。

### 安装

从离线 zip 或插件目录安装，刷新 DSH 页面。详细步骤见 [INSTALL.md](INSTALL.md)。

本包没有 npm 依赖。

### 使用

1. 打开 **Settings → Qwen mode**。
2. 选择 **关闭** 或 **自动**。
3. 选择来源并填写上游地址：
   - **GenieX**：填 `http://127.0.0.1:18181` 即可，插件自动使用 `/v1`。
   - **QwenCloud**：填写完整兼容端点，插件不会自动追加 `/v1`。
4. 按需设置模型限制、思考与采样默认值。
5. 点击「保存并应用」，插件自动创建/更新 Provider。
6. 在模型选择器中选择该 Provider 下的模型。

关闭会移除插件管理的 Provider；用户自己创建的 Provider 不受影响。

### 设置说明

- **API Key**：留空时使用 DSH credential `local`，不会读取同名环境变量；QwenCloud 可填写环境变量名，例如 `DASHSCOPE_API_KEY`。
- **模型预热**：位于「接入来源 → 高级选项」，仅对 `From GenieX` 生效；预热期间发送按钮替换为转圈。
- **统计显示**：只能在回复完成后显示；DSH 在流式阶段不提供可用的 TTFT/Decode TPS 结算值。
- **权限**：`仅回复` 会隐藏并拒绝工具调用，适合纯聊天。

### 限制

- 代理固定监听 `127.0.0.1:18182`；端口被占用时插件无法启动。
- 模型目录来自上游 `/v1/models`；上游不提供该端点时不会创建模型。
- 只处理 JSON 请求体和 SSE/JSON 响应，其他端点原样透传。
- 采样默认值只填充请求未自带的字段。

---

## English

DSH integration for OpenAI-compatible Qwen / GenieX endpoints: managed providers, thinking controls, reasoning parsing, and per-turn model performance.

### Features

- **Off / Auto** only; Auto applies only to models under `From GenieX` / `From QwenCloud`.
- GenieX creates **From GenieX**; QwenCloud creates **From QwenCloud**.
- Discovers models and builds context-window / max-output limits.
- Injects `enable_think` for GenieX; injects `enable_thinking` and preserves `reasoning_effort` for QwenCloud.
- Splits `<think>...</think>` into `reasoning_content`; recognizes GenieX's reasoning-paragraph + blank-line + answer shape when tags are absent.
- Adds `stream_options.include_usage` to streaming requests and shows model, TTFT, Decode TPS, and time after a reply completes.
- Adds **仅回复 / Reply Only**: read-only, no approvals, tools hidden/denied.
- Optional warmup for `From GenieX` models; warmups are serialized so models cannot evict each other.
- Shows a quantization badge (for example `Q4_0`) and hides the shipped model-trigger icon.
- Configurable context window, max output, thinking mode, and sampling defaults.

### Install

Install from the offline zip or the plugin directory, then refresh DSH. See [INSTALL.md](INSTALL.md) for details.

The package has no npm dependencies.

### Usage

1. Open **Settings → Qwen mode**.
2. Choose **Off** or **Auto**.
3. Choose a source and enter the upstream URL:
   - **GenieX**: `http://127.0.0.1:18181`; the plugin appends `/v1` automatically.
   - **QwenCloud**: enter the full compatible endpoint; the plugin does not append `/v1`.
4. Adjust model limits, thinking, and sampling defaults.
5. Click **Save and apply**; the managed provider is created or updated.
6. Select a model under that provider in the model picker.

Off removes the managed provider; user-created providers are untouched.

### Settings

- **API key**: empty uses DSH credential `local` and does not read an environment variable of that name. For QwenCloud, enter an environment variable such as `DASHSCOPE_API_KEY`.
- **Model warmup**: under **Source → Advanced**, applies only to `From GenieX`; the send button is replaced by a spinner while warming.
- **Stats**: shown only after completion; DSH does not expose settled TTFT/Decode TPS during streaming.
- **Permission**: `Reply Only` hides and denies tools for a pure chat experience.

### Limitations

- The proxy listens on `127.0.0.1:18182`; the plugin cannot start if the port is busy.
- Model catalogs come from the upstream `/v1/models` endpoint.
- Only JSON request bodies and SSE/JSON responses are transformed; other endpoints pass through.
- Sampling defaults fill only fields the request does not already carry.

---

## Files / 文件

- `index.js` — proxy, provider maintenance, model discovery, reasoning parser, turn metrics.
- `client.js` — Settings page, model label, warmup spinner, permission icon.
- `cordis.patch.yml` — installs the `qwen-mode` loader row.
- `locale/` — plugin inventory copy (`zh`, `en`).
- `icon.svg` — plugin icon.

---

## License / 许可证

MIT-0. See [LICENSE](LICENSE).

