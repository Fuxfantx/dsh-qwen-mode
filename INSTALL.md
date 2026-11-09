# DSH Qwen mode — offline install / 离线安装

Version / 版本: **1.6.0**

## 中文

压缩包内容：

- `dsh-qwen-mode/` — 解压后的插件目录。
- `dsh-qwen-mode-1.6.0.tgz` — npm tarball。
- `INSTALL.md` — 本说明。

安装：

1. 解压压缩包。
2. 在目标 DSH 的 Plugins / Plugin Manager 中选择本地目录安装；如果当前版本没有本地安装入口，让 Agent 使用 `plugin_manager` 的 `install_bundle`，`target` 填 `dsh-qwen-mode` 目录的绝对路径。
3. 刷新 DSH 页面，打开 **Settings → Qwen mode**。
4. 选择 GenieX 或 QwenCloud，填写上游地址：
   - GenieX 可填 `http://127.0.0.1:18181`，插件自动使用 `/v1`；
   - QwenCloud 填写完整兼容端点，插件不会自动追加 `/v1`。
5. 点击「保存并应用」，插件会自动创建 **From GenieX** / **From QwenCloud** Provider。
6. 在模型选择器中选择该 Provider 下的模型。

本包没有 npm 依赖，离线安装不需要联网。代理固定监听 `127.0.0.1:18182`。

## English

Archive contents:

- `dsh-qwen-mode/` — unpacked plugin directory.
- `dsh-qwen-mode-1.6.0.tgz` — npm tarball.
- `INSTALL.md` — this file.

Install:

1. Extract the archive.
2. In the target DSH, use Plugins / Plugin Manager to install from the local directory; if that entry is unavailable, ask the DSH agent to call `plugin_manager` `install_bundle` with the absolute `dsh-qwen-mode` directory as `target`.
3. Refresh DSH and open **Settings → Qwen mode**.
4. Choose GenieX or QwenCloud and enter the upstream URL:
   - For GenieX, `http://127.0.0.1:18181` is enough; the plugin uses `/v1` automatically.
   - For QwenCloud, enter the full compatible endpoint; the plugin does not append `/v1`.
5. Click **Save and apply**; the plugin creates **From GenieX** / **From QwenCloud** automatically.
6. Select a model under that provider in the model picker.

The package has no npm dependencies, so offline installation needs no network access. The proxy listens on `127.0.0.1:18182`.






























