/**
 * Browser half of the Qwen mode bundle: one compact Settings section.
 *
 * The Host owns the provider entry (`From GenieX` / `From QwenCloud`), so this
 * page exposes the source, model limits, inference backend, and sampling defaults.
 *
 * @module dsh-qwen-mode/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-qwen-mode',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const NS = 'qwenMode'
    const API = '/qwen-mode/api'
    const DEFAULT_CONTEXT_WINDOW = 262144

    const zh = {
      'section.title': 'Qwen 模式',
      'section.subtitle': '自动创建并维护 Qwen Provider，补齐思考参数与采样默认值',
      'mode.off': '关闭',
      'mode.auto': '自动',
      'source.title': '接入来源',
      'protocol.label': '来源',
      'protocol.geniex': 'GenieX',
      'protocol.qwen': 'QwenCloud',
      'upstream.label': '上游地址',
      'apiKeyEnv.label': 'API Key（可选）',
      'apiKeyEnv.placeholder': 'local',
      'warm.label': '选择 From GenieX 模型时自动预热',
      'warm.hint': '发送一个最小 system prompt、单 token 且关闭推理的请求，让 GenieX 提前加载模型；预热期间发送按钮显示转圈。',
      'advanced': '高级选项',
      'provider.title': '自动维护的 Provider',
      'provider.name': 'Provider',
      'provider.baseURL': 'baseURL',
      'provider.exists': '已创建',
      'provider.missing': '未创建',
      'provider.rebuild': '重建 Provider',
      'provider.remove': '移除 Provider',
      'provider.modelsFound': '自 /models 处发现 {count} 个模型：{models}',
      'noModels': '尚未发现模型',
      'modelConfig.title': '模型配置',
      'inference.title': '推理后端',
      'compute.label': 'Compute',
      'compute.hint': '留空则使用 GenieX 默认值。',
      'vit.label': 'Vision Encoder',
      'vit.hint': '仅对 VLM 生效；NPU 映射为 GenieX 的 HTP2。',
      'vit.cpu': 'CPU',
      'vit.gpu': 'GPU',
      'vit.npu': 'NPU',
      'limits.invalid': '最大输出长度不能大于上下文窗口。',
      'contextWindow.label': '上下文窗口',
      'contextWindow.geniexPlaceholder': 'GENIEX_NCTX（default 4096）',
      'autoNctx.label': '优先使用模型上下文阈限（GGUF context_length）',
      'maxOutputTokens.label': '最大输出长度',
      'mtp.label': 'MTP 投机解码',
      'mtp.hint': '仅对内含MTP/nextn 头、目录存在 mtp-*.gguf 的GGUF模型生效，MTP启用时暂不支持添加图片。',
      'mtp.tokens': 'spec_n_max',
      'mtp.min': 'spec_n_min',
      'mtp.pmin': 'spec_p_min',
      'mtp.imageTitle': '图片与 MTP 冲突',
      'mtp.imageBody': '当前模型支持图片，但启用 MTP 时 GenieX 会走纯文本路径。',
      'mtp.direct': '直接发送',
      'mtp.directHint': '图片会被忽略',
      'mtp.disable': '关闭 MTP 发送',
      'mtp.disableHint': '需要重新加载模型',
      'mtp.cancel': '取消',
      'sampling.title': '采样默认值',
      'sampling.hint': '仅在请求未携带该字段时填充；留空则不注入。',
      'sampling.recommend': '元数据推荐',
      'sampling.fill': '填入推荐值',
      'sampling.none': '当前没有带推荐采样值的模型',
      'sampling.recommendHint': '从 GGUF 的 general.sampling.* 读取；填入后仍需保存。',
      'temperature.label': 'temperature',
      'topP.label': 'top_p',
      'topK.label': 'top_k',
      'minP.label': 'min_p',
      'repetitionPenalty.label': 'repetition_penalty',
      'presencePenalty.label': 'presence_penalty',
      'frequencyPenalty.label': 'frequency_penalty',
      'save': '保存并应用',
      'saving': '保存中…',
      'loadFailed': '读取设置失败：{message}',
      'saveFailed': '操作失败：{message}',
      'numberInvalid': '{field} 需要是数字或留空',
      'footer.hint': '保存后自动重建 Provider 与模型目录；切换来源会移除另一个来源的 Provider。',
      'stats.ttft': 'TTFT: {value}',
      'stats.tps': '{value} tok/s',
      'stats.ms': '{value} ms',
      'stats.sec': '{value} s',
    }

    const en = {
      'section.title': 'Qwen mode',
      'section.subtitle': 'Auto-create and maintain Qwen providers with thinking and sampling defaults',
      'mode.off': 'Off',
      'mode.auto': 'Auto',
      'source.title': 'Source',
      'protocol.label': 'Source',
      'protocol.geniex': 'GenieX',
      'protocol.qwen': 'QwenCloud',
      'upstream.label': 'Upstream URL',
      'apiKeyEnv.label': 'API key (optional)',
      'apiKeyEnv.placeholder': 'local',
      'warm.label': 'Warm up when selecting a From GenieX model',
      'warm.hint': 'Sends a minimal system prompt with a one-token, non-thinking request so GenieX loads the model; the send button shows a spinner while warming.',
      'advanced': 'Advanced',
      'provider.title': 'Managed provider',
      'provider.name': 'Provider',
      'provider.baseURL': 'baseURL',
      'provider.exists': 'Created',
      'provider.missing': 'Missing',
      'provider.rebuild': 'Rebuild provider',
      'provider.remove': 'Remove provider',
      'provider.modelsFound': 'Found {count} models from /models: {models}',
      'noModels': 'No models discovered yet',
      'modelConfig.title': 'Model Configuration',
      'inference.title': 'Inference Backend',
      'compute.label': 'Compute',
      'compute.hint': 'Empty uses the GenieX default.',
      'vit.label': 'Vision Encoder',
      'vit.hint': 'Applies to VLM models only; NPU maps to GenieX HTP2.',
      'vit.cpu': 'CPU',
      'vit.gpu': 'GPU',
      'vit.npu': 'NPU',
      'limits.invalid': 'Max output tokens cannot exceed the context window.',
      'contextWindow.label': 'Context window',
      'contextWindow.geniexPlaceholder': 'GENIEX_NCTX (default 4096)',
      'autoNctx.label': 'Prefer model context limit (GGUF context_length)',
      'maxOutputTokens.label': 'Max output tokens',
      'mtp.label': 'MTP speculative decoding',
      'mtp.hint': 'Applies only to GGUF models with an MTP/nextn head and an mtp-*.gguf companion; images are not supported while MTP is enabled.',
      'mtp.tokens': 'spec_n_max',
      'mtp.min': 'spec_n_min',
      'mtp.pmin': 'spec_p_min',
      'mtp.imageTitle': 'Images conflict with MTP',
      'mtp.imageBody': 'This model supports images, but GenieX takes the text-only path when MTP is enabled.',
      'mtp.direct': 'Send directly',
      'mtp.directHint': 'Images will be ignored',
      'mtp.disable': 'Send without MTP',
      'mtp.disableHint': 'The model must reload',
      'mtp.cancel': 'Cancel',
      'sampling.title': 'Sampling Defaults',
      'sampling.hint': 'Filled only when the request does not already carry the field; empty omits it.',
      'sampling.recommend': 'Metadata recommendation',
      'sampling.fill': 'Fill recommended',
      'sampling.none': 'No model currently exposes recommended sampling',
      'sampling.recommendHint': 'Read from GGUF general.sampling.*; save after filling.',
      'temperature.label': 'temperature',
      'topP.label': 'top_p',
      'topK.label': 'top_k',
      'minP.label': 'min_p',
      'repetitionPenalty.label': 'repetition_penalty',
      'presencePenalty.label': 'presence_penalty',
      'frequencyPenalty.label': 'frequency_penalty',
      'save': 'Save and apply',
      'saving': 'Saving…',
      'loadFailed': 'Cannot read settings: {message}',
      'saveFailed': 'Action failed: {message}',
      'numberInvalid': '{field} must be a number or empty',
      'footer.hint': 'Saving rebuilds the provider and model catalog; switching sources removes the other provider.',
      'stats.ttft': 'TTFT: {value}',
      'stats.tps': '{value} tok/s',
      'stats.ms': '{value} ms',
      'stats.sec': '{value} s',
    }

    function format(template, params) {
      return String(template).replace(/\{(\w+)\}/g, (match, key) => (
        params !== undefined && Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : match
      ))
    }

    function apiBase() {
      const location = globalThis.location
      if (location !== undefined && /^https?:$/.test(location.protocol)) return location.origin
      return ''
    }

    async function call(method, payload, options) {
      const response = await fetch(`${apiBase()}${API}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload ?? {}),
        signal: options?.signal,
      })
      const body = await response.json().catch(() => undefined)
      if (!response.ok || body?.ok !== true) throw new Error(body?.error?.message ?? `HTTP ${response.status}`)
      return body.value
    }

    const warmState = {
      states: new Map(),
      enabled: false,
      revision: 0,
      listeners: new Set(),
      timer: null,
      subscribers: 0,
      refreshing: false,
      async refresh() {
        if (warmState.refreshing) return
        warmState.refreshing = true
        try {
          const status = await call('modelStatus', undefined, { signal: AbortSignal.timeout(3000) })
          warmState.states = new Map(Object.entries(status?.states ?? {}))
          warmState.enabled = status?.active === true
          warmState.revision = Number.isSafeInteger(status?.revision) ? status.revision : 0
        } catch {
          warmState.states = new Map()
          warmState.enabled = false
        }
        warmState.refreshing = false
        for (const listener of warmState.listeners) {
          try {
            listener()
          } catch {
            // A label can unmount between refresh and notification.
          }
        }
      },
      subscribe(listener) {
        warmState.listeners.add(listener)
        warmState.subscribers += 1
        if (warmState.subscribers === 1) {
          void warmState.refresh()
          warmState.timer = window.setInterval(() => void warmState.refresh(), 2500)
        }
        listener()
        return () => {
          warmState.listeners.delete(listener)
          warmState.subscribers -= 1
          if (warmState.subscribers === 0 && warmState.timer !== null) {
            window.clearInterval(warmState.timer)
            warmState.timer = null
          }
        }
      },
    }

    const modelMetaState = {
      models: new Map(),
      listeners: new Set(),
      timer: null,
      subscribers: 0,
      refreshing: false,
      async refresh() {
        if (modelMetaState.refreshing) return
        modelMetaState.refreshing = true
        try {
          const info = await call('modelInfo', undefined, { signal: AbortSignal.timeout(5000) })
          modelMetaState.models = new Map(Object.entries(info?.models ?? {}))
        } catch {
          // Model metadata is optional; keep the last successful snapshot.
        }
        modelMetaState.refreshing = false
        for (const listener of modelMetaState.listeners) {
          try {
            listener()
          } catch {
            // A label can unmount between refresh and notification.
          }
        }
      },
      subscribe(listener) {
        modelMetaState.listeners.add(listener)
        modelMetaState.subscribers += 1
        if (modelMetaState.subscribers === 1) {
          void modelMetaState.refresh()
          modelMetaState.timer = window.setInterval(() => void modelMetaState.refresh(), 5000)
        }
        listener()
        return () => {
          modelMetaState.listeners.delete(listener)
          modelMetaState.subscribers -= 1
          if (modelMetaState.subscribers === 0 && modelMetaState.timer !== null) {
            window.clearInterval(modelMetaState.timer)
            modelMetaState.timer = null
          }
        }
      },
    }

    function QwenGlyph({ size = 18 }) {
      return h('svg', {
        viewBox: '0 0 24 24',
        width: size,
        height: size,
        'aria-hidden': true,
        style: { display: 'block', flex: '0 0 auto' },
      }, [
        h('path', { key: 'a', d: 'M5 18V7l7 7 7-7v11', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' }),
        h('circle', { key: 'b', cx: 19, cy: 5, r: 2, fill: 'currentColor' }),
      ])
    }

    /** Model name that marquees only while hovered and only when it overflows. */
    function ModelName({ name, marquee, color }) {
      const outerRef = React.useRef(null)
      const innerRef = React.useRef(null)
      const [hovered, setHovered] = React.useState(false)
      const [distance, setDistance] = React.useState(0)
      const measure = () => {
        const outer = outerRef.current
        const inner = innerRef.current
        if (outer === null || inner === null) return
        const previous = inner.style.maxWidth
        inner.style.maxWidth = 'none'
        setDistance(Math.max(0, inner.scrollWidth - outer.clientWidth))
        inner.style.maxWidth = previous
      }
      if (!marquee) return h('span', { style: { ...S.modelName, color }, title: name }, name)
      const reduceMotion = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
      const duration = Math.max(4, Math.min(12, distance / 25))
      return h('span', {
        ref: outerRef,
        style: { ...S.modelName, color, display: 'inline-block', maxWidth: '100%' },
        onMouseEnter: () => {
          setHovered(true)
          measure()
        },
        onMouseLeave: () => setHovered(false),
      }, h('span', {
        ref: innerRef,
        style: {
          display: 'inline-block',
          maxWidth: hovered && !reduceMotion ? 'none' : '100%',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          animation: hovered && distance > 0 && !reduceMotion
            ? `qwen-model-name-marquee ${duration}s linear infinite alternate`
            : 'none',
          '--qwen-model-name-distance': `${distance}px`,
        },
      }, name))
    }

    /**
     * Inline model label for the composer model selector. The slot replaces the
     * built-in name + badge, so render both; GenieX models gain a quantization
     * tag derived from their `:Q4_0` suffix.
     */
    function ModelLabel({ provider, model, placement, selected, sessionId, getLocale }) {
      const [warmEnabled, setWarmEnabled] = React.useState(false)
      const [residentState, setResidentState] = React.useState('')
      const [warmRevision, setWarmRevision] = React.useState(warmState.revision)
      const [modelMeta, setModelMeta] = React.useState(null)
      React.useEffect(() => {
        const update = () => {
          setWarmEnabled((current) => current === warmState.enabled ? current : warmState.enabled)
          setWarmRevision((current) => current === warmState.revision ? current : warmState.revision)
          if (placement === 'option' && provider?.id === 'from-geniex' && typeof model?.id === 'string') {
            const next = warmState.states.get(model.id) ?? ''
            setResidentState((current) => current === next ? current : next)
          }
        }
        return warmState.subscribe(update)
      }, [placement, provider?.id, model?.id])
      React.useEffect(() => {
        if (provider?.id !== 'from-geniex' || typeof model?.id !== 'string') return undefined
        return modelMetaState.subscribe(() => {
          setModelMeta(modelMetaState.models.get(model.id) ?? null)
        })
      }, [provider?.id, model?.id])
      React.useEffect(() => {
        if (placement !== 'trigger' || !selected) return
        const key = sessionId ?? 'global'
        const selectedModel = provider?.id === 'from-geniex' && typeof model?.id === 'string' ? model.id : null
        preheat.setSelected(key, selectedModel)
        selectedMtp.model = selectedModel ?? ''
        const previousProvider = lastProvider.get(key)
        lastProvider.set(key, provider?.id)
        if (previousProvider !== undefined && previousProvider !== provider?.id) {
          for (const cooldownKey of [...lastWarmAt.keys()]) {
            if (cooldownKey.startsWith(`${key}\u0000`)) lastWarmAt.delete(cooldownKey)
          }
        }
        if (selectedModel === null) {
          return
        }
        const modelId = selectedModel
        const previous = warmChain.get(key) ?? Promise.resolve()
        const job = previous.then(async () => {
          if (preheat.bootDelay === null) {
            preheat.bootDelay = new Promise((resolve) => setTimeout(resolve, 500))
          }
          await preheat.bootDelay
          if (preheat.ready !== null) await preheat.ready
          if (preheat.selected.get(key) !== modelId) return
          if (!preheat.enabled) return
          const loaded = warmState.states.has(modelId)
          const modelKey = `${key}\u0000${modelId}`
          if (loaded && lastWarm.get(key) === modelId && lastWarmRevision.get(modelKey) === warmRevision) return
          if (loaded && lastWarmRevision.get(modelKey) === warmRevision && Date.now() - (lastWarmAt.get(modelKey) ?? 0) < 15000) return
          lastWarm.set(key, modelId)
          lastWarmRevision.set(modelKey, warmRevision)
          lastWarmAt.set(modelKey, Date.now())
          preheat.begin(modelKey)
          try {
            await call('warm', { model: modelId })
          } catch {
            lastWarm.delete(key)
          } finally {
            preheat.end(modelKey)
          }
        })
        warmChain.set(key, job.catch(() => {}))
        void job
      }, [placement, selected, provider?.id, model?.id, sessionId, warmRevision])

      const name = model?.name ?? model?.id ?? ''
      const dotKind = !warmEnabled || placement !== 'option'
        ? null
        : provider?.id === 'from-geniex'
          ? (residentState === 'loading' ? 'yellow' : residentState === 'active' || residentState === 'idle' ? 'green' : 'red')
          : 'blue'
      const warmZh = String(getLocale?.() ?? '').startsWith('zh')
      const dotTitle = dotKind === null
        ? ''
        : warmZh
          ? (dotKind === 'yellow' ? '正在预热' : dotKind === 'green' ? '已预热' : dotKind === 'red' ? '未预热' : '无需预热')
          : (dotKind === 'yellow' ? 'Warming up' : dotKind === 'green' ? 'Warmed' : dotKind === 'red' ? 'Not warmed' : 'No warmup needed')
      const dotFill = dotKind === 'green'
        ? 'var(--dsw-alias-state-success-primary)'
        : dotKind === 'yellow'
          ? 'var(--dsw-alias-state-warn-primary)'
          : dotKind === 'red'
            ? 'var(--dsw-alias-state-error-primary)'
            : '#ADD8E6'
      const warmDot = dotKind === null
        ? null
        : h('span', {
          key: 'warm',
          title: dotTitle,
          style: {
            width: '7px',
            height: '7px',
            flex: '0 0 7px',
            alignSelf: 'center',
            marginLeft: 'auto',
            marginRight: '2px',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            lineHeight: 0,
          },
        }, h('svg', {
          key: 'circle',
          viewBox: '0 0 7 7',
          width: 7,
          height: 7,
          'aria-hidden': true,
          style: { display: 'block', flex: '0 0 7px' },
        }, h('circle', { cx: 3.5, cy: 3.5, r: 3.5, fill: dotFill })))
      const badges = []
      if (provider?.id === 'from-geniex' && typeof model?.id === 'string') {
        const match = /:([^:/\s]+)$/u.exec(model.id)
        if (match !== null) {
          badges.push(h('span', {
            key: 'quant',
            style: { ...S.modelBadge, color: 'var(--dsw-alias-brand-primary)', borderColor: 'var(--dsw-alias-brand-primary)' },
            title: model.id,
          }, match[1]))
        }
      }
      if (model?.badge !== undefined && model.badge !== null) {
        const text = typeof model.badge.text === 'string'
          ? model.badge.text
          : model.badge.text?.[getLocale?.() ?? 'en'] ?? model.badge.text?.en
        if (typeof text === 'string' && text !== '') {
          const tone = model.badge.tone
          const color = tone === 'info'
            ? 'var(--dsw-alias-brand-primary)'
            : tone === 'success'
              ? 'var(--dsw-alias-state-success-primary)'
              : tone === 'warning'
                ? 'var(--dsw-alias-state-warn-primary)'
                : 'var(--dsw-alias-label-secondary)'
          badges.push(h('span', {
            key: 'catalog',
            style: { ...S.modelBadge, color, borderColor: color },
          }, text))
        }
      }
      if (provider?.id === 'from-geniex' && modelMeta?.mtpStats !== null && modelMeta?.mtpStats !== undefined) {
        const stats = modelMeta.mtpStats
        if (typeof stats.rate === 'number' && Number.isFinite(stats.rate)) {
          const color = stats.rate >= 0.5
            ? 'var(--dsw-alias-state-success-primary)'
            : 'var(--dsw-alias-state-warn-primary)'
          badges.push(h('span', {
            key: 'mtp',
            style: { ...S.modelBadge, color, borderColor: color },
            title: `${stats.accepted ?? 0} accepted / ${stats.rejected ?? 0} rejected`,
          }, `MTP ${Math.round(stats.rate * 100)}%`))
        }
      }
      const abliterated = modelMeta?.abliterated === true
      const nameNode = h(ModelName, {
        key: 'name',
        name,
        marquee: placement === 'option',
        color: abliterated ? 'var(--dsw-alias-state-warn-primary)' : undefined,
      })
      const parts = placement === 'trigger'
        ? [...badges, nameNode]
        : [nameNode, ...badges]
      if (warmDot !== null) parts.push(warmDot)
      const labelStyle = placement === 'option' ? { ...S.modelLabel, width: '100%' } : S.modelLabel
      return h('span', { style: labelStyle }, parts)
    }

    /** Insert per-turn model/TTFT/TPS into the finalized assistant action row. */
    function TurnStats({ turn, sessionId, t }) {
      const turnNumber = Number(turn?.turn ?? turn?.number ?? turn?.index ?? turn)
      const [stats, setStats] = React.useState(null)
      React.useEffect(() => {
        if (!Number.isInteger(turnNumber)) return
        let alive = true
        void call('turnStats', { sessionId, turn: turnNumber }).then((value) => {
          if (alive) setStats(value)
        }).catch(() => {})
        return () => {
          alive = false
        }
      }, [sessionId, turnNumber])

      React.useEffect(() => {
        if (stats === null || stats === undefined || typeof document === 'undefined') return
        const model = String(stats.model ?? '').split('/').pop().replace(/:[^:]+$/u, '')
        const ttft = stats.ttftMs < 1000
          ? t('stats.ms', { value: stats.ttftMs })
          : t('stats.sec', { value: (stats.ttftMs / 1000).toFixed(1) })
        const span = document.createElement('span')
        span.setAttribute('data-qwen-turn-stats', '')
        span.style.cssText = 'display:inline-flex;align-items:center;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:1.5;white-space:nowrap;'
        const appendPart = (text, color) => {
          const part = document.createElement('span')
          part.textContent = text
          if (color !== undefined) part.style.color = color
          span.appendChild(part)
        }
        const appendSeparator = () => {
          const separator = document.createElement('span')
          separator.textContent = '·'
          separator.style.cssText = 'margin:0 6px;color:var(--dsw-alias-label-tertiary);'
          span.appendChild(separator)
        }
        appendPart(model, 'var(--dsw-alias-label-primary)')
        appendSeparator()
        appendPart(t('stats.ttft', { value: ttft }))
        if (stats.tps !== null) {
          appendSeparator()
          appendPart(t('stats.tps', { value: stats.tps }))
        }
        let hiddenClock = null
        let timePart = null
        const findEndInfo = () => {
          const row = [...document.querySelectorAll('[data-turn-tail]')]
            .find((element) => element.getAttribute('data-turn-tail') === String(turnNumber))
          return row?.querySelector('[class*="endInfo"]') ?? null
        }
        const endInfo = findEndInfo()
        if (endInfo === null) return
        const place = () => {
          const clock = endInfo.querySelector('[class*="timeEnd"]') ?? endInfo.lastElementChild
          const timeText = clock?.textContent?.trim() ?? ''
          if (timeText !== '') {
            if (timePart === null) {
              appendSeparator()
              timePart = document.createElement('span')
              span.appendChild(timePart)
            }
            timePart.textContent = timeText
          }
          if (clock !== null && clock !== timePart) {
            hiddenClock = clock
            clock.style.display = 'none'
          }
          if (!span.isConnected) endInfo.insertBefore(span, clock)
        }
        place()
        const observer = new MutationObserver(place)
        observer.observe(endInfo, { childList: true })
        return () => {
          observer.disconnect()
          span.remove()
          if (hiddenClock !== null) hiddenClock.style.display = ''
        }
      }, [stats, turnNumber, t])
      return null
    }

    /** Replaces the send button with a spinner while a warmup request is in flight. */
    function PreheatOverlay(props) {
      const sessionId = props.sessionId ?? 'global'
      const [active, setActive] = React.useState(() => preheat.isActive(sessionId))
      React.useEffect(() => preheat.subscribe(() => setActive(preheat.isActive(sessionId))), [sessionId])
      React.useEffect(() => {
        syncSendWarm(active)
        return () => syncSendWarm(false)
      }, [active])
      return null
    }

    /** Remove icon artifacts left by earlier versions. */
    function cleanupReplyIconArtifacts() {
      if (typeof document === 'undefined') return
      document.getElementById('qwen-reply-only-icon')?.remove()
      for (const element of document.querySelectorAll('[data-qwen-reply-icon]')) {
        if (element.tagName === 'SPAN' && element.querySelector('svg') !== null) element.remove()
        else element.removeAttribute('data-qwen-reply-icon')
      }
    }

    /**
     * The permission picker only owns SVGs for shipped preset values. Add the
     * same 14px currentColor outline icon for the custom reply-only label in the
     * trigger, popup menu, and settings select.
     */
    function installReplyOnlyIcon() {
      if (typeof document === 'undefined') return () => {}
      cleanupReplyIconArtifacts()
      let alignStyle = document.getElementById('qwen-permission-align')
      if (alignStyle === null) {
        alignStyle = document.createElement('style')
        alignStyle.id = 'qwen-permission-align'
        document.head.appendChild(alignStyle)
      }
      alignStyle.textContent = 'button[role="option"]{align-items:center!important}button[role="option"]>span[aria-hidden="true"]{display:inline-flex!important;align-items:center!important;justify-content:center!important;width:14px!important;height:20px!important;flex:0 0 14px!important}button[role="option"]>span[aria-hidden="true"] svg{display:block;width:14px;height:14px}button[role="option"]>span[class*="itemName"]{display:flex!important;align-items:center!important;line-height:20px}[data-qwen-reply-icon]{height:20px!important;min-height:20px!important;align-self:center!important;transform:none!important}[class*="triggerLabel"]{display:inline-flex;align-items:center}[class*="triggerIcon"]{display:inline-flex;align-items:center;justify-content:center}button:has([data-provider-id])>[class*="triggerIcon"]{display:none!important}button:has([data-provider-id])>[class*="triggerLabel"],button:has([data-provider-id])>[class*="triggerEffort"]{display:inline-flex!important;align-items:center!important;height:20px!important;line-height:20px!important}button:has([data-provider-id])>[class*="triggerLabel"]>span[data-provider-id]{display:inline-flex!important;align-items:center!important;height:20px!important;line-height:20px!important}'
      const createIcon = () => {
        const span = document.createElement('span')
        span.setAttribute('data-qwen-reply-icon', '')
        span.setAttribute('aria-hidden', 'true')
        span.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;flex:0 0 14px;width:14px;height:14px;min-width:14px;min-height:14px;color:var(--dsw-alias-menu-icon);'
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
        svg.setAttribute('viewBox', '0 0 16 16')
        svg.setAttribute('width', '14')
        svg.setAttribute('height', '14')
        svg.setAttribute('fill', 'none')
        svg.setAttribute('stroke', 'currentColor')
        svg.setAttribute('stroke-width', '1')
        svg.style.cssText = 'display:block;width:14px;height:14px;flex:none;'
        for (const d of [
          'M5 6.75H11',
          'M5 9H8',
          'M2.37067 11.2497C1.5872 9.89252 1.32042 8.29798 1.61945 6.7597C1.91847 5.22141 2.76317 3.84293 3.99801 2.87809C5.23285 1.91325 6.7747 1.427 8.33964 1.50888C9.90458 1.59076 11.3873 2.23526 12.5147 3.32369C13.6422 4.41232 14.3384 5.8717 14.4751 7.43304C14.6118 8.99438 14.1797 10.5525 13.2585 11.8205C12.3372 13.0885 10.9889 13.9809 9.4617 14.3334C8.18666 14.6277 6.8587 14.529 5.64964 14.0601C5.17095 13.8745 4.76937 13.4929 4.26509 13.3963C3.67389 13.2832 2.95232 13.5595 2.0377 14.3334',
        ]) {
          const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
          path.setAttribute('d', d)
          svg.appendChild(path)
        }
        span.appendChild(svg)
        return span
      }
      const hasReplyLabel = (host) => [...host.childNodes].some((node) =>
        node.nodeType === Node.TEXT_NODE && REPLY_LABELS.has(node.nodeValue?.trim() ?? ''))
      const guardIcon = (host, icon) => {
        const guard = new MutationObserver(() => {
          if (!host.isConnected || !hasReplyLabel(host)) {
            icon.remove()
            guard.disconnect()
          }
        })
        guard.observe(host, { childList: true, characterData: true, subtree: true })
      }
      const scan = () => {
        if (document.body === null) return
        for (const icon of document.querySelectorAll('[data-qwen-reply-icon]')) {
          const host = icon.parentElement
          if (host === null) continue
          if (!hasReplyLabel(host)) icon.remove()
        }
        const seen = new Set()
        for (const button of document.querySelectorAll('button[role="option"], button')) {
          const walker = document.createTreeWalker(button, NodeFilter.SHOW_TEXT)
          for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
            const text = node.nodeValue?.trim()
            if (text === undefined || !REPLY_LABELS.has(text)) continue
            const label = node.parentElement
            const host = label?.parentElement
            if (label === null || label === undefined || host === null || host === undefined) continue
            if (seen.has(host) || host.querySelector('[data-qwen-reply-icon]') !== null) continue
            seen.add(host)
            const icon = createIcon()
            host.insertBefore(icon, label)
            guardIcon(host, icon)
          }
        }
      }
      let scheduled = false
      const schedule = () => {
        if (scheduled) return
        scheduled = true
        requestAnimationFrame(() => {
          scheduled = false
          scan()
        })
      }
      const observer = new MutationObserver(schedule)
      if (document.body === null) return () => observer.disconnect()
      observer.observe(document.body, { childList: true, subtree: true })
      scan()
      return () => observer.disconnect()
    }

    const S = {
      root: { padding: '24px 24px 32px', boxSizing: 'border-box', color: 'var(--dsw-alias-label-primary)' },
      page: { maxWidth: '720px', margin: '0 auto', display: 'flex', flexDirection: 'column', gap: '14px' },
      header: { display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', justifyContent: 'space-between', gap: '16px' },
      headerText: { display: 'flex', gap: '10px', alignItems: 'flex-start', minWidth: 0, flex: '1 1 auto' },
      copy: { minWidth: 0 },
      title: { margin: 0, fontSize: '20px', lineHeight: 1.25, fontWeight: 600 },
      subtitle: { color: 'var(--dsw-alias-label-secondary)', fontSize: '12px', marginTop: '4px', lineHeight: 1.5 },
      modeGroup: { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '5px', flex: '0 0 auto' },
      segments: { display: 'inline-flex', padding: '2px', gap: '2px', borderRadius: '8px', border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-layer-1)' },
      segment: { border: 'none', background: 'transparent', color: 'var(--dsw-alias-label-secondary)', borderRadius: '6px', padding: '5px 9px', fontSize: '11px', cursor: 'pointer', whiteSpace: 'nowrap' },
      segmentActive: { border: 'none', background: 'var(--dsw-alias-brand-primary)', color: 'var(--dsw-alias-label-primary-inverted)', borderRadius: '6px', padding: '5px 9px', fontSize: '11px', cursor: 'pointer', whiteSpace: 'nowrap' },
      modelLabel: { display: 'inline-flex', alignItems: 'center', gap: '4px', minWidth: 0, maxWidth: '100%', height: '20px', verticalAlign: 'middle' },
      modelName: { display: 'inline-flex', alignItems: 'center', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, height: '18px', lineHeight: '18px' },
      modelBadge: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flex: '0 0 auto', height: '18px', boxSizing: 'border-box', padding: '0 5px', borderRadius: '999px', border: '1px solid var(--dsw-alias-border-l1)', background: 'transparent', fontSize: '9px', lineHeight: '18px', fontWeight: 500, whiteSpace: 'nowrap', alignSelf: 'center' },
      checkRow: { display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--dsw-alias-label-primary)', fontSize: '12px', cursor: 'pointer' },
      banner: { padding: '9px 11px', borderRadius: '8px', border: '1px solid var(--dsw-alias-state-error-primary)', color: 'var(--dsw-alias-state-error-primary)', background: 'var(--dsw-alias-bg-layer-1)', fontSize: '12px', overflowWrap: 'anywhere' },
      card: { display: 'flex', flexDirection: 'column', gap: '10px', padding: '14px', borderRadius: '10px', border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-layer-1)' },
      cardHeader: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' },
      cardTitle: { fontSize: '13px', fontWeight: 600 },
      configSection: { display: 'flex', flexDirection: 'column', gap: '6px' },
      configHeading: { fontSize: '12px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
      divider: { height: '1px', background: 'var(--dsw-alias-border-l1)', margin: '2px 0' },
      hint: { color: 'var(--dsw-alias-label-secondary)', fontSize: '11px', lineHeight: 1.5 },
      modelList: { color: 'var(--dsw-alias-label-secondary)', fontSize: '11px', lineHeight: 1.5, overflowWrap: 'anywhere' },
      grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '10px' },
      field: { display: 'flex', flexDirection: 'column', gap: '4px', minWidth: 0 },
      label: { color: 'var(--dsw-alias-label-secondary)', fontSize: '11px' },
      input: { width: '100%', boxSizing: 'border-box', borderRadius: '7px', border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)', padding: '7px 9px', fontSize: '12px', outline: 'none' },
      select: { width: '100%', boxSizing: 'border-box', borderRadius: '7px', border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)', padding: '7px 9px', fontSize: '12px', outline: 'none' },
      row: { display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 },
      code: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', borderRadius: '7px', border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-secondary)', padding: '6px 8px', fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace', fontSize: '11px' },
      button: { border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)', borderRadius: '7px', padding: '6px 10px', fontSize: '12px', cursor: 'pointer', whiteSpace: 'nowrap' },
      primary: { border: 'none', background: 'var(--dsw-alias-brand-primary)', color: 'var(--dsw-alias-label-primary-inverted)', borderRadius: '7px', padding: '9px 16px', fontSize: '13px', cursor: 'pointer', whiteSpace: 'nowrap' },
      badge: { display: 'inline-flex', alignItems: 'center', padding: '2px 7px', borderRadius: '999px', fontSize: '10px', border: '1px solid var(--dsw-alias-border-l1)', color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'nowrap' },
      badgeOn: { display: 'inline-flex', alignItems: 'center', padding: '2px 7px', borderRadius: '999px', fontSize: '10px', border: '1px solid var(--dsw-alias-state-success-primary)', color: 'var(--dsw-alias-state-success-primary)', whiteSpace: 'nowrap' },
      footer: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', paddingTop: '2px' },
      footerHint: { color: 'var(--dsw-alias-label-secondary)', fontSize: '11px', lineHeight: 1.45 },
      details: { borderTop: '1px solid var(--dsw-alias-border-l1)', paddingTop: '8px' },
      summary: { cursor: 'pointer', color: 'var(--dsw-alias-label-secondary)', fontSize: '11px' },
    }

    /** Per-session model already warmed; re-selecting the same model is a no-op. */
    const lastWarm = new Map()
    const lastProvider = new Map()
    const lastWarmAt = new Map()
    const lastWarmRevision = new Map()
    const warmChain = new Map()
    const selectedMtp = { model: '' }

    /** Replace the composer send button with a spinner while warmup is active. */
    const sendWarm = {
      button: null,
      spinner: null,
      timer: null,
      style: null,
    }
    const SEND_LABELS = new Set(['发送消息', 'Send message', '发送', 'Send'])
    const REPLY_LABELS = new Set(['仅回复', 'Reply Only'])
    function clearSendWarm() {
      if (sendWarm.timer !== null) {
        clearInterval(sendWarm.timer)
        sendWarm.timer = null
      }
      if (sendWarm.spinner !== null) {
        sendWarm.spinner.remove()
        sendWarm.spinner = null
      }
      if (sendWarm.button !== null) {
        sendWarm.button.style.display = ''
        sendWarm.button.removeAttribute('data-qwen-warm-hidden')
        sendWarm.button = null
      }
    }
    function findSendButton() {
      for (const button of document.querySelectorAll('button[aria-label]')) {
        const label = button.getAttribute('aria-label')
        if (label === null || !SEND_LABELS.has(label.trim())) continue
        if (!String(button.className).includes('_primary')) continue
        return button
      }
      return null
    }

    /** Force a choice before a VLM image send that would otherwise ignore the images under MTP. */
    function installMtpSendGuard(t) {
      if (typeof document === 'undefined') return () => {}
      const panel = { node: null, busy: false }
      const imageSelectors = ['[data-attachment-kind="image"]', '[class*="rail"] img', '[class*="attachment"] img', '[class*="imagePreview"]', '[class*="image-preview"]']
      const composerHasImages = (button) => {
        let node = button.parentElement
        let root = null
        for (let depth = 0; depth < 10 && node !== null; depth += 1) {
          if (node.querySelector('[contenteditable="true"]') !== null) {
            root = node
            break
          }
          node = node.parentElement
        }
        root ??= button.parentElement?.parentElement ?? null
        if (root === null) return false
        if (root.querySelector('img') !== null) return true
        const outer = root.parentElement
        if (outer !== null && outer.querySelector('[class*="rail"] img, [class*="attachment"] img') !== null) return true
        return imageSelectors.some((selector) => root.querySelector(selector) !== null)
      }
      const close = () => {
        if (panel.node !== null) panel.node.remove()
        panel.node = null
        panel.busy = false
      }
      const open = (button, model) => {
        if (panel.node !== null) return
        const rect = button.getBoundingClientRect()
        const node = document.createElement('div')
        node.setAttribute('data-qwen-mtp-choice', '')
        node.style.cssText = [
          'position:fixed',
          `right:${Math.max(12, window.innerWidth - rect.right)}px`,
          `bottom:${Math.max(12, window.innerHeight - rect.top + 8)}px`,
          'width:min(300px,calc(100vw - 24px))',
          'z-index:2147483000',
          'display:flex',
          'flex-direction:column',
          'gap:8px',
          'padding:12px',
          'border-radius:10px',
          'border:1px solid var(--dsw-alias-border-l2)',
          'background:var(--dsw-alias-bg-overlay)',
          'color:var(--dsw-alias-label-primary)',
          'box-shadow:var(--dsw-elevation-prominent)',
          'font-size:12px',
        ].join(';')
        const title = document.createElement('div')
        title.textContent = t('mtp.imageTitle')
        title.style.cssText = 'font-weight:600;font-size:13px;'
        const body = document.createElement('div')
        body.textContent = t('mtp.imageBody')
        body.style.cssText = 'color:var(--dsw-alias-label-secondary);line-height:1.5;'
        const option = (label, hint, disabledHint, allow) => {
          const buttonNode = document.createElement('button')
          buttonNode.type = 'button'
          buttonNode.style.cssText = 'appearance:none;text-align:left;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:7px;padding:7px 9px;cursor:pointer;font:inherit;'
          const strong = document.createElement('div')
          strong.textContent = label
          strong.style.cssText = 'font-weight:500;'
          const note = document.createElement('div')
          note.textContent = allow === true ? hint : disabledHint
          note.style.cssText = 'color:var(--dsw-alias-label-secondary);font-size:11px;margin-top:2px;'
          buttonNode.append(strong, note)
          buttonNode.onclick = async () => {
            if (panel.busy) return
            panel.busy = true
            buttonNode.disabled = true
            try {
              await call('mtpChoice', { model, allow }, { signal: AbortSignal.timeout(5000) })
            } catch (error) {
              body.textContent = String(error?.message ?? error)
              buttonNode.disabled = false
              panel.busy = false
              return
            }
            close()
            mtpGuardBypass = true
            button.click()
            setTimeout(() => { mtpGuardBypass = false }, 0)
          }
          return buttonNode
        }
        const cancel = document.createElement('button')
        cancel.type = 'button'
        cancel.textContent = t('mtp.cancel')
        cancel.style.cssText = 'appearance:none;border:none;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;cursor:pointer;padding:2px 0;align-self:flex-end;'
        cancel.onclick = close
        node.append(title, body, option(t('mtp.direct'), t('mtp.directHint'), '', true), option(t('mtp.disable'), '', t('mtp.disableHint'), false), cancel)
        document.body.appendChild(node)
        panel.node = node
      }

      let mtpGuardBypass = false
      const onClick = (event) => {
        const button = findSendButton()
        if (button === null || !(event.target instanceof Node) || !button.contains(event.target)) return
        if (mtpGuardBypass) {
          mtpGuardBypass = false
          return
        }
        const model = selectedMtp.model
        if (model === '') return
        const meta = modelMetaState.models.get(model)
        if (meta?.vision !== true || meta.mtpReady !== true || meta.mtpEnabled !== true) return
        if (!composerHasImages(button)) return
        event.preventDefault()
        event.stopImmediatePropagation()
        open(button, model)
      }
      const onKeyDown = (event) => {
        if (event.key === 'Escape') close()
      }
      document.addEventListener('click', onClick, true)
      document.addEventListener('keydown', onKeyDown)
      return () => {
        close()
        document.removeEventListener('click', onClick, true)
        document.removeEventListener('keydown', onKeyDown)
      }
    }
    function showSendWarm() {
      if (sendWarm.spinner !== null) return
      if (sendWarm.style === null && typeof document !== 'undefined') {
        sendWarm.style = document.createElement('style')
        sendWarm.style.id = 'qwen-send-warm-style'
        sendWarm.style.textContent = '@keyframes qwen-send-spin{to{transform:rotate(360deg)}}'
        document.head.appendChild(sendWarm.style)
      }
      const button = findSendButton()
      if (button === null) {
        sendWarm.timer = setTimeout(showSendWarm, 120)
        return
      }
      const spinner = document.createElement('span')
      spinner.setAttribute('data-qwen-send-spinner', '')
      spinner.setAttribute('role', 'status')
      spinner.setAttribute('aria-label', 'Warming model')
      spinner.style.cssText = 'display:inline-grid;place-items:center;width:34px;height:34px;flex:none;border-radius:999px;color:#fff;background:var(--dsw-alias-button-info-fill);transform:translateY(-2px);'
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
      svg.setAttribute('viewBox', '0 0 16 16')
      svg.setAttribute('width', '16')
      svg.setAttribute('height', '16')
      svg.setAttribute('aria-hidden', 'true')
      svg.style.cssText = 'display:block;animation:qwen-send-spin .8s linear infinite;'
      const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle')
      circle.setAttribute('cx', '8')
      circle.setAttribute('cy', '8')
      circle.setAttribute('r', '6')
      circle.setAttribute('fill', 'none')
      circle.setAttribute('stroke', 'currentColor')
      circle.setAttribute('stroke-opacity', '0.35')
      circle.setAttribute('stroke-width', '2')
      const arc = document.createElementNS('http://www.w3.org/2000/svg', 'path')
      arc.setAttribute('d', 'M8 2a6 6 0 0 1 6 6')
      arc.setAttribute('fill', 'none')
      arc.setAttribute('stroke', 'currentColor')
      arc.setAttribute('stroke-width', '2')
      arc.setAttribute('stroke-linecap', 'round')
      svg.appendChild(circle)
      svg.appendChild(arc)
      spinner.appendChild(svg)
      button.style.display = 'none'
      button.setAttribute('data-qwen-warm-hidden', '')
      button.insertAdjacentElement('afterend', spinner)
      sendWarm.button = button
      sendWarm.spinner = spinner
      sendWarm.timer = setInterval(() => {
        if (sendWarm.spinner !== null && sendWarm.spinner.isConnected && sendWarm.button?.isConnected) return
        sendWarm.spinner?.remove()
        sendWarm.spinner = null
        sendWarm.button = null
        showSendWarm()
      }, 300)
    }
    function syncSendWarm(active) {
      if (typeof document === 'undefined') return
      if (active) showSendWarm()
      else clearSendWarm()
    }
    const preheat = {
      enabled: false,
      ready: null,
      bootDelay: null,
      active: new Map(),
      selected: new Map(),
      listeners: new Set(),
      subscribe(listener) {
        preheat.listeners.add(listener)
        return () => preheat.listeners.delete(listener)
      },
      setSelected(sessionId, modelId) {
        if (modelId === null) preheat.selected.delete(sessionId)
        else preheat.selected.set(sessionId, modelId)
        for (const listener of preheat.listeners) listener()
      },
      isActive(sessionId) {
        const modelId = preheat.selected.get(sessionId)
        return modelId !== undefined && (preheat.active.get(`${sessionId}\u0000${modelId}`) ?? 0) > 0
      },
      begin(key) {
        preheat.active.set(key, (preheat.active.get(key) ?? 0) + 1)
        for (const listener of preheat.listeners) listener()
      },
      end(key) {
        const next = (preheat.active.get(key) ?? 0) - 1
        if (next > 0) preheat.active.set(key, next)
        else preheat.active.delete(key)
        for (const listener of preheat.listeners) listener()
      },
    }
    preheat.ready = call('state', undefined, { signal: AbortSignal.timeout(10000) })
      .then((next) => { preheat.enabled = next?.mode === 'auto' && next?.warm === true })
      .catch(() => {})

    function Field({ label, hint, children }) {
      return h('div', { style: S.field }, [
        h('label', { key: 'label', style: S.label }, label),
        children,
        hint === undefined ? null : h('div', { key: 'hint', style: S.hint }, hint),
      ])
    }

    function QwenModePage(props) {
      const t = typeof props.t === 'function' ? props.t : (key) => key
      const [settings, setSettings] = React.useState(null)
      const [modelInfo, setModelInfo] = React.useState(null)
      const [samplingModel, setSamplingModel] = React.useState('')
      const [error, setError] = React.useState('')
      const [busy, setBusy] = React.useState('')

      const refreshModelInfo = React.useCallback(async () => {
        try {
          setModelInfo(await call('modelInfo', undefined, { signal: AbortSignal.timeout(10000) }))
        } catch {
          // Model metadata is optional.
        }
      }, [])

      const load = React.useCallback(async () => {
        try {
          setSettings(await call('state', undefined, { signal: AbortSignal.timeout(15000) }))
          setError('')
          void refreshModelInfo()
        } catch (reason) {
          setError(format(t('loadFailed'), { message: String(reason?.message ?? reason) }))
        }
      }, [t, refreshModelInfo])

      React.useEffect(() => {
        void load()
      }, [load])

      React.useEffect(() => {
        const hasModels = modelInfo !== null && Object.keys(modelInfo.models ?? {}).length > 0
        if (hasModels) return undefined
        const timer = window.setInterval(() => void refreshModelInfo(), 3000)
        return () => window.clearInterval(timer)
      }, [modelInfo, refreshModelInfo])

      React.useEffect(() => {
        preheat.enabled = settings?.mode === 'auto' && settings?.warm === true
      }, [settings?.mode, settings?.warm])

      const update = (key, value) => setSettings((current) => current === null ? current : { ...current, [key]: value })
      const numberValue = (key) => settings?.[key] === null || settings?.[key] === undefined ? '' : String(settings[key])
      const setNumber = (key, raw) => update(key, raw)

      const action = async (name, operation) => {
        setBusy(name)
        setError('')
        try {
          const next = await operation()
          if (next !== undefined) {
            setSettings(next)
            void refreshModelInfo()
            void modelMetaState.refresh()
            void warmState.refresh()
          }
        } catch (reason) {
          setError(format(t('saveFailed'), { message: String(reason?.message ?? reason) }))
        } finally {
          setBusy('')
        }
      }

      const changeMode = (value) => {
        if (settings === null || settings.mode === value || busy !== '') return
        const previous = settings.mode
        update('mode', value)
        void action('mode', async () => {
          try {
            return await call('setMode', { mode: value })
          } catch (reason) {
            update('mode', previous)
            throw reason
          }
        })
      }

      const save = () => {
        if (settings === null) return
        const numeric = {}
        for (const key of ['contextWindow', 'maxOutputTokens', 'temperature', 'topP', 'topK', 'minP', 'repetitionPenalty', 'presencePenalty', 'frequencyPenalty', 'mtpDraftTokens', 'mtpDraftMin', 'mtpDraftPMin']) {
          const raw = settings[key]
          if (raw === null || raw === undefined || String(raw).trim() === '') {
            numeric[key] = null
            continue
          }
          const value = Number(raw)
          if (!Number.isFinite(value)) {
            setError(format(t('numberInvalid'), { field: key }))
            return
          }
          if ((key === 'contextWindow' || key === 'maxOutputTokens') && (!Number.isInteger(value) || value <= 0)) {
            setError(format(t('numberInvalid'), { field: key }))
            return
          }
          if (key.startsWith('mtp') && value < 0) {
            setError(format(t('numberInvalid'), { field: key }))
            return
          }
          numeric[key] = value
        }
        if (!settings.autoNctx && numeric.maxOutputTokens !== null) {
          const effectiveContext = numeric.contextWindow
            ?? (settings.protocol === 'qwen' ? DEFAULT_CONTEXT_WINDOW : null)
          if (effectiveContext !== null && numeric.maxOutputTokens > effectiveContext) {
            setError(t('limits.invalid'))
            return
          }
        }
        void action('save', () => call('save', {
          mode: settings.mode,
          warm: settings.warm === true,
          protocol: settings.protocol,
          upstream: settings.upstream,
          apiKeyEnv: settings.apiKeyEnv,
          autoNctx: settings.autoNctx === true,
          mtp: settings.mtp === true,
          compute: settings.protocol === 'geniex' ? String(settings.compute ?? '').trim() : '',
          vitCompute: settings.vitCompute ?? 'npu',
          ...numeric,
        }))
      }

      const samplingEntries = Object.entries(modelInfo?.models ?? {})
        .filter(([, meta]) => meta !== null && typeof meta === 'object' && meta.sampling !== null && typeof meta.sampling === 'object' && Object.keys(meta.sampling).length > 0)
      const selectedSamplingId = samplingModel !== '' && samplingEntries.some(([id]) => id === samplingModel)
        ? samplingModel
        : samplingEntries[0]?.[0] ?? ''
      const selectedSampling = selectedSamplingId === '' ? null : samplingEntries.find(([id]) => id === selectedSamplingId)?.[1]?.sampling ?? null
      const fillRecommendedSampling = () => {
        if (selectedSampling === null) return
        const numericKeys = ['temperature', 'topP', 'topK', 'minP', 'repetitionPenalty', 'presencePenalty', 'frequencyPenalty']
        setSettings((current) => {
          if (current === null) return current
          const next = { ...current }
          for (const key of numericKeys) {
            const value = selectedSampling[key]
            if (typeof value === 'number' && Number.isFinite(value)) next[key] = value
          }
          return next
        })
      }

      if (settings === null) {
        return h('div', { style: S.root }, h('div', { style: S.page }, error === '' ? '…' : h('div', { style: S.banner }, error)))
      }

      const provider = settings.provider
      const providerExists = provider !== null && provider !== undefined && provider.exists === true
      const mode = settings.mode ?? 'off'
      const models = provider?.models ?? []

      return h('div', { style: S.root }, h('div', { style: S.page }, [
        h('div', { key: 'header', style: S.header }, [
          h('div', { key: 'text', style: S.headerText }, [
            h(QwenGlyph, { key: 'icon', size: 22 }),
            h('div', { key: 'copy', style: S.copy }, [
              h('h1', { key: 'title', style: S.title }, t('section.title')),
              h('div', { key: 'subtitle', style: S.subtitle }, t('section.subtitle')),
            ]),
          ]),
          h('div', { key: 'mode', style: S.modeGroup }, [
            h('div', { key: 'segments', style: S.segments }, ['off', 'auto'].map((value) => h('button', {
              key: value,
              type: 'button',
              disabled: busy !== '',
              style: value === mode ? S.segmentActive : S.segment,
              onClick: () => changeMode(value),
            }, t(`mode.${value}`)))),
          ]),
        ]),
        error === '' ? null : h('div', { key: 'banner', style: S.banner }, error),
        settings.lastError ? h('div', { key: 'last-error', style: S.banner }, settings.lastError) : null,
        h('div', { key: 'provider', style: S.card }, [
          h('div', { key: 'header', style: S.cardHeader }, [
            h('span', { key: 'title', style: S.cardTitle }, t('provider.title')),
            h('span', { key: 'badge', style: providerExists ? S.badgeOn : S.badge }, providerExists ? t('provider.exists') : t('provider.missing')),
          ]),
          h('div', { key: 'divider', style: S.divider }),
          h('div', { key: 'grid', style: S.grid }, [
            h(Field, { key: 'name', label: t('provider.name') }, h('div', { style: S.code }, provider?.displayName ?? (settings.protocol === 'qwen' ? 'From QwenCloud' : 'From GenieX'))),
            h(Field, { key: 'baseURL', label: t('provider.baseURL') }, h('div', { style: S.code, title: provider?.baseURL ?? settings.proxyBaseURL }, provider?.baseURL || settings.proxyBaseURL)),
          ]),
          h('div', { key: 'models', style: S.modelList }, models.length === 0
            ? t('noModels')
            : format(t('provider.modelsFound'), { count: models.length, models: models.join(', ') })),
          h('div', { key: 'actions', style: S.row }, [
            h('button', {
              key: 'rebuild',
              type: 'button',
              style: S.button,
              disabled: busy !== '' || mode === 'off',
              onClick: () => void action('apply', () => call('apply')),
            }, t('provider.rebuild')),
            providerExists ? h('button', {
              key: 'remove',
              type: 'button',
              style: S.button,
              disabled: busy !== '',
              onClick: () => void action('remove', () => call('remove')),
            }, t('provider.remove')) : null,
          ]),
        ]),
        h('div', { key: 'source', style: S.card }, [
          h('div', { key: 'title', style: S.cardTitle }, t('source.title')),
          h('div', { key: 'divider', style: S.divider }),
          h('div', { key: 'grid', style: S.grid }, [
            h(Field, { key: 'protocol', label: t('protocol.label') }, h('select', {
              style: S.select,
              value: settings.protocol,
              onChange: (event) => update('protocol', event.target.value),
            }, [
              h('option', { key: 'geniex', value: 'geniex' }, t('protocol.geniex')),
              h('option', { key: 'qwen', value: 'qwen' }, t('protocol.qwen')),
            ])),
            h(Field, { key: 'upstream', label: t('upstream.label') }, h('input', {
              style: S.input,
              value: settings.upstream,
              onChange: (event) => update('upstream', event.target.value),
            })),
          ]),
          h('details', { key: 'advanced', style: S.details }, [
            h('summary', { key: 'summary', style: S.summary }, t('advanced')),
            h('div', { key: 'body', style: { paddingTop: '8px', display: 'flex', flexDirection: 'column', gap: '10px' } }, [
              h(Field, {
                key: 'apiKeyEnv',
                label: t('apiKeyEnv.label'),
              }, h('input', {
                style: S.input,
                value: settings.apiKeyEnv,
                placeholder: t('apiKeyEnv.placeholder'),
                onChange: (event) => update('apiKeyEnv', event.target.value),
              })),
              h('label', { key: 'warm', style: S.checkRow }, [
                h('input', {
                  key: 'checkbox',
                  type: 'checkbox',
                  checked: settings.warm === true,
                  onChange: (event) => update('warm', event.target.checked),
                }),
                h('span', { key: 'label' }, t('warm.label')),
              ]),
              h('div', { key: 'warm-hint', style: S.hint }, t('warm.hint')),
            ]),
          ]),
        ]),
        h('div', { key: 'model-config', style: S.card }, [
          h('div', { key: 'title', style: S.cardTitle }, t('modelConfig.title')),
          h('div', { key: 'divider-top', style: S.divider }),
          h('div', { key: 'limits', style: S.configSection }, [
            h('div', { key: 'grid', style: S.grid }, [
              ...['contextWindow', 'maxOutputTokens'].map((key) => h(Field, {
                key,
                label: t(`${key}.label`),
              }, h('input', {
                key: 'input',
                style: S.input,
                inputMode: 'numeric',
                value: numberValue(key),
                placeholder: key === 'contextWindow'
                  ? settings.protocol === 'qwen' ? '262144' : t('contextWindow.geniexPlaceholder')
                  : undefined,
                onChange: (event) => setNumber(key, event.target.value),
              }))),
            ]),
            h('label', { key: 'auto-nctx', style: S.checkRow }, [
              h('input', {
                key: 'checkbox',
                type: 'checkbox',
                checked: settings.autoNctx === true,
                onChange: (event) => update('autoNctx', event.target.checked),
              }),
              h('span', { key: 'label' }, t('autoNctx.label')),
            ]),
          ]),
          h('div', { key: 'divider-sampling', style: S.divider }),
          h('div', { key: 'sampling', style: S.configSection }, [
            h('div', { key: 'heading', style: S.configHeading }, t('sampling.title')),
            h('div', { key: 'hint', style: S.hint }, t('sampling.hint')),
            h('div', { key: 'grid', style: { ...S.grid, gridTemplateColumns: 'repeat(4, minmax(0, 1fr))' } }, [
              ...['temperature', 'topP', 'topK', 'minP', 'repetitionPenalty', 'presencePenalty', 'frequencyPenalty'].map((key) => h(Field, {
                key,
                label: t(`${key}.label`),
              }, h('input', {
                key: 'input',
                style: S.input,
                inputMode: 'decimal',
                value: numberValue(key),
                onChange: (event) => setNumber(key, event.target.value),
              }))),
            ]),
            samplingEntries.length === 0 ? h('div', { key: 'recommend-none', style: S.hint }, t('sampling.none')) : h('div', { key: 'recommend-row', style: S.row }, [
              h('select', {
                key: 'recommend-select',
                style: { ...S.select, maxWidth: '320px' },
                value: selectedSamplingId,
                onChange: (event) => setSamplingModel(event.target.value),
              }, samplingEntries.map(([id]) => h('option', { key: id, value: id }, id))),
              h('button', {
                key: 'recommend-fill',
                type: 'button',
                style: S.button,
                disabled: busy !== '' || selectedSampling === null,
                onClick: fillRecommendedSampling,
              }, t('sampling.fill')),
            ]),
            h('div', { key: 'recommend-hint', style: S.hint }, t('sampling.recommendHint')),
          ]),
          settings.protocol === 'geniex' ? h('div', { key: 'inference-wrap' }, [
            h('div', { key: 'divider-inference', style: S.divider }),
            h('div', { key: 'inference', style: S.configSection }, [
              h('div', { key: 'heading', style: { ...S.configHeading, marginTop: '6px' } }, t('inference.title')),
              h('div', { key: 'grid', style: S.grid }, [
                h(Field, { key: 'compute', label: t('compute.label'), hint: t('compute.hint') }, h('input', {
                  key: 'input',
                  style: S.input,
                  list: 'qwen-compute-options',
                  value: settings.compute ?? '',
                  onChange: (event) => update('compute', event.target.value),
                })),
                h(Field, { key: 'vit', label: t('vit.label'), hint: t('vit.hint') }, h('div',
                  { style: S.segments },
                  ['cpu', 'gpu', 'npu'].map((value) => h('button', {
                    key: value,
                    type: 'button',
                    style: settings.vitCompute === value ? S.segmentActive : S.segment,
                    onClick: () => update('vitCompute', value),
                  }, t(`vit.${value}`))))),
              ]),
              h('label', { key: 'mtp', style: S.checkRow }, [
                h('input', {
                  key: 'checkbox',
                  type: 'checkbox',
                  checked: settings.mtp === true,
                  onChange: (event) => update('mtp', event.target.checked),
                }),
                h('span', { key: 'label' }, t('mtp.label')),
              ]),
              settings.mtp === true ? h('div', {
                key: 'mtp-details',
                style: { display: 'flex', flexDirection: 'column', gap: '8px' },
              }, [
                h('div', { key: 'mtp-params', style: S.grid }, [
                  ...['mtpDraftTokens', 'mtpDraftMin', 'mtpDraftPMin'].map((key, index) => h(Field, {
                    key,
                    label: t(index === 0 ? 'mtp.tokens' : index === 1 ? 'mtp.min' : 'mtp.pmin'),
                  }, h('input', {
                    key: 'input',
                    style: S.input,
                    inputMode: index === 2 ? 'decimal' : 'numeric',
                    value: numberValue(key),
                    placeholder: index === 0 ? '3' : '0',
                    onChange: (event) => setNumber(key, event.target.value),
                  }))),
                ]),
                h('div', { key: 'mtp-hint', style: S.hint }, t('mtp.hint')),
              ]) : null,
              h('datalist', { key: 'compute-options', id: 'qwen-compute-options' },
                ['cpu', 'gpu', 'npu', 'hybrid'].map((value) => h('option', { key: value, value }))),
            ]),
          ]) : null,
        ]),
        h('div', { key: 'footer', style: S.footer }, [
          h('div', { key: 'hint', style: S.footerHint }, t('footer.hint')),
          h('button', { key: 'save', type: 'button', style: S.primary, disabled: busy !== '', onClick: save },
            busy === 'save' ? t('saving') : t('save')),
        ]),
      ]))
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        if (typeof document !== 'undefined') {
          const style = document.createElement('style')
          style.id = 'qwen-model-option-warm'
          style.textContent = 'button[role="option"] [data-provider-id]{display:flex!important;align-items:center!important;width:100%!important;min-width:0!important}@keyframes qwen-model-name-marquee{from{transform:translateX(0)}to{transform:translateX(calc(-1 * var(--qwen-model-name-distance,0px)))}}'
          document.head.appendChild(style)
          ctx.effect(() => () => style.remove(), 'qwen-mode: model option warm style')
          ctx.effect(() => {
            const suppress = (event) => {
              const target = event.target
              if (!(target instanceof Element)) return
              const button = target.closest('button[role="menuitemradio"][title]')
              if (button !== null) button.removeAttribute('title')
            }
            document.addEventListener('pointerover', suppress, true)
            document.addEventListener('focusin', suppress, true)
            return () => {
              document.removeEventListener('pointerover', suppress, true)
              document.removeEventListener('focusin', suppress, true)
            }
          }, 'qwen-mode: model option title')
        }
        let bound
        try {
          ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'qwen-mode: locale')
          bound = ctx.locale.bind(NS)
        } catch {
          // Fall back to the built-in dictionary when the locale service is unavailable.
        }
        const t = (key, params) => {
          if (typeof bound === 'function') {
            const value = bound(key, params)
            if (value !== undefined && value !== key) return value
          }
          return format(zh[key] ?? en[key] ?? key, params)
        }

        ctx.effect(() => installMtpSendGuard(t), 'qwen-mode: VLM MTP send guard')

        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'qwen-mode',
          order: 12,
          label: () => t('section.title'),
          locale: NS,
        }, QwenModePage))

        ctx.slots.inject('settings.section.icon', () => ctx.slots.register({
          name: 'settings.section.icon',
          id: 'qwen-mode',
        }, QwenGlyph))

        ctx.slots.inject('conversation.input.model.label', () => ctx.slots.register({
          name: 'conversation.input.model.label',
          inject: () => ({ getLocale: () => ctx.locale.getLocale().active }),
        }, ModelLabel))

        ctx.slots.inject('conversation.input.overlay', () => ctx.slots.register({
          name: 'conversation.input.overlay',
          id: 'qwen-warm',
          order: 0,
        }, PreheatOverlay))

        ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
          name: 'conversation.chat.turnTail',
          id: 'qwen-turn-stats',
          order: 30,
          inject: () => ({ t }),
        }, TurnStats))

        let permissionLocale = ''
        const syncPermissionLabel = () => {
          const active = ctx.locale.getLocale().active
          if (active === permissionLocale) return
          permissionLocale = active
          void call('permissionLabel', { locale: active }).catch(() => {})
        }
        syncPermissionLabel()
        ctx.effect(() => ctx.locale.subscribe(syncPermissionLabel), 'qwen-mode: permission label locale')
        ctx.effect(() => installReplyOnlyIcon(), 'qwen-mode: reply-only icon')
      },
    }
  },
})















