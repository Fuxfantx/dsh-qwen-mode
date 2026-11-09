/**
 * Browser half of the Qwen mode bundle: one compact Settings section.
 *
 * The Host owns the provider entry (`From GenieX` / `From QwenCloud`), so this
 * page only exposes the source, thinking mode, and sampling defaults.
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
      'section.subtitle': '自动创建并维护 Qwen Provider，补齐思考开关与采样参数',
      'mode.off': '关闭',
      'mode.auto': '自动',
      'source.title': '接入来源',
      'protocol.label': '来源',
      'protocol.geniex': 'GenieX',
      'protocol.qwen': 'QwenCloud',
      'upstream.label': '上游地址',
      'apiKeyEnv.label': 'API Key（可选）',
      'apiKeyEnv.placeholder': 'local',
      'warm.title': '模型预热',
      'warm.label': '选择 From GenieX 模型时自动预热',
      'warm.hint': '发送一个最小 system prompt、单 token 且关闭推理的请求，让 GenieX 提前加载模型；预热期间发送按钮显示转圈。',
      'advanced': '高级选项',
      'provider.title': '自动维护的 Provider',
      'provider.name': 'Provider',
      'provider.baseURL': 'baseURL',
      'provider.models': '模型',
      'provider.exists': '已创建',
      'provider.missing': '未创建',
      'provider.rebuild': '重建 Provider',
      'provider.remove': '移除 Provider',
      'provider.hint': 'Provider 名称固定为 From GenieX / From QwenCloud，模型从上游 /v1/models 自动发现。',
      'thinking.title': '思考控制',
      'thinking.label': '思考模式',
      'thinking.auto': '跟随请求',
      'thinking.on': '始终开启',
      'thinking.off': '始终关闭',
      'reasoningFormat.label': 'GenieX reasoning_format',
      'reasoningFormat.none': 'none（推荐，完整保留多段推理）',
      'reasoningFormat.deepseek': 'deepseek（可能提前结束思考）',
      'reasoningFormat.auto': 'auto（由上游决定）',
      'limits.title': '模型限制',
      'limits.hint': '上下文窗口留空时：GenieX 视为由 `geniex serve --nctx` 指定，不再下发该字段；QwenCloud 使用默认 262144。最大输出不能超过已设置的上下文窗口。',
      'limits.invalid': '最大输出长度不能大于上下文窗口。',
      'contextWindow.label': '上下文窗口',
      'contextWindow.placeholder': '留空：GenieX 用 --nctx，QwenCloud 用 262144',
      'maxOutputTokens.label': '最大输出长度',
      'sampling.title': '采样默认值',
      'sampling.hint': '仅在请求未自带该参数时填充；留空表示不注入。',
      'temperature.label': 'temperature',
      'topP.label': 'top_p',
      'topK.label': 'top_k',
      'repetitionPenalty.label': 'repetition_penalty',
      'presencePenalty.label': 'presence_penalty',
      'frequencyPenalty.label': 'frequency_penalty',
      'save': '保存并应用',
      'saving': '保存中…',
      'loadFailed': '读取设置失败：{message}',
      'saveFailed': '操作失败：{message}',
      'numberInvalid': '{field} 需要是数字或留空',
      'footer.hint': '保存后自动重建 Provider 与模型目录；切换来源会移除另一个来源的 Provider。',
      'modelCount': '{count} 个模型',
      'noModels': '尚未发现模型',
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
      'warm.title': 'Model warmup',
      'warm.label': 'Warm up when selecting a From GenieX model',
      'warm.hint': 'Sends a minimal system prompt with a one-token, non-thinking request so GenieX loads the model; the send button shows a spinner while warming.',
      'advanced': 'Advanced',
      'provider.title': 'Managed provider',
      'provider.name': 'Provider',
      'provider.baseURL': 'baseURL',
      'provider.models': 'Models',
      'provider.exists': 'Created',
      'provider.missing': 'Missing',
      'provider.rebuild': 'Rebuild provider',
      'provider.remove': 'Remove provider',
      'provider.hint': 'The provider name is fixed to From GenieX / From QwenCloud; models are discovered from /v1/models.',
      'thinking.title': 'Thinking',
      'thinking.label': 'Thinking mode',
      'thinking.auto': 'Follow request',
      'thinking.on': 'Always on',
      'thinking.off': 'Always off',
      'reasoningFormat.label': 'GenieX reasoning_format',
      'reasoningFormat.none': 'none (recommended; keeps all reasoning paragraphs)',
      'reasoningFormat.deepseek': 'deepseek (may end thinking early)',
      'reasoningFormat.auto': 'auto (upstream decides)',
      'limits.title': 'Model limits',
      'limits.hint': 'If the context window is empty: GenieX assumes `geniex serve --nctx` and the field is omitted; QwenCloud uses the default 262144. Max output cannot exceed an explicit context window.',
      'limits.invalid': 'Max output tokens cannot exceed the context window.',
      'contextWindow.label': 'Context window',
      'contextWindow.placeholder': 'Empty: GenieX uses --nctx; QwenCloud uses 262144',
      'maxOutputTokens.label': 'Max output tokens',
      'sampling.title': 'Sampling defaults',
      'sampling.hint': 'Injected only when the request does not already carry the field; empty omits it.',
      'temperature.label': 'temperature',
      'topP.label': 'top_p',
      'topK.label': 'top_k',
      'repetitionPenalty.label': 'repetition_penalty',
      'presencePenalty.label': 'presence_penalty',
      'frequencyPenalty.label': 'frequency_penalty',
      'save': 'Save and apply',
      'saving': 'Saving…',
      'loadFailed': 'Cannot read settings: {message}',
      'saveFailed': 'Action failed: {message}',
      'numberInvalid': '{field} must be a number or empty',
      'footer.hint': 'Saving rebuilds the provider and model catalog; switching sources removes the other provider.',
      'modelCount': '{count} models',
      'noModels': 'No models discovered yet',
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

    async function call(method, payload) {
      const response = await fetch(`${apiBase()}${API}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload ?? {}),
      })
      const body = await response.json().catch(() => undefined)
      if (!response.ok || body?.ok !== true) throw new Error(body?.error?.message ?? `HTTP ${response.status}`)
      return body.value
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

    /**
     * Inline model label for the composer model selector. The slot replaces the
     * built-in name + badge, so render both; GenieX models gain a quantization
     * tag derived from their `:Q4_0` suffix.
     */
    function ModelLabel({ provider, model, placement, selected, sessionId, getLocale }) {
      React.useEffect(() => {
        if (placement !== 'trigger' || !selected) return
        const key = sessionId ?? 'global'
        const selectedModel = provider?.id === 'from-geniex' && typeof model?.id === 'string' ? model.id : null
        preheat.setSelected(key, selectedModel)
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
          const modelKey = `${key}\u0000${modelId}`
          if (!preheat.enabled || lastWarm.get(key) === modelId) return
          if (Date.now() - (lastWarmAt.get(modelKey) ?? 0) < 15000) return
          lastWarm.set(key, modelId)
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
      }, [placement, selected, provider?.id, model?.id, sessionId])

      const name = model?.name ?? model?.id ?? ''
      const badges = []
      if (provider?.id === 'from-geniex' && typeof model?.id === 'string') {
        const match = /:([^:/\s]+)$/u.exec(model.id)
        if (match !== null) {
          badges.push(h('span', {
            key: 'quant',
            style: { ...S.modelBadge, color: 'var(--dsw-alias-brand-primary)', borderColor: 'var(--dsw-alias-brand-primary)' },
            title: `${model.id} · ${match[1]}`,
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
      return h('span', { style: S.modelLabel }, placement === 'trigger'
        ? [...badges, h('span', { key: 'name', style: S.modelName, title: name }, name)]
        : [h('span', { key: 'name', style: S.modelName, title: name }, name), ...badges])
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
      const scan = () => {
        if (document.body === null) return
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
            host.insertBefore(createIcon(), label)
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
      modelName: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, lineHeight: '20px' },
      modelBadge: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flex: '0 0 auto', height: '20px', boxSizing: 'border-box', padding: '0 6px', borderRadius: '999px', border: '1px solid var(--dsw-alias-border-l1)', background: 'transparent', fontSize: '9px', lineHeight: '20px', fontWeight: 500, whiteSpace: 'nowrap', alignSelf: 'center' },
      checkRow: { display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--dsw-alias-label-primary)', fontSize: '12px', cursor: 'pointer' },
      banner: { padding: '9px 11px', borderRadius: '8px', border: '1px solid var(--dsw-alias-state-error-primary)', color: 'var(--dsw-alias-state-error-primary)', background: 'var(--dsw-alias-bg-layer-1)', fontSize: '12px', overflowWrap: 'anywhere' },
      card: { display: 'flex', flexDirection: 'column', gap: '10px', padding: '14px', borderRadius: '10px', border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-layer-1)' },
      cardHeader: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' },
      cardTitle: { fontSize: '13px', fontWeight: 600 },
      hint: { color: 'var(--dsw-alias-label-secondary)', fontSize: '11px', lineHeight: 1.5 },
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
    const warmChain = new Map()

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
    preheat.ready = call('state')
      .then((next) => { preheat.enabled = next?.warm === true })
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
      const [error, setError] = React.useState('')
      const [busy, setBusy] = React.useState('')

      const load = React.useCallback(async () => {
        try {
          setSettings(await call('state'))
          setError('')
        } catch (reason) {
          setError(format(t('loadFailed'), { message: String(reason?.message ?? reason) }))
        }
      }, [t])

      React.useEffect(() => {
        void load()
      }, [load])

      const update = (key, value) => setSettings((current) => current === null ? current : { ...current, [key]: value })
      const numberValue = (key) => settings?.[key] === null || settings?.[key] === undefined ? '' : String(settings[key])
      const setNumber = (key, raw) => update(key, raw)

      const action = async (name, operation) => {
        setBusy(name)
        setError('')
        try {
          const next = await operation()
          if (next !== undefined) setSettings(next)
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
        for (const key of ['contextWindow', 'maxOutputTokens', 'temperature', 'topP', 'topK', 'repetitionPenalty', 'presencePenalty', 'frequencyPenalty']) {
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
          numeric[key] = value
        }
        if (numeric.maxOutputTokens !== null) {
          const effectiveContext = numeric.contextWindow
            ?? (settings.protocol === 'qwen' ? DEFAULT_CONTEXT_WINDOW : null)
          if (effectiveContext !== null && numeric.maxOutputTokens > effectiveContext) {
            setError(t('limits.invalid'))
            return
          }
        }
        preheat.enabled = settings.warm === true
        void action('save', () => call('save', {
          mode: settings.mode,
          warm: settings.warm === true,
          protocol: settings.protocol,
          upstream: settings.upstream,
          apiKeyEnv: settings.apiKeyEnv,
          thinking: settings.thinking,
          reasoningFormat: settings.reasoningFormat,
          ...numeric,
        }))
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
          h('div', { key: 'hint', style: S.hint }, t('provider.hint')),
          h('div', { key: 'grid', style: S.grid }, [
            h(Field, { key: 'name', label: t('provider.name') }, h('div', { style: S.code }, provider?.displayName ?? (settings.protocol === 'qwen' ? 'From QwenCloud' : 'From GenieX'))),
            h(Field, { key: 'baseURL', label: t('provider.baseURL') }, h('div', { style: S.code, title: provider?.baseURL ?? settings.proxyBaseURL }, provider?.baseURL || settings.proxyBaseURL)),
          ]),
          h('div', { key: 'models', style: S.hint }, models.length === 0 ? t('noModels') : `${format(t('modelCount'), { count: models.length })}: ${models.join(', ')}`),
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
        h('div', { key: 'thinking', style: S.card }, [
          h('div', { key: 'title', style: S.cardTitle }, t('thinking.title')),
          h('div', { key: 'grid', style: S.grid }, [
            h(Field, { key: 'thinking', label: t('thinking.label') }, h('select', {
              style: S.select,
              value: settings.thinking,
              onChange: (event) => update('thinking', event.target.value),
            }, [
              h('option', { key: 'auto', value: 'auto' }, t('thinking.auto')),
              h('option', { key: 'on', value: 'on' }, t('thinking.on')),
              h('option', { key: 'off', value: 'off' }, t('thinking.off')),
            ])),
            settings.protocol === 'geniex' ? h(Field, { key: 'format', label: t('reasoningFormat.label') }, h('select', {
              style: S.select,
              value: settings.reasoningFormat,
              onChange: (event) => update('reasoningFormat', event.target.value),
            }, [
              h('option', { key: 'none', value: 'none' }, t('reasoningFormat.none')),
              h('option', { key: 'deepseek', value: 'deepseek' }, t('reasoningFormat.deepseek')),
              h('option', { key: 'auto', value: 'auto' }, t('reasoningFormat.auto')),
            ])) : null,
          ]),
        ]),
        h('div', { key: 'limits', style: S.card }, [
          h('div', { key: 'title', style: S.cardTitle }, t('limits.title')),
          h('div', { key: 'hint', style: S.hint }, t('limits.hint')),
          h('div', { key: 'grid', style: S.grid }, [
            ...['contextWindow', 'maxOutputTokens'].map((key) => h(Field, {
              key,
              label: t(`${key}.label`),
            }, h('input', {
              key: 'input',
              style: S.input,
              inputMode: 'numeric',
              value: numberValue(key),
              placeholder: key === 'contextWindow' ? t('contextWindow.placeholder') : undefined,
              onChange: (event) => setNumber(key, event.target.value),
            }))),
          ]),
        ]),
        h('div', { key: 'sampling', style: S.card }, [
          h('div', { key: 'title', style: S.cardTitle }, t('sampling.title')),
          h('div', { key: 'hint', style: S.hint }, t('sampling.hint')),
          h('div', { key: 'grid', style: S.grid }, [
            ...['temperature', 'topP', 'topK', 'repetitionPenalty', 'presencePenalty', 'frequencyPenalty'].map((key) => h(Field, {
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








