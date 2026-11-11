import { useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { invoke } from '@tauri-apps/api/core'
import { save } from '@tauri-apps/plugin-dialog'
import {
  APP_VERSION,
  assetUrl,
  CATALOGS,
  cachedSrc,
  DEFAULT_PROVIDERS,
  DEFAULT_SETTINGS,
  EMPTY_PCONF,
  EMPTY_REFS,
  FULL_TO_THUMB,
  GalleryImage,
  historyTime,
  Icon,
  loadRefMeta,
  loadSettings,
  PreviewImg,
  RATIOS,
  ratioMeta,
  REF_META,
  SENSITIVE_CATEGORIES,
  sanitizeConfigs,
  sanitizeProviders,
  HistoryThumb,
  RefThumb,
  STORAGE_KEY,
  TemplateThumb,
  useIsPhone,
  openExternal,
  readAsDataUrl
} from './shared'
import type {
  GalleryCatalog,
  GalleryItem,
  GalleryView,
  HistoryItem,
  ProviderDef,
  ProviderUserConfig,
  RefKey,
  RefMeta,
  Refs,
  Settings,
  TemplateItem,
  Tone
} from './shared'
import { PhoneApp } from './phone/PhoneApp'
import './phone/phone.css'

// 参考图 → 本地 SQLite 库中的 { mime, base64 }（首次取用自动下载入库）
async function refDataUri(url: string): Promise<{ mime: string; data: string }> {
  // 上传的照片本来就是 data: URI：直接本地解析，不经后端
  // （后端 image_data_uri 只接受 http/https 地址）
  const local = /^data:([^;]+);base64,([\s\S]+)$/.exec(url)
  if (url.startsWith('data:')) {
    if (!local) throw new Error('图像数据异常')
    return { mime: local[1], data: local[2] }
  }
  const uri = await invoke<string>('image_data_uri', { url, kind: 'ref' })
  const m = /^data:([^;]+);base64,([\s\S]+)$/.exec(uri)
  if (!m) throw new Error('图像数据异常')
  return { mime: m[1], data: m[2] }
}

type HttpResult = { status: number; text: string }
// 供应商 API 请求统一走这里。打包应用里 webview 的 fetch 过不了 CORS：
// 有的服务（火山方舟等）只在 OPTIONS 预检里回 access-control-allow-origin，
// 实际响应不带，浏览器按规范把整个响应扔掉——表面只剩一句 "Load failed"，
// 连 API 的报错原文都看不到。所以真实环境下走 Rust 代理（原生无 CORS，
// 4xx/5xx 的报错原文也能带回来）；纯浏览器开发预览没有后端，退回 fetch。
const IN_TAURI = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
const providerPost = async (
  url: string,
  headers: Record<string, string>,
  init: {
    json?: string
    fields?: [string, string][]
    files?: { name: string; filename: string; mime: string; data: string }[]
    cancelId?: string
  }
): Promise<HttpResult> => {
  if (IN_TAURI) {
    return invoke<HttpResult>('provider_fetch', {
      request: {
        url,
        headers,
        json_body: init.json ?? null,
        form_fields: init.fields ?? [],
        form_files: init.files ?? [],
        cancel_id: init.cancelId ?? null
      }
    })
  }
  if (init.files?.length) {
    const form = new FormData()
    for (const [k, v] of init.fields ?? []) form.append(k, v)
    for (const f of init.files) {
      const bytes = Uint8Array.from(atob(f.data), (c) => c.charCodeAt(0))
      form.append(f.name, new Blob([bytes], { type: f.mime }), f.filename)
    }
    const res = await fetch(url, { method: 'POST', headers, body: form })
    return { status: res.status, text: await res.text() }
  }
  const res = await fetch(url, { method: 'POST', headers, body: init.json ?? '' })
  return { status: res.status, text: await res.text() }
}

// 常见服务端错误码 → 一句人话提示，拼在原文后面（原文保留，绝不吞）。
// 实测案例：方舟对蕾丝吊带衫之类的出图回 OutputImageSensitiveContentDetected，
// 用户看到的却像故障，其实是审核拦截。
const ERROR_HINTS: [RegExp, string][] = [
  [/OutputImageSensitiveContentDetected/, '生成结果被对方安全审核拦下，不是故障：把描述或参考图改保守些，或换一家服务商'],
  [/InputImageSensitiveContentDetected/, '参考图被对方安全审核拦下：换一张参考图再试'],
  [/AuthenticationError|InvalidAPIKey/, 'Key 无效或不被这个接口地址接受：核对 Key 与地址是否配套'],
  [/ModelNotOpen|ModelNotDeployed/, '这个模型没在你账号开通：去服务商控制台开通后再试'],
  [/AccessDenied/, '当前 Key 没有调这个接口的权限']
]
const humanizeError = (text: string) => {
  const hint = ERROR_HINTS.find(([re]) => re.test(text))
  return hint ? `${text}（提示：${hint[1]}）` : text
}

// 按已载入的参考图自动拼提示词：一张人物照片 + 一个姿势即可出图，服装/人脸是增强项
function autoPrompt(refs: Refs): string {
  const seg: string[] = []
  if (refs.photo && refs.pose) {
    seg.push('以人物照片中的主角为准，保持其长相、发型与体型特征')
    seg.push('让主角摆出姿势参考中的动作与机位')
  } else if (refs.photo) {
    seg.push('以人物照片中的主角为主，生成一张自然真实的写真照片')
  } else if (refs.pose && refs.face) {
    seg.push('保持参考人物的五官与发型特征')
    seg.push('让人物摆出姿势参考中的动作与机位')
  } else if (refs.pose) {
    seg.push('按照姿势参考的姿态与构图，生成一位自然真实的人物')
  } else if (refs.face) {
    seg.push('以参考人物的五官与发型为特征，生成一张自然真实的人物照片')
  }
  if (refs.photo && refs.face) {
    // 照片与人脸同时在场：照片定整体与体型，人脸参考补五官细节
    seg.push('五官与发型细节参照人脸参考图校正')
  }
  if (refs.costume) seg.push('服装与穿搭遵循参考服装图的整套样式与材质')
  seg.push('画面高清、光影自然')
  return seg.join('，')
}

// 委婉化提示词：剥掉「隐形人/不要人/不要皮肤」式负向短语（关键字审核的高频
// 命中点），并追加一句含蓄化引导。参考原项目 gen-ai-pose-image 的
// 「违禁词优化」开关；默认关，开了才走这条路径，原文尽量保留。
// 「允许成人向内容」打开时不附加「画面得体、可公开展示」的约束句，只保留剥负向短语。
const GHOST_CLAUSE =
  /不要人|不要头|不要脸|不要手|不要腿|不要身体|不要皮肤|不要露出(?:腿|皮肤)|隐形人|画面里只有衣服/g
function softenPrompt(text: string, adult: boolean): string {
  const cleaned = text
    .replace(GHOST_CLAUSE, ' ')
    .replace(/[，,]{2,}/g, '，')
    .replace(/^[\s，,。;；]+|[\s，,。;；]+$/g, '')
    .trim()
  return adult
    ? `${cleaned}，如实描写参考图中人物的穿搭与姿态`
    : `${cleaned}，用含蓄日常的说法描写衣着与姿态，画面得体、可公开展示`
}

// 判定一次生成失败是否疑似「内容审核拦截」：方舟是
// OutputImageSensitiveContentDetected / InputImageSensitiveContentDetected，
// 其他常见写法一并覆盖；宁可多提示，也不要把审核问题当软件故障让用户白查
const CENSOR_RE =
  /SensitiveContentDetected|content_policy|ContentPolicy|content_moderation|内容审核|审核未通过|审核拦截|敏感内容|违规内容/i
function isCensorError(msg: string): boolean {
  return CENSOR_RE.test(msg)
}

// 事件日志：生成 / 连通性测试等关键事件追加到应用数据目录的 ziran.log，
// 方便事后排查「当时为什么没出图」。Key 与请求头一律不落日志：只记长度
// 与布尔位；错误文本再过一遍脱敏（防止上游把凭据回显进错误消息里）。
function redact(text: string): string {
  return text
    .replace(/(?:sk|rk)-[A-Za-z0-9_-]{6,}/g, (m) => `${m.slice(0, 5)}***`)
    .replace(/Bearer\s+[A-Za-z0-9._-]{6,}/gi, 'Bearer ***')
}
async function logEvent(level: 'info' | 'warn' | 'error', scope: string, message: string) {
  const ts = new Date().toISOString()
  try {
    await invoke('append_log', { line: `${ts} [${level}][${scope}] ${redact(message).slice(0, 600)}` })
  } catch {
    // 日志失败绝不影响主流程（纯浏览器开发预览没有 Tauri 后端）
  }
}

const ARTBOARD = 512

// —— 工作区（多工程面板）——
// 每个工作区一份独立的参考图/描述/画布状态；平时只把「当前工作区」投影到
// 扁平 state 上，切换时暂存当前、恢复目标。图片是 data URI 不落 localStorage
// （体积太大），工作区与会话同生命周期，重启回到单个空工作区。
type ProjectState = {
  refs: Refs
  refMeta: Record<RefKey, RefMeta | null>
  prompt: string
  result: string
  active: RefKey
  viewingHistory: number | null
  lastGen: { provider: string; model: string; prompt: string }
}
type Project = { id: number; name: string; state: ProjectState | null }

// 两段式确认的删除按钮：第一击进入待确认态（3 秒无操作自动复位），再击才真删。
// 不用 window.confirm——WebView 里它是阻塞原语，样式也无法跟随主题。
function DeleteConfirm({ label, onConfirm }: { label: string; onConfirm: () => void }) {
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    if (!armed) return
    const t = setTimeout(() => setArmed(false), 3000)
    return () => clearTimeout(t)
  }, [armed])
  return (
    <button
      className={armed ? 'provider-del is-armed' : 'provider-del'}
      onClick={() => (armed ? onConfirm() : setArmed(true))}
    >
      {armed ? '再点一次确认删除' : label}
    </button>
  )
}

function App() {
  const [settings, setSettings] = useState<Settings>(loadSettings)
  const [providers, setProviders] = useState<ProviderDef[]>(DEFAULT_PROVIDERS)
  const [providersPath, setProvidersPath] = useState('')
  const providerMeta = (id: string) => providers.find((p) => p.value === id) ?? providers[0]
  const [refs, setRefs] = useState<Refs>(EMPTY_REFS)
  const [active, setActive] = useState<RefKey>('pose')
  const [prompt, setPrompt] = useState('')
  const [result, setResult] = useState('')
  // 生成历史：新出图自动归档，点缩略条切换回看。viewingHistory 是当前
  // 正在看的条目 id；null 表示看的是最新出图（新生成时重置）。
  const [history, setHistory] = useState<HistoryItem[]>([])
  const [viewingHistory, setViewingHistory] = useState<number | null>(null)
  // 历史面板删除确认：第一击进入武装态，2.6 秒内再点同一张才真删
  const [armDelId, setArmDelId] = useState<number | null>(null)
  const armDelT = useRef(0)
  useEffect(() => () => window.clearTimeout(armDelT.current), [])
  // 生成模板：用户显式收藏的成图，可基于它再次生成
  const [templates, setTemplates] = useState<TemplateItem[]>([])
  const [status, setStatus] = useState<{ text: string; tone: Tone }>({ text: '就绪', tone: 'neutral' })
  const [busy, setBusy] = useState(false)
  const [refMeta, setRefMeta] = useState<Record<RefKey, RefMeta | null>>(loadRefMeta)
  const [galleryOpen, setGalleryOpen] = useState<RefKey | null>(null)
  // 模板库浮层（桌面）：与图库并列的收藏入口
  const [templateOpen, setTemplateOpen] = useState(false)
  // 历史面板（桌面）：rail 图标点开的浮层，收纳全部成图
  const [histPanelOpen, setHistPanelOpen] = useState(false)
  // —— 工作区 ——
  // activeProjectRef 同步维护（不等 effect），生成结果按发起时的工作区投递
  const [projects, setProjects] = useState<Project[]>([{ id: 1, name: '工作区 1', state: null }])
  const [activeProject, setActiveProject] = useState(1)
  const activeProjectRef = useRef(1)
  const projectIdRef = useRef(2)
  // 历史面板：Esc 关闭（effect 必须在声明之后，依赖数组渲染期就要读值）
  useEffect(() => {
    if (!histPanelOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setHistPanelOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [histPanelOpen])
  const [preview, setPreview] = useState<{ src: string; title: string } | null>(null)
  const [srcDims, setSrcDims] = useState<{ w: number; h: number } | null>(null)

  const [showGuide, setShowGuide] = useState(() => {
    try {
      return localStorage.getItem(`${STORAGE_KEY}.guide`) !== '1'
    } catch {
      return true
    }
  })
  const [missing, setMissing] = useState<'key' | 'pose' | null>(null)
  const promptRef = useRef<HTMLTextAreaElement | null>(null)
  const [zoom, setZoom] = useState(1)
  const [grid, setGrid] = useState(true)
  const [dragging, setDragging] = useState(false)
  const [autoFit, setAutoFit] = useState(true)
  const areaRef = useRef<HTMLDivElement | null>(null)

  const isPhone = useIsPhone()

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
    } catch {
      // storage can be unavailable (private mode); settings still live in memory
    }
  }, [settings])

  // 主题落到 <html data-theme>，CSS 在 token 层整体翻转
  useEffect(() => {
    document.documentElement.dataset.theme = settings.theme
  }, [settings.theme])

  // 手机端整体切换也挂在 <html data-app> 上：手机段 CSS 只在这个属性下生效，
  // 桌面布局的规则一行不动
  useEffect(() => {
    document.documentElement.dataset.app = isPhone ? 'phone' : 'desktop'
  }, [isPhone])

  // 启动时把本地生成历史拉进来自动填充切换条（后端不在则静默跳过；
  // 兜底 Array.isArray：桩/异常路径返回 null 时不能把列表打成 null）
  useEffect(() => {
    invoke<HistoryItem[]>('history_list')
      .then((rows) => setHistory(Array.isArray(rows) ? rows : []))
      .catch(() => {})
    invoke<TemplateItem[]>('template_list')
      .then((rows) => setTemplates(Array.isArray(rows) ? rows : []))
      .catch(() => {})
  }, [])

  useEffect(() => {
    try {
      localStorage.setItem(`${STORAGE_KEY}.refmeta`, JSON.stringify(refMeta))
      if (refMeta.pose) localStorage.setItem(`${STORAGE_KEY}.pose`, JSON.stringify(refMeta.pose))
      else localStorage.removeItem(`${STORAGE_KEY}.pose`)
    } catch {
      // ignore storage failures
    }
  }, [refMeta])

  // 读 providers.json（没有就写入内置默认）。
  // 错误分三类，不能混在一个 catch 里吞掉：
  //   ① 后端不在（纯浏览器开发预览）→ 静默保持内置默认
  //   ② 文件语法坏了（用户改错 JSON）→ 明确报错，沿用当前列表，绝不把坏数据放进界面
  //   ③ 文件里没有有效条目 → 明确报错，沿用内置默认
  const applyProvidersFile = async (announce: boolean) => {
    let raw: string | null
    try {
      const path = await invoke<string>('config_file_path', { name: 'providers.json' })
      setProvidersPath(path)
      raw = await invoke<string | null>('read_config_file', { name: 'providers.json' })
    } catch {
      return // ① 开发预览没有后端
    }
    if (raw == null) {
      try {
        await invoke('write_config_file', {
          name: 'providers.json',
          contents: JSON.stringify(DEFAULT_PROVIDERS, null, 2)
        })
        setProviders(DEFAULT_PROVIDERS)
        if (announce) setStatus({ text: '已把默认供应商写入 providers.json，可直接编辑', tone: 'ok' })
      } catch (e) {
        setStatus({ text: `providers.json 写入失败：${String(e)}`, tone: 'err' })
        void logEvent('error', 'providers', `write failed: ${String(e)}`)
      }
      return
    }
    let parsed: ProviderDef[]
    try {
      parsed = sanitizeProviders(JSON.parse(raw))
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setStatus({ text: `providers.json 解析失败，已沿用默认（${msg}）`, tone: 'err' })
      void logEvent('error', 'providers', `parse failed: ${msg} raw=${raw.slice(0, 200)}`)
      return
    }
    if (!parsed.length) {
      setStatus({ text: 'providers.json 里没有有效条目，已沿用内置默认', tone: 'err' })
      return
    }
    setProviders(parsed)
    const noModel = parsed.filter((p) => !p.model.trim()).length
    if (announce) {
      setStatus({ text: `已从 providers.json 载入 ${parsed.length} 个供应商${noModel ? `，${noModel} 个缺 model 字段` : ''}`, tone: 'ok' })
    } else if (noModel) {
      setStatus({ text: `providers.json 里 ${noModel} 个供应商缺 model 字段，选中它生成会报错`, tone: 'err' })
    }
    // 当前选中的供应商若已不存在，回落到列表第一个（model/baseUrl 由 effModel/effBaseUrl 兜底）
    if (!parsed.some((p) => p.value === settings.provider)) {
      update({ provider: parsed[0].value })
    }
    // 配置面板里正被编辑的供应商同理，避免左侧列表失去高亮
    if (!parsed.some((p) => p.value === panelProvider)) {
      setPanelProvider(parsed[0].value)
    }
  }
  useEffect(() => {
    void applyProvidersFile(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 自定义中转站：providers.json 是唯一事实源，界面的新增/改名/删除都先写回
  // 文件、成功后才更新内存；写失败（纯浏览器预览没有后端）就保持原状并报错。
  // value 稳定不变，改名不影响它的 Key/模型等已存配置。
  const isCustomProvider = (value: string) => value === 'custom' || value.startsWith('custom-')
  const nameInputRef = useRef<HTMLInputElement | null>(null)
  const persistProviders = async (list: ProviderDef[]): Promise<boolean> => {
    try {
      await invoke('write_config_file', { name: 'providers.json', contents: JSON.stringify(list, null, 2) })
    } catch (e) {
      setStatus({ text: `providers.json 写入失败：${String(e)}`, tone: 'err' })
      return false
    }
    setProviders(list)
    return true
  }
  const addCustomProvider = async () => {
    const preset = DEFAULT_PROVIDERS.find((p) => p.value === 'custom')
    if (!preset) return
    const entry: ProviderDef = { ...preset, value: `custom-${Date.now().toString(36)}`, label: '自定义中转站' }
    if (await persistProviders([...providers, entry])) {
      setPanelProvider(entry.value)
      // 直接聚焦「名称」框，顺手把默认名改成中转站自己的名字
      setTimeout(() => nameInputRef.current?.focus(), 60)
    }
  }
  const renameCustomProvider = async (value: string, label: string) => {
    const name = label.trim()
    if (!name || name === providerMeta(value).label) return
    await persistProviders(providers.map((p) => (p.value === value ? { ...p, label: name } : p)))
  }
  const deleteCustomProvider = async (value: string) => {
    const next = providers.filter((p) => p.value !== value)
    if (!next.length || !(await persistProviders(next))) return
    // 这个供应商的 Key 等配置一并清掉；正选中/正编辑的回落到列表第一个
    setSettings((prev) => {
      const configs = { ...prev.configs }
      delete configs[value]
      return { ...prev, configs }
    })
    if (settings.provider === value) update({ provider: next[0].value })
    if (panelProvider === value) setPanelProvider(next[0].value)
  }

  const activeRatio = ratioMeta(settings.ratio)
  // 画板随当前显示图片的真实比例自适应，避免参考图/成图留黑边；空板时用所选画幅比例
  const shownScale = srcDims ? ARTBOARD / Math.max(srcDims.w, srcDims.h) : ARTBOARD / Math.max(activeRatio.w, activeRatio.h)
  const boardW = Math.round((srcDims ? srcDims.w : activeRatio.w) * shownScale)
  const boardH = Math.round((srcDims ? srcDims.h : activeRatio.h) * shownScale)

  useEffect(() => {
    if (!autoFit) return
    const compute = () => {
      const area = areaRef.current
      if (!area) return
      // fit 时给上方「已选参考」横带和底部「生成历史」条让出高度：
      // 有横带时画布顶部锚定（padding 10 + 横带 + gap 10），画板布局盒顶 = 横带之下；
      // 无横带时画板居中。画板以顶边为缩放原点（只向下生长）
      const areaH = area.clientHeight
      const stripH = area.querySelector<HTMLElement>('.ref-strip')?.offsetHeight || 0
      const histH = area.querySelector<HTMLElement>('.history-strip')?.offsetHeight || 0
      const layoutTop = stripH > 0 ? stripH + 20 : Math.max(0, (areaH - boardH) / 2)
      const bottomPad = histH > 0 ? histH + 26 : 26
      // 手机端画板区左右只有 16px 内边距，桌面是 48px 两侧留白，扣除量不同
      const sideInset = document.documentElement.dataset.app === 'phone' ? 32 : 96
      const fit = Math.min((area.clientWidth - sideInset) / boardW, (areaH - layoutTop - bottomPad) / boardH)
      setZoom(Math.max(0.2, Math.min(1.6, Number(fit.toFixed(2)))))
    }
    compute()
    // 初帧的 flex/resize 布局可能还没落定（手机端 data-app 切换、字体加载），
    // 两帧后再校一次，避免首帧量到异常值被钳在缩放下限
    let raf = 0
    raf = requestAnimationFrame(() => {
      raf = requestAnimationFrame(compute)
    })
    window.addEventListener('resize', compute)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', compute)
    }
  }, [autoFit, boardW, boardH, isPhone])

  const update = (patch: Partial<Settings>) => setSettings((prev) => ({ ...prev, ...patch }))
  // 每供应商独立配置的读取：Key 各用各的；模型/地址留空就跟随该供应商默认
  const effConfig = (value: string = settings.provider): ProviderUserConfig => settings.configs[value] ?? EMPTY_PCONF
  const effModel = (value: string = settings.provider) => effConfig(value).model.trim() || providerMeta(value).model
  // 地址只填根地址；用户把完整端点（…/images/generations|edits）粘进来也能用——
  // 本应用生成时自己拼这个尾巴，不剥掉会变成双重路径（实测方舟返回 500）
  const effBaseUrl = (value: string = settings.provider) =>
    effConfig(value).baseUrl.trim().replace(/\/(images\/generations|images\/edits)\/?$/, '') || providerMeta(value).baseUrl
  const effKey = (value: string = settings.provider) => effConfig(value).apiKey
  const updateProviderConfig = (value: string, patch: Partial<ProviderUserConfig>) =>
    setSettings((prev) => ({
      ...prev,
      configs: { ...prev.configs, [value]: { ...(prev.configs[value] ?? EMPTY_PCONF), ...patch } }
    }))
  // 切换供应商只换 active；Key/模型各自跟随该供应商的独立配置
  const switchProvider = (value: string) => update({ provider: value })
  // 模型配置面板（独立于创作页面）
  const [panelOpen, setPanelOpen] = useState(false)
  const [panelProvider, setPanelProvider] = useState(DEFAULT_SETTINGS.provider)
  const panelMeta = providerMeta(panelProvider)
  const openPanel = (value: string = settings.provider) => {
    setPanelProvider(value)
    setPanelOpen(true)
  }
  // 连通性测试：testing = 正在测的供应商，testOut = 各供应商最近一次结果（就地显示）
  const [testing, setTesting] = useState<string | null>(null)
  const [testOut, setTestOut] = useState<Record<string, { ok: boolean; ms: number; text: string }>>({})
  useEffect(() => {
    if (!panelOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPanelOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [panelOpen])
  const setRef = (key: RefKey, value: string | null) => {
    // 四类参考（照片/人脸/姿势/服装）可自由叠加，互不清除：
    // 上传照片、模板载入、图库选择都走这里，后选的只占自己的槽位
    setRefs((prev) => ({ ...prev, [key]: value }))
    setActive(key)
  }
  const bumpZoom = (delta: number) => {
    setAutoFit(false)
    setZoom((z) => Math.max(0.2, Math.min(2.5, Number((z + delta).toFixed(2)))))
  }

  const pickFile = async (file: File | undefined, key: RefKey) => {
    if (!file || !file.type.startsWith('image/')) {
      setStatus({ text: '请选择图片文件', tone: 'err' })
      return
    }
    setRef(key, await readAsDataUrl(file))
    setStatus({ text: `已载入${REF_META[key].name} · ${file.name}`, tone: 'ok' })
  }

  // —— 工作区切换：暂存当前面板 → 恢复目标面板 ——

  const freshProjectState = (): ProjectState => ({
    refs: { ...EMPTY_REFS },
    refMeta: loadRefMeta(),
    prompt: '',
    result: '',
    active: 'pose',
    viewingHistory: null,
    lastGen: { provider: '', model: '', prompt: '' }
  })

  // 把一份工作区状态铺回扁平 state（画板/参考/描述都是当前面板的投影）
  const applyProjectState = (st: ProjectState) => {
    setRefs(st.refs)
    setRefMeta(st.refMeta)
    setPrompt(st.prompt)
    setResult(st.result)
    setActive(st.active)
    setViewingHistory(st.viewingHistory)
    lastGenRef.current = { ...st.lastGen }
    setSrcDims(null)
    setAutoFit(true)
  }

  const switchProject = (id: number) => {
    if (id === activeProjectRef.current) return
    const target = projects.find((p) => p.id === id)
    if (!target) return
    const from = activeProjectRef.current
    setProjects((prev) =>
      prev.map((p) =>
        p.id === from
          ? {
              ...p,
              state: { refs, refMeta, prompt, result, active, viewingHistory, lastGen: { ...lastGenRef.current } }
            }
          : p
      )
    )
    applyProjectState(target.state ?? freshProjectState())
    setActiveProject(id)
    activeProjectRef.current = id
  }

  const createProject = () => {
    const from = activeProjectRef.current
    const id = projectIdRef.current++
    // 不能先 setProjects 再 switchProject：后者闭包里的 projects 还没有新 tab，
    // 会找不到 target 而静默返回。这里一次性完成「存现状 + 追加新 tab + 切过去」。
    setProjects((prev) => [
      ...prev.map((p) =>
        p.id === from
          ? {
              ...p,
              state: { refs, refMeta, prompt, result, active, viewingHistory, lastGen: { ...lastGenRef.current } }
            }
          : p
      ),
      { id, name: `工作区 ${id}`, state: null }
    ])
    applyProjectState(freshProjectState())
    setActiveProject(id)
    activeProjectRef.current = id
  }

  const closeProject = (id: number) => {
    const rest = projects.filter((p) => p.id !== id)
    if (!rest.length) {
      // 最后一个也关：换成全新空工作区
      const freshId = projectIdRef.current++
      setProjects([{ id: freshId, name: `工作区 ${freshId}`, state: null }])
      applyProjectState(freshProjectState())
      setActiveProject(freshId)
      activeProjectRef.current = freshId
      return
    }
    setProjects(rest)
    if (id === activeProjectRef.current) {
      const next = rest[0]
      applyProjectState(next.state ?? freshProjectState())
      setActiveProject(next.id)
      activeProjectRef.current = next.id
    }
  }

  // 出图结果按「发起生成时的工作区」投递：中途切到别的工作区，成图也能
  // 落回正确的画板（目标在后台时写进它的暂存状态）
  const deliverResult = (pid: number, output: string) => {
    if (pid === activeProjectRef.current) {
      setResult(output)
      return
    }
    setProjects((prev) =>
      prev.map((p) => (p.id === pid && p.state ? { ...p, state: { ...p.state, result: output } } : p))
    )
  }

  // 连通性测试：对某个供应商发一次最小真实生成请求。
  // 与正式生成完全同一条 providerPost → Rust 代理链路、同一套请求形态，
  // 这里报「通」就等于 Key、模型名、接口地址、网络全部就绪。
  const runTest = async (value: string) => {
    if (testing) return
    const meta = providerMeta(value)
    if (!effKey(value).trim()) {
      setTestOut((prev) => ({ ...prev, [value]: { ok: false, ms: 0, text: '还没填 API Key' } }))
      void logEvent('warn', 'test', `provider=${value} aborted: no key`)
      return
    }
    const base = effBaseUrl(value).replace(/\/$/, '')
    if (!base) {
      setTestOut((prev) => ({ ...prev, [value]: { ok: false, ms: 0, text: '还没填接口地址' } }))
      void logEvent('warn', 'test', `provider=${value} aborted: no base url`)
      return
    }
    const model = effModel(value).trim()
    if (!model) {
      setTestOut((prev) => ({ ...prev, [value]: { ok: false, ms: 0, text: '还没填模型名' } }))
      void logEvent('warn', 'test', `provider=${value} aborted: no model`)
      return
    }
    const key = effKey(value).trim()
    const keyLen = key.length
    const TEST_PROMPT = '纯色背景，极简连通性测试'
    // 1×1 PNG：给编辑类模型（硅基流动 Qwen-Edit 必须带图）凑一个合法参考图入参
    const TEST_IMG =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
    setTesting(value)
    const t0 = Date.now()
    try {
      let res: HttpResult
      let hasImage: boolean
      let extraErr = ''
      if (meta.shape === 'gemini') {
        res = await providerPost(
          `${base}/models/${model}:generateContent`,
          { 'Content-Type': 'application/json', 'x-goog-api-key': key },
          { json: JSON.stringify({ contents: [{ parts: [{ text: TEST_PROMPT }] }], generationConfig: { responseModalities: ['IMAGE'] } }) }
        )
        hasImage = res.status < 400 && !!JSON.parse(res.text || '{}')?.candidates?.[0]
      } else if (meta.shape === 'minimax') {
        res = await providerPost(
          `${base}/image_generation`,
          { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
          { json: JSON.stringify({ model, prompt: TEST_PROMPT, aspect_ratio: '1:1' }) }
        )
        const data = res.status < 400 ? JSON.parse(res.text || '{}') : null
        if (data?.base_resp?.status_code) extraErr = String(data.base_resp.status_msg || `业务错误 ${data.base_resp.status_code}`)
        hasImage = res.status < 400 && !extraErr && !!data?.data?.image_urls?.[0]
      } else if (meta.shape === 'gptimage') {
        res = await providerPost(
          `${base}/images/generations`,
          { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
          { json: JSON.stringify({ model, prompt: TEST_PROMPT, size: '1024x1024', quality: 'low' }) }
        )
        hasImage = res.status < 400 && !!JSON.parse(res.text || '{}')?.data?.[0]
      } else {
        const body: Record<string, unknown> =
          meta.shape === 'siliconflow'
            ? { model, prompt: TEST_PROMPT, image: TEST_IMG }
            : meta.shape === 'ark'
              ? { model, prompt: TEST_PROMPT, response_format: 'url', size: '1024x1024' }
              : { model, prompt: TEST_PROMPT, size: '1024x1024' }
        res = await providerPost(
          `${base}/images/generations`,
          { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
          { json: JSON.stringify(body) }
        )
        hasImage = res.status < 400 && !!JSON.parse(res.text || '{}')?.data?.[0]
      }
      const ms = Date.now() - t0
      const out =
        res.status >= 400
          ? { ok: false, ms, text: `失败 ${res.status} · ${humanizeError(res.text.slice(0, 180))}` }
          : extraErr
            ? { ok: false, ms, text: `失败 · ${extraErr}` }
            : !hasImage
              ? { ok: false, ms, text: `HTTP ${res.status} 但响应里没有图像数据` }
              : { ok: true, ms, text: `连通正常 · ${(ms / 1000).toFixed(1)}s` }
      setTestOut((prev) => ({ ...prev, [value]: out }))
      setStatus({ text: `${meta.label} ${out.ok ? '连通正常' : '连通失败'} · ${out.text}`, tone: out.ok ? 'ok' : 'err' })
      void logEvent(
        out.ok ? 'info' : 'error',
        'test',
        `provider=${value} model=${model} keyLen=${keyLen} base=${base} status=${res.status} durMs=${ms} ok=${out.ok} ${out.text}`
      )
    } catch (err) {
      const text = err instanceof Error ? err.message : `请求失败 · ${String(err)}`
      const ms = Date.now() - t0
      setTestOut((prev) => ({ ...prev, [value]: { ok: false, ms, text } }))
      setStatus({ text: `${meta.label} 连通失败 · ${text}`, tone: 'err' })
      void logEvent('error', 'test', `provider=${value} model=${model} keyLen=${keyLen} base=${base} durMs=${ms} transport-error ${text}`)
    } finally {
      setTesting(null)
    }
  }

  // 当前可取消请求的句柄 id：手机端快门旁的「取消」按它打断生成中的请求
  const cancelIdRef = useRef<string | null>(null)
  const cancelGenerate = () => {
    const id = cancelIdRef.current
    if (!id) return
    void invoke('provider_fetch_cancel', { id }).catch(() => {})
  }

  // 手机端「最近底片 → 设为槽位」：整图 data URI 进槽（与模板载入同款逻辑）
  const setSlotImage = (key: RefKey, uri: string) => {
    setRef(key, uri)
    setResult('')
    setMissing(null)
    setStatus({ text: `已载入${REF_META[key].name} · 可再生成`, tone: 'ok' })
  }

  const generate = async () => {
    const meta = providerMeta(settings.provider)
    const ratio = ratioMeta(settings.ratio)

    if (!effKey().trim()) {
      setMissing('key')
      setStatus({ text: `${meta.label} 还没有配置 API Key，请在模型配置里填写`, tone: 'err' })
      void logEvent('warn', 'generate', `provider=${settings.provider} aborted: no key`)
      openPanel()
      return
    }
    if (meta.refs && !refs.pose && !refs.photo) {
      setStatus({ text: '请先选一个姿势，或上传一张参考图', tone: 'err' })
      void logEvent('warn', 'generate', `provider=${settings.provider} aborted: no reference`)
      return
    }
    if (!meta.refs && !prompt.trim()) {
      setStatus({ text: `${meta.label} 只按文字画图，请先写一段描述`, tone: 'err' })
      void logEvent('warn', 'generate', `provider=${settings.provider} aborted: no prompt`)
      return
    }

    const refList = [refs.photo, refs.pose, refs.costume, refs.face].filter(Boolean) as string[]
    // 委婉描述按服务商开关，默认打开；显式关掉（接入不设限的服务商）才保提示词原样；
    // 「允许成人向内容」打开时不附加「画面得体」的约束句
    const conf = effConfig()
    const rawPrompt = prompt.trim() || autoPrompt(refs)
    const promptText = conf.soft !== false ? softenPrompt(rawPrompt, !!conf.adult) : rawPrompt
    const base = effBaseUrl().replace(/\/$/, '')
    if (!base) {
      openPanel()
      setStatus({ text: `${meta.label} 需要先在模型配置里填写接口根地址`, tone: 'err' })
      return
    }

    const model = effModel()
    if (!model.trim()) {
      openPanel()
      setStatus({ text: `${meta.label} 还没有配置模型名，请在模型配置里填写`, tone: 'err' })
      return
    }
    const key = effKey().trim()
    // 记下发起生成的工作区：期间用户可能切走，结果要送回正确的面板
    const genProject = activeProjectRef.current

    // 手机端可取消：本轮所有请求挂同一个取消句柄，取消时按它中断在途请求
    const cancelId = `g${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    cancelIdRef.current = cancelId

    setBusy(true)
    setCensor(false)
    // 新一轮生成开始：切条高亮回到「最新」，出图完成即归档为新历史；
    // 同时锁存本次生成的元数据，画板「存为模板」用（即使归档失败也有值）
    setViewingHistory(null)
    lastGenRef.current = { provider: settings.provider, model, prompt: rawPrompt }
    setStatus({ text: `正在生成图像 · ${meta.label}`, tone: 'busy' })
    const startedAt = Date.now()
    const genLog = (level: 'info' | 'error', rest: string) =>
      void logEvent(
        level,
        'generate',
        `provider=${settings.provider} model=${model} keyLen=${key.length} base=${base} ratio=${ratio.id} soft=${conf.soft !== false} adult=${!!conf.adult} refs=${refList.length} ${rest}`
      )
    try {
      let output = ''

      if (meta.shape === 'gemini') {
        const parts: Record<string, unknown>[] = [{ text: promptText }]
        for (const url of refList.slice(0, 4)) {
          const { mime, data } = await refDataUri(url)
          parts.push({ inline_data: { mime_type: mime, data } })
        }
        const { status, text } = await providerPost(
          `${base}/models/${model}:generateContent`,
          { 'Content-Type': 'application/json', 'x-goog-api-key': key },
          {
            json: JSON.stringify({
              contents: [{ parts }],
              generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: ratio.id } }
            }),
            cancelId
          }
        )
        if (status >= 400) throw new Error(`生成失败 ${status} · ${humanizeError(text.slice(0, 180))}`)
        const seg = (JSON.parse(text)?.candidates?.[0]?.content?.parts ?? []).find(
          (p: { inlineData?: { data?: string } }) => p?.inlineData?.data
        )
        if (seg?.inlineData?.data) {
          output = `data:${seg.inlineData.mimeType || 'image/png'};base64,${seg.inlineData.data}`
        }
      } else if (meta.shape === 'minimax') {
        const subject = refs.photo || refs.face || refs.pose || refs.costume
        const { status, text } = await providerPost(
          `${base}/image_generation`,
          { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
          {
            json: JSON.stringify({
              model,
              prompt: promptText,
              aspect_ratio: ratio.id,
              ...(subject ? { subject_reference: [{ type: 'character', image_file: subject }] } : {})
            }),
            cancelId
          }
        )
        if (status >= 400) throw new Error(`生成失败 ${status} · ${humanizeError(text.slice(0, 180))}`)
        const data = JSON.parse(text)
        if (data?.base_resp?.status_code) {
          throw new Error(`生成失败 · ${data.base_resp.status_msg || 'MiniMax 返回错误'}`)
        }
        output = data?.data?.image_urls?.[0] || ''
      } else if (meta.shape === 'gptimage') {
        // gpt-image-1 只接受 1024 方/竖/横三档尺寸
        const gptSize = ratio.w === ratio.h ? '1024x1024' : ratio.w > ratio.h ? '1536x1024' : '1024x1536'
        let out: HttpResult
        if (refList.length) {
          const files = []
          for (const url of refList.slice(0, 4)) {
            const { mime, data } = await refDataUri(url)
            const ext = (mime.split('/')[1] || 'png').replace('jpeg', 'jpg')
            files.push({ name: 'image[]', filename: `ref.${ext}`, mime, data })
          }
          out = await providerPost(
            `${base}/images/edits`,
            { Authorization: `Bearer ${key}` },
            { fields: [['model', model], ['prompt', promptText], ['size', gptSize]], files, cancelId }
          )
        } else {
          out = await providerPost(
            `${base}/images/generations`,
            { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
            { json: JSON.stringify({ model, prompt: promptText, size: gptSize }), cancelId }
          )
        }
        if (out.status >= 400) throw new Error(`生成失败 ${out.status} · ${humanizeError(out.text.slice(0, 180))}`)
        const b64 = JSON.parse(out.text)?.data?.[0]?.b64_json || ''
        if (b64) output = `data:image/png;base64,${b64}`
      } else {
        const body: Record<string, unknown> =
          meta.shape === 'siliconflow'
            ? {
                model,
                prompt: promptText,
                ...(refList[0] ? { image: refList[0] } : {}),
                ...(refList[1] ? { image2: refList[1] } : {}),
                ...(refList[2] ? { image3: refList[2] } : {})
              }
            : meta.shape === 'ark'
              ? {
                  model,
                  prompt: promptText,
                  image: refList.slice(0, 4),
                  response_format: 'url',
                  size: ratio.size
                }
              : {
                  model,
                  prompt: promptText,
                  ...(refList.length ? { image: refList } : {}),
                  size: ratio.size
                }
        const { status, text } = await providerPost(
          `${base}/images/generations`,
          { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
          { json: JSON.stringify(body), cancelId }
        )
        if (status >= 400) throw new Error(`生成失败 ${status} · ${humanizeError(text.slice(0, 180))}`)
        const data = JSON.parse(text)
        output = data?.data?.[0]?.url || data?.data?.[0]?.b64_json || ''
        if (output && !output.startsWith('http') && !output.startsWith('data:')) {
          output = `data:image/png;base64,${output}`
        }
      }

      if (output.startsWith('http') || output.startsWith('data:')) {
        deliverResult(genProject, output)
        setCensor(false)
        setStatus({ text: '生成完成', tone: 'ok' })
        genLog('info', `status=ok durMs=${Date.now() - startedAt}`)
        // 归档进本地历史（fire-and-forget：归档失败不影响出图本身）；
        // 同步记下这次生成用的描述/模型，画板「存为模板」时取用
        void archiveHistory(output, rawPrompt, genProject)
      } else {
        setStatus({ text: '响应里没有图像数据', tone: 'err' })
        genLog('error', `status=no-image durMs=${Date.now() - startedAt}`)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : `请求失败 · ${String(err)}`
      // 用户点了取消：不是错误，安静收场（已出的片子早已各自归档）
      if (msg === '__cancelled__') {
        setStatus({ text: '已取消', tone: 'neutral' })
        genLog('info', `status=cancelled durMs=${Date.now() - startedAt}`)
        return
      }
      const censored = isCensorError(msg)
      setCensor(censored)
      const statusMatch = /^生成失败 (\d+)/.exec(msg)
      genLog(
        'error',
        `status=${statusMatch ? statusMatch[1] : 'transport'} durMs=${Date.now() - startedAt} censor=${censored} msg=${msg}`
      )
      setStatus({ text: `${msg}（已记入日志）`, tone: 'err' })
    } finally {
      if (cancelIdRef.current === cancelId) cancelIdRef.current = null
      setBusy(false)
    }
  }

  // 最近一次失败是否疑似内容审核拦截：是则在底栏挂醒目提示条
  const [censor, setCensor] = useState(false)
  const generateRef = useRef(generate)
  generateRef.current = generate

  useEffect(() => {
    if (!preview) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPreview(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [preview])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault()
        generateRef.current()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const activeProvider = providerMeta(settings.provider)
  const hasKey = effKey().trim().length > 0
  const hasRef = Boolean(refs.pose || refs.photo)
  const step2Done = activeProvider.refs ? hasRef : prompt.trim().length > 0
  const ready = hasKey && step2Done

  // 画板顶部「已选参考」缩略条：选了什么显示什么，全空时不渲染整条（不留
  // 占位）。生成过渡幕在它下层，出图过程中也能看到这次用的是哪几张模板。
  // 点卡片放大预览。
  const stripRefs = (['photo', 'pose', 'costume', 'face'] as RefKey[]).filter((k) => refs[k])
  const stripLabel = (k: RefKey) => {
    const m = refMeta[k]
    return m ? `${REF_META[k].name} · ${m.name} ${m.code}`.trim() : REF_META[k].name
  }

  const dismissGuide = () => {
    setShowGuide(false)
    try {
      localStorage.setItem(`${STORAGE_KEY}.guide`, '1')
    } catch {
      // ignore storage failures
    }
  }

  // —— 生成历史 ——
  // 最近一次成功生成的元数据（描述随生成时点锁存，不是此刻输入框内容）：
  // 画板「存为模板」时与大模型/供应商一起入库，之后载入模板可原样回填
  const lastGenRef = useRef({ provider: '', model: '', prompt: '' })

  // 出图成功后归档（远端 URL 先转本地 data URI），失败静默：
  // 出图已经成功，历史只是锦上添花，不该反过来打扰用户。
  const archiveHistory = async (output: string, prompt: string, pid: number) => {
    try {
      let dataUrl = output
      if (!dataUrl.startsWith('data:image/')) {
        dataUrl = await invoke<string>('image_data_uri', { url: output, kind: 'result' })
      }
      const entry = await invoke<HistoryItem>('history_add', {
        dataUrl,
        provider: settings.provider,
        model: effModel(),
        prompt,
        ws: pid
      })
      // 桩/异常路径可能返回 null：没有合法 id 就不进列表
      if (entry && typeof entry.id === 'number') {
        // 旧桩不认 ws 参数：前端补上，保证按工作区过滤正确
        setHistory((prev) => [{ ...entry, ws: pid }, ...prev].slice(0, 50))
      }
    } catch {
      // ignore — 归档失败不打扰出图流程
    }
  }

  // 点历史缩略图 → 取原图上画板。此后 ⌘S 保存/预览作用的都是这张历史图；
  // 最新一张仍在历史里，不会丢。再次生成会自动回到「最新」视角。
  const viewHistory = async (item: HistoryItem) => {
    try {
      const uri = await invoke<string>('history_image', { id: item.id })
      setResult(uri)
      setViewingHistory(item.id)
      setStatus({ text: `历史成图 · ${historyTime(item.created)} · ${item.provider} ${item.model}`, tone: 'neutral' })
    } catch {
      setStatus({ text: '读取历史成图失败', tone: 'err' })
    }
  }

  // 删除一条历史（作品 Tab 用）：文件由后端清理，列表就地移除
  const deleteHistory = async (id: number) => {
    try {
      await invoke('history_delete', { id })
      setHistory((prev) => prev.filter((h) => h.id !== id))
      if (viewingHistory === id) setViewingHistory(null)
    } catch {
      setStatus({ text: '删除失败', tone: 'err' })
    }
  }

  // —— 生成模板 ——
  // 出图后「存为模板」，后续可基于这张图再生成：载入时会作为参考图回到
  // 参考槽位，生成时用的描述（如有）一并回填到描述框。
  // src 除了成图也可能是历史原图 data URI；仍是远程 URL 时先借下载缓存
  // 通道转成本地 data URI（画板上直接看到的成图多为 data URI，零开销）。
  const saveTemplate = async (src: string, meta: { provider: string; model: string; prompt: string }) => {
    if (!src) return
    try {
      let dataUrl = src
      if (!dataUrl.startsWith('data:image/')) {
        dataUrl = await invoke<string>('image_data_uri', { url: dataUrl, kind: 'result' })
      }
      const entry = await invoke<TemplateItem>('template_add', {
        dataUrl,
        provider: meta.provider,
        model: meta.model,
        prompt: meta.prompt
      })
      if (entry && typeof entry.id === 'number') {
        setTemplates((prev) => [entry, ...prev])
        setStatus({ text: '已存为模板 · 模板库里可基于它再出图', tone: 'ok' })
        void logEvent('info', 'template', `add id=${entry.id} provider=${entry.provider} model=${entry.model} size=${entry.size}`)
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (msg.includes('已在模板库')) {
        // 后端按图片字节去重的回复：不是失败，正常告知即可
        setStatus({ text: msg, tone: 'ok' })
        return
      }
      setStatus({ text: `存为模板失败：${msg}`, tone: 'err' })
      void logEvent('warn', 'template', `add failed: ${msg}`)
    }
  }

  // 历史图存为模板：先取该条原图（data URI），元数据直接用历史条里存的
  const saveTemplateFromHistory = async (item: HistoryItem) => {
    try {
      const uri = await invoke<string>('history_image', { id: item.id })
      await saveTemplate(uri, { provider: item.provider, model: item.model, prompt: item.prompt ?? '' })
    } catch {
      setStatus({ text: '存为模板失败：读取历史成图失败', tone: 'err' })
    }
  }

  // 画板「存为模板」：看的是最新出图就用生成时锁存的元数据；
  // 看的是历史图就用该历史条的元数据。
  const saveBoardTemplate = () => {
    if (!result) return
    const h = viewingHistory !== null ? history.find((x) => x.id === viewingHistory) : undefined
    const meta = h
      ? { provider: h.provider, model: h.model, prompt: h.prompt ?? '' }
      : lastGenRef.current
    void saveTemplate(result, {
      provider: meta.provider || settings.provider,
      model: meta.model || effModel(),
      prompt: meta.prompt
    })
  }

  // 载入模板：整图 data URI 装进参考槽位（模板是本机文件，比远程图库多
  // 一步后端读取）；模板带描述时回填描述框，方便「同一配方换个说法」
  const loadTemplateIntoSlot = async (tpl: TemplateItem, slot: RefKey) => {
    try {
      const uri = await invoke<string>('template_image', { id: tpl.id })
      setRef(slot, uri)
      if (tpl.prompt.trim()) setPrompt(tpl.prompt)
      setResult('')
      setMissing(null)
      setTemplateOpen(false)
      setStatus({
        text: `已把模板载入${REF_META[slot].name}${tpl.prompt.trim() ? '，描述已回填' : ''} · 可在此基础上再生成`,
        tone: 'ok'
      })
      void logEvent('info', 'template', `load id=${tpl.id} slot=${slot}`)
    } catch (e) {
      setStatus({ text: `载入模板失败：${e instanceof Error ? e.message : String(e)}`, tone: 'err' })
    }
  }

  const deleteTemplate = async (id: number) => {
    try {
      await invoke('template_delete', { id })
      setTemplates((prev) => prev.filter((t) => t.id !== id))
    } catch {
      setStatus({ text: '删除模板失败', tone: 'err' })
    }
  }

  // 保存成图：系统保存对话框 + Rust 落盘。webview 对 <a download> 的支持
  // 不可靠（WKWebView 常把它当页面导航），落盘这件事交给后端才稳。
  // 远端 URL 先借 Rust 的下载缓存通道转成 data: URI（前端 fetch 会撞 CORS）；
  // 纯浏览器开发预览没有对话框，退回老的 <a download> 路径。
  // 手机端作品查看器保存历史图时传入 src；桌面画板保存当前成图省略。
  const saveResult = async (src?: string) => {
    const target = src ?? result
    if (!target) return
    const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')
    let dataUrl = target
    if (!dataUrl.startsWith('data:image/')) {
      try {
        dataUrl = await invoke<string>('image_data_uri', { url: target, kind: 'result' })
      } catch {
        // 转不出来就只能走浏览器兜底
      }
    }
    const ext = /^data:image\/(png|jpeg|webp|gif)/.exec(dataUrl)?.[1]?.replace('jpeg', 'jpg') ?? 'png'
    try {
      const path = await save({
        title: '保存成图',
        defaultPath: `ziran-${stamp}.${ext}`,
        filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }]
      })
      if (!path) return // 用户取消了对话框
      await invoke('save_result_image', { path, dataUrl })
      setStatus({ text: `成图已保存：${path}`, tone: 'ok' })
    } catch (e) {
      void logEvent('error', 'save', `save_result_image failed: ${String(e)} ext=${ext} len=${dataUrl.length}`)
      try {
        const res = await fetch(dataUrl)
        const blob = await res.blob()
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `ziran-${stamp}.${ext}`
        a.click()
        setTimeout(() => URL.revokeObjectURL(url), 4000)
        setStatus({ text: '已开始下载成图（浏览器下载）', tone: 'ok' })
      } catch {
        openExternal(result)
        setStatus({ text: `没能保存（${String(e)}），已在系统浏览器打开图片，可右键另存`, tone: 'neutral' })
      }
    }
  }

  // ⌘S / Ctrl+S 保存成图
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 's') {
        e.preventDefault()
        void saveResult()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result])

  useEffect(() => {
    if (!showGuide) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') dismissGuide()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showGuide])

  const runPrimary = () => {
    if (!hasKey) {
      setMissing('key')
      setStatus({ text: `第一步：在模型配置里填写 ${activeProvider.label} 的 API Key`, tone: 'err' })
      openPanel()
      return
    }
    if (!step2Done) {
      setMissing('pose')
      if (activeProvider.refs) {
        setStatus({ text: '第二步：选一个姿势，或上传一张参考图', tone: 'err' })
        setGalleryOpen('pose')
      } else {
        setStatus({ text: `第二步：${activeProvider.label} 只按文字画图，先写一段描述`, tone: 'err' })
        promptRef.current?.focus()
      }
      return
    }
    setMissing(null)
    // 返回 promise：手机端连拍要按张顺序 await（取消/校验失败时为 undefined）
    return generate()
  }

  const primaryLabel = busy
    ? '生成中…'
    : !hasKey
      ? '第 1 步 · 配置模型'
      : !step2Done
        ? activeProvider.refs
          ? '第 2 步 · 选姿势 / 传照片'
          : '第 2 步 · 写描述'
        : '生成图像'

  const activeRef = refs[active]
  // 画板显示用本地解析出的 data URI：缩略图先上（秒显），全图到了再替换。
  // 直接把远程 URL 丢给 <img> 会吃满源站的慢链路，预热了本地库也用不上。
  const [boardSrc, setBoardSrc] = useState('')
  const [boardBusy, setBoardBusy] = useState(false)
  const canvasSource = result || boardSrc
  useEffect(() => {
    let cancelled = false
    setBoardSrc('')
    setBoardBusy(false)
    if (!activeRef) return
    if (activeRef.startsWith('data:')) {
      setBoardSrc(activeRef)
      return
    }
    const thumb = FULL_TO_THUMB.get(activeRef)
    if (thumb) {
      cachedSrc(thumb, active)
        .then((s) => {
          if (!cancelled) setBoardSrc((prev) => prev || s)
        })
        .catch(() => {})
    }
    setBoardBusy(true)
    cachedSrc(activeRef, 'ref')
      .then((s) => {
        if (!cancelled) {
          setBoardSrc(s)
          setBoardBusy(false)
        }
      })
      .catch(() => {
        // 纯浏览器开发模式没有后端：退回远程地址直显
        if (!cancelled) {
          setBoardSrc(activeRef)
          setBoardBusy(false)
        }
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRef])
  useEffect(() => {
    // 切换显示的图片时先回到默认画幅，等新图 onLoad 再贴合其比例
    setSrcDims(null)
  }, [canvasSource])
  const canvasLabel = result
    ? '生成结果'
    : activeRef
      ? active === 'pose' && refMeta.pose
        ? `姿势 · ${refMeta.pose.code} ${refMeta.pose.name}`
        : `${REF_META[active].name}`
      : '空画板'

  /* ---------- 手机端：与桌面共用的画板积木 ---------- */

  // 画板本体：桌面（.canvas-area 内）与手机（phone-canvas）渲染同一份
  // JSX——缩放变换、空态、下载按钮、缩放工具条都只有一处代码
  const renderArtboard = () => (
    <div className="artboard-shadow" style={{ transform: `scale(${zoom})` }}>
      <div className="artboard" style={{ width: boardW, height: boardH }}>
        <div className="checker" />
        {grid && <div className="artboard-grid" />}
        {canvasSource && (
          <img
            className="artboard-image"
            src={canvasSource}
            alt={canvasLabel}
            onLoad={(e) => setSrcDims({ w: e.currentTarget.naturalWidth || 1, h: e.currentTarget.naturalHeight || 1 })}
          />
        )}
        {!canvasSource && (
          <div className={`empty ${boardBusy ? 'is-loading' : ''}`}>
            <Icon name="image" size={30} />
          </div>
        )}
        <span className="artboard-tag">{canvasLabel}</span>
        {!result && boardBusy && canvasSource && (
          <span className="board-upgrading">高清原图加载中…</span>
        )}
        {/* 保存按钮直接浮在成图图层上：平时隐形，悬停画板才现身；
            反向缩放抵消画板的 transform，按钮大小不随 zoom 变 */}
        {result && (
          <>
            <button
              className="artboard-tpl"
              title="存为模板，之后可基于这张图再生成"
              onClick={saveBoardTemplate}
              style={{ transform: `scale(${Number((1 / zoom).toFixed(3))})` }}
            >
              <Icon name="bookmark" size={15} />
            </button>
            <button
              className="artboard-download"
              title="保存成图（⌘S）"
              onClick={() => saveResult()}
              style={{ transform: `scale(${Number((1 / zoom).toFixed(3))})` }}
            >
              <Icon name="download" size={15} />
            </button>
          </>
        )}
        {/* 缩放工具条：浮在图片图层底部内侧（半透明胶囊）。transform 同时做
            居中定位与反向缩放（抵消画板 scale，钳制 0.9–1.25 倍，文字大小始终接近原大） */}
        <div
          className="canvas-hud"
          style={{
            transform: `translateX(-50%) scale(${Number(Math.max(0.9, Math.min(1.25, 1 / zoom)).toFixed(3))})`,
          }}
        >
          <button className="hud-btn" onClick={() => bumpZoom(-0.1)} title="缩小">
            <Icon name="zoomOut" size={16} />
          </button>
          <button className="hud-zoom" onClick={() => setAutoFit(true)} title="适应窗口">
            {Math.round(zoom * 100)}%
          </button>
          <button className="hud-btn" onClick={() => bumpZoom(0.1)} title="放大">
            <Icon name="zoomIn" size={16} />
          </button>
          <span className="hud-sep" />
          <span className="hud-meta">{activeRatio.size.replace('x', ' × ')}</span>
        </div>
      </div>
    </div>
  )

  // 生成历史切换条：画板下方的快速切换胶片，只放最近几张（完整列表在
  // 左侧历史面板）。多于一张才显示（一张没有切换的意义）。
  // viewingHistory 为 null（刚生成完）时高亮最新一张。
  const HISTORY_STRIP_KEEP = 8
  // 画板下的「最近出图」条按工作区隔离：只显示当前工作区生成的图（老记录默认工作区 1，
  // 新开的工作区为空）。rail 上的历史浮层面板仍是全局共用，所有工作区都能看到全部。
  const wsHistory = history.filter((h) => (h.ws ?? 1) === activeProject)
  const renderHistoryStrip = () => (
    <div className="history-strip" aria-label="生成历史">
      {wsHistory.slice(0, HISTORY_STRIP_KEEP).map((h) => {
        const isCurrent = viewingHistory === h.id || (viewingHistory === null && h.id === wsHistory[0].id)
        return (
          <button
            key={h.id}
            className={`history-card${isCurrent ? ' is-current' : ''}`}
            title={`${historyTime(h.created)} · ${h.provider} ${h.model}${isCurrent ? ' · 当前' : ''}`}
            onClick={() => void viewHistory(h)}
          >
            <HistoryThumb id={h.id} />
            {/* 悬停书签：把这条历史直接存成模板（元数据取自该条） */}
            <span
              className="history-tpl"
              role="button"
              aria-label="存为模板"
              title="存为模板"
              onClick={(e) => {
                e.stopPropagation()
                void saveTemplateFromHistory(h)
              }}
            >
              <Icon name="bookmark" size={11} />
            </span>
          </button>
        )
      })}
    </div>
  )

  // 历史浮层面板：rail 图标点开，浮在画板左侧。点击图片回画板细看（面板
  // 随之收起）；悬停出书签（存为模板）与删除（两击确认）。点外部 / Esc 关闭。
  const armPanelDelete = (id: number) => {
    setArmDelId(id)
    window.clearTimeout(armDelT.current)
    armDelT.current = window.setTimeout(() => setArmDelId(null), 2600)
  }
  const renderHistoryFlyout = () => (
    <>
      <div className="history-flyout-backdrop" onClick={() => setHistPanelOpen(false)} />
      <aside className="history-flyout" aria-label="生成历史">
        <header className="history-flyout-head">
          <span>历史</span>
          {history.length > 0 && <span className="history-panel-count">{history.length}</span>}
          <button
            className="history-flyout-close"
            onClick={() => setHistPanelOpen(false)}
            aria-label="关闭历史面板"
            title="关闭"
          >
            <Icon name="close" size={14} />
          </button>
        </header>
        <div className="history-flyout-body">
          {history.map((h) => {
            const isCurrent = viewingHistory === h.id || (viewingHistory === null && h.id === history[0].id)
            const armed = armDelId === h.id
            return (
              <div key={h.id} className={`history-item${isCurrent ? ' is-current' : ''}`}>
                <button
                  className="history-item-view"
                  title={`${historyTime(h.created)} · ${h.provider} ${h.model}${isCurrent ? ' · 当前' : ''}`}
                  onClick={() => {
                    void viewHistory(h)
                    setHistPanelOpen(false)
                  }}
                >
                  <HistoryThumb id={h.id} />
                </button>
                <span className="history-item-tools">
                  <span
                    className="history-tpl"
                    role="button"
                    aria-label="存为模板"
                    title="存为模板"
                    onClick={(e) => {
                      e.stopPropagation()
                      void saveTemplateFromHistory(h)
                    }}
                  >
                    <Icon name="bookmark" size={11} />
                  </span>
                  <span
                    className={`history-del${armed ? ' is-arm' : ''}`}
                    role="button"
                    aria-label={armed ? '再点一次确认删除' : '删除'}
                    title={armed ? '再点一次确认删除' : '删除'}
                    onClick={(e) => {
                      e.stopPropagation()
                      if (armed) {
                        window.clearTimeout(armDelT.current)
                        setArmDelId(null)
                        void deleteHistory(h.id)
                      } else {
                        armPanelDelete(h.id)
                      }
                    }}
                  >
                    <Icon name="trash" size={10} />
                  </span>
                </span>
              </div>
            )
          })}
          {!history.length && <p className="history-panel-empty">生成过的图会自动收进这里</p>}
        </div>
      </aside>
    </>
  )

  // 工作区标签条：每个工程一个独立面板（参考图/描述/画布互不串），
  // 悬停标签出 ×；「+」新建。仅桌面（手机端保持单面板）。
  const renderProjectTabs = () => (
    <div className="ws-tabs" aria-label="工作区">
      {projects.map((p) => (
        <div key={p.id} className={`ws-tab${p.id === activeProject ? ' is-active' : ''}`}>
          <button className="ws-tab-name" title={p.name} onClick={() => switchProject(p.id)}>
            {p.name}
          </button>
          {projects.length > 1 && (
            <span
              className="ws-tab-x"
              role="button"
              aria-label={`关闭 ${p.name}`}
              title="关闭此工作区"
              onClick={(e) => {
                e.stopPropagation()
                closeProject(p.id)
              }}
            >
              <Icon name="close" size={9} />
            </span>
          )}
        </div>
      ))}
      <button className="ws-tab-add" onClick={createProject} aria-label="新建工作区" title="新建工作区 · 独立的参考图与画板">
        <Icon name="plus" size={12} />
      </button>
    </div>
  )

  const renderGenVeil = () => (
    <div className="gen-veil" role="status" aria-live="polite">
      <span className="gen-ring" />
      <p className="gen-title">正在生成图像 · {activeProvider.label}</p>
      <p className="gen-sub">
        请求已发往 {activeProvider.sub || '服务商'}，一般 10–30 秒出图；可以继续浏览，完成后自动载入画板
      </p>
    </div>
  )

  // 手机端整棵 UI 树（创作/作品/设置 + 底部导航 + 浮层）。
  // 状态归属在本组件，PhoneApp 只负责呈现与手机侧交互。
  // 依赖的 canvasSource/canvasLabel 等已在前文就绪，放在 return 之前组装。
  const phoneEl = isPhone ? (
    <PhoneApp
      settings={settings}
      update={update}
      providers={providers}
      activeProvider={activeProvider}
      effModel={effModel}
      hasKey={hasKey}
      refs={refs}
      refMeta={refMeta}
      setActive={setActive}
      clearSlot={(k) => setRefs((prev) => ({ ...prev, [k]: null }))}
      pickFile={pickFile}
      prompt={prompt}
      setPrompt={setPrompt}
      busy={busy}
      runPrimary={runPrimary}
      cancelGenerate={cancelGenerate}
      setSlotImage={setSlotImage}
      status={status}
      history={history}
      deleteHistory={deleteHistory}
      saveImage={saveResult}
      templates={templates}
      saveTemplateFromHistory={saveTemplateFromHistory}
      saveCanvasTemplate={saveBoardTemplate}
      loadTemplateIntoSlot={loadTemplateIntoSlot}
      canvasSource={canvasSource}
      canvasBusy={boardBusy}
      canvasLabel={canvasLabel}
      hasResult={Boolean(result)}
      galleryOpen={galleryOpen}
      setGalleryOpen={setGalleryOpen}
      preview={preview}
      setPreview={setPreview}
      openPanel={openPanel}
      setShowGuide={setShowGuide}
    />
  ) : null

  return (
    <div className="shell">
      {/* 手机端专属界面：坐标在 CSS 的手机段里（桌面三区按 isPhone 不再挂载） */}
      {phoneEl}

      {!isPhone && (
      <header className="titlebar">
        <div className="brand">
          <svg className="brand-mark" width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 2.6l9.4 9.4-9.4 9.4L2.6 12z" fill="none" stroke="currentColor" strokeWidth="1.6" />
            <path d="M12 7.4l4.6 4.6-4.6 4.6L7.4 12z" fill="currentColor" />
          </svg>
          <span className="brand-name">Ziran</span>
        </div>
        <span className="divider" />
        {renderProjectTabs()}

        <div className="titlebar-spacer" />

        <div className="titlebar-actions">
          <button className="icon-btn" title="撤销" disabled>
            <Icon name="undo" size={17} />
          </button>
          <button className="icon-btn" title="重做" disabled>
            <Icon name="redo" size={17} />
          </button>
          <span className="divider" />
          <span className={`pill ${hasKey ? 'pill-ok' : 'pill-warn'}`}>
            <span className="dot" />
            {hasKey ? 'API 就绪' : 'API 未配置'}
          </span>
          <button className="icon-btn" title="使用说明" onClick={() => setShowGuide(true)}>
            <Icon name="help" size={17} />
          </button>
          <button
            className="icon-btn"
            title={settings.theme === 'light' ? '切换到暗色' : '切换到亮色'}
            onClick={() => update({ theme: settings.theme === 'light' ? 'dark' : 'light' })}
          >
            <Icon name={settings.theme === 'light' ? 'moon' : 'sun'} size={17} />
          </button>
        </div>
      </header>

      )}

      {!isPhone && (
      <div className="workspace">
        <nav className="rail">
          <div className="rail-group">
            <button className="rail-btn is-active" data-tip="选择工具">
              <Icon name="pointer" />
            </button>
            <span className="rail-sep" />
            {(Object.keys(REF_META) as RefKey[]).map((key) => (
              <button
                key={key}
                className={`rail-btn ${active === key ? 'is-active' : ''}`}
                data-tip={`${REF_META[key].name}${refs[key] ? ' · 已载入' : ''}`}
                onClick={() => setActive(key)}
              >
                <Icon name={key === 'photo' ? 'image' : key === 'pose' ? 'pose' : key === 'costume' ? 'shirt' : 'face'} />
                {refs[key] && <span className="rail-badge" />}
              </button>
            ))}
            <span className="rail-sep" />
            <button className="rail-btn" data-tip="姿势图库" onClick={() => setGalleryOpen('pose')}>
              <Icon name="library" />
            </button>
            <button className="rail-btn" data-tip="模板库 · 基于已有成图再生成" onClick={() => setTemplateOpen(true)}>
              <Icon name="bookmark" />
              {templates.length > 0 && <span className="rail-badge" />}
            </button>
            <button
              className={`rail-btn ${histPanelOpen ? 'is-active' : ''}`}
              data-tip="历史 · 全部成图"
              onClick={() => setHistPanelOpen((v) => !v)}
            >
              <Icon name="history" />
              {history.length > 0 && <span className="rail-count">{history.length > 99 ? '99+' : history.length}</span>}
            </button>
            <button
              className={`rail-btn ${grid ? 'is-active' : ''}`}
              data-tip="网格叠加"
              onClick={() => setGrid((v) => !v)}
            >
              <Icon name="grid" />
            </button>
            <button
              className="rail-btn"
              data-tip="适应窗口"
              onClick={() => setAutoFit(true)}
            >
              <Icon name="fit" />
            </button>
          </div>
        </nav>

        {/* 历史浮层面板：rail「历史」图标点开（画板下胶片条只留最近几张） */}
        {histPanelOpen && renderHistoryFlyout()}

        <section
          className={`canvas-area ${dragging ? 'is-dragging' : ''} ${stripRefs.length > 0 ? 'has-strip' : ''}`}
          ref={areaRef}
          onDragOver={(e) => {
            e.preventDefault()
            setDragging(true)
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={async (e) => {
            e.preventDefault()
            setDragging(false)
            await pickFile(e.dataTransfer.files?.[0], active)
          }}
        >
          {/* 已选参考缩略条：画板上方居中的独立横带（流内布局），出图时也不叠住图片 */}
          {stripRefs.length > 0 && (
            <div className="ref-strip" aria-label="已选参考">
              {stripRefs.map((k) => (
                <button
                  key={k}
                  className="ref-strip-card"
                  title={`点击放大 · ${stripLabel(k)}`}
                  onClick={() => setPreview({ src: refs[k] as string, title: stripLabel(k) })}
                >
                  <span className="ref-strip-thumb">
                    <RefThumb url={refs[k]} kind={k} />
                  </span>
                </button>
              ))}
            </div>
          )}

          {renderArtboard()}

          {/* 生成历史切换条：本工作区多于一张才显示（一张没有切换的意义）。
              viewingHistory 为 null（刚生成完）时高亮最新一张。 */}
          {wsHistory.length > 1 && renderHistoryStrip()}

          {busy && renderGenVeil()}

          {!canvasSource && (
            <div className="canvas-hint">
              <p className="hint-title">三步开始出图</p>
              <ol className="hint-steps">
                <li className={hasKey ? 'is-done' : ''}>
                  <span className="hint-num">{hasKey ? <Icon name="check" size={10} /> : 1}</span>
                  配置模型{hasKey ? <em>已完成</em> : <em>必填</em>}
                </li>
                <li className={step2Done ? 'is-done' : ''}>
                  <span className="hint-num">{step2Done ? <Icon name="check" size={10} /> : 2}</span>
                  {activeProvider.refs ? '选姿势 / 传照片' : '写一段描述'}
                  {step2Done ? <em>{activeProvider.refs ? '已选' : '已写'}</em> : <em>必填</em>}
                </li>
                <li className={ready ? '' : 'is-muted'}>
                  <span className="hint-num">3</span>
                  点“生成图像”
                </li>
              </ol>
              <button
                className="ghost-btn"
                onClick={() => (hasKey ? setGalleryOpen('pose') : openPanel())}
              >
                <Icon name={hasKey ? 'library' : 'settings'} size={14} />
                {hasKey ? '打开姿势图库' : '去配置模型'}
              </button>
            </div>
          )}

        </section>

        <aside className="inspector">
          <div className="stepper">
            <button className={`step ${hasKey ? 'is-done' : 'is-current'}`} onClick={() => openPanel()}>
              <span className="step-num">{hasKey ? <Icon name="check" size={11} /> : 1}</span>
              <span className="step-text">选模型</span>
            </button>
            <span className={`step-line ${hasKey ? 'is-done' : ''}`} />
            <button
              className={`step ${!hasKey ? '' : step2Done ? 'is-done' : 'is-current'}`}
              onClick={() => (activeProvider.refs ? setGalleryOpen('pose') : promptRef.current?.focus())}
            >
              <span className="step-num">{step2Done ? <Icon name="check" size={11} /> : 2}</span>
              <span className="step-text">{activeProvider.refs ? '选姿势' : '写描述'}</span>
            </button>
            <span className={`step-line ${ready ? 'is-done' : ''}`} />
            <button className={`step ${ready ? 'is-current' : ''}`} onClick={runPrimary}>
              <span className="step-num">3</span>
              <span className="step-text">生成</span>
            </button>
          </div>

          <div className="section">
            <div className="section-head">
              <span>① 选模型</span>
              <span className={`badge ${hasKey ? 'badge-ok' : 'badge-warn'}`}>{hasKey ? '已配置' : '需配置'}</span>
            </div>

            <div className="model-row">
              <select
                className="input model-pick"
                value={settings.provider}
                onChange={(e) => switchProvider(e.target.value)}
                title="切换模型，各模型的 Key 在模型配置里分别填写"
              >
                {providers.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label} · {effModel(p.value)}
                  </option>
                ))}
              </select>
              <button className="config-btn" onClick={() => openPanel()} title="模型配置：每个模型的 API Key / 模型名 / 接口地址">
                <Icon name="settings" size={15} />
                配置
              </button>
            </div>

            <p className="provider-desc">{activeProvider.desc}</p>
          </div>

          <div className="section">
            <div className="section-head">
              <span>画幅比例</span>
              <span className="section-count">{activeRatio.size}</span>
            </div>
            <div className="ratio-row">
              {RATIOS.map((r) => (
                <button
                  key={r.id}
                  className={`ratio ${settings.ratio === r.id ? 'is-active' : ''}`}
                  onClick={() => update({ ratio: r.id })}
                  title={r.size}
                >
                  <span className="ratio-box" style={{ width: `${12 + (r.w / r.h) * 12}px`, height: `${12 + (r.h / r.w) * 12}px` }} />
                  {r.label}
                </button>
              ))}
            </div>
          </div>

          <div className="section">
            <div className="section-head">
              <span>② 参考图</span>
              <span className="section-count">
                {activeProvider.refs ? '照片、人脸、姿势、服装可自由叠加' : '当前服务商不支持参考图'}
              </span>
            </div>
            {(Object.keys(REF_META) as RefKey[]).map((key) => (
              <div
                key={key}
                className={`ref-row ${active === key ? 'is-active' : ''}`}
                onClick={() => setActive(key)}
              >
                <div
                  className={`ref-thumb ${refs[key] ? 'is-clickable' : ''}`}
                  onClick={(e) => {
                    if (refs[key]) {
                      e.stopPropagation()
                      setPreview({ src: refs[key] as string, title: REF_META[key].name })
                    }
                  }}
                  title={refs[key] ? '点击查看大图' : undefined}
                >
                  {refs[key] ? <RefThumb url={refs[key]} kind={key} /> : <Icon name="plus" size={14} />}
                </div>
                <div className="ref-meta">
                  <span className="ref-name">{REF_META[key].name}</span>
                  <span className="ref-hint">
                    {refMeta[key]
                      ? `${refMeta[key]!.name}${refMeta[key]!.angle && refMeta[key]!.angle !== '参考' ? ` · ${refMeta[key]!.angle}` : ''}`
                      : refs[key]
                        ? '已载入'
                        : REF_META[key].hint}
                  </span>
                </div>
                <div className="ref-actions">
                  {CATALOGS[key] && (
                    <button
                      className="mini-btn"
                      title={`${REF_META[key].name}图库`}
                      onClick={(e) => {
                        e.stopPropagation()
                        setGalleryOpen(key)
                      }}
                    >
                      <Icon name="library" size={14} />
                    </button>
                  )}
                  <label className="mini-btn" title={refs[key] ? '替换' : '载入'}>
                    <Icon name={refs[key] ? 'image' : 'plus'} size={14} />
                    <input
                      type="file"
                      accept="image/*"
                      hidden
                      onChange={async (e) => {
                        await pickFile(e.target.files?.[0], key)
                        e.target.value = ''
                      }}
                    />
                  </label>
                  <button
                    className="mini-btn"
                    title="移除"
                    disabled={!refs[key]}
                    onClick={(e) => {
                      e.stopPropagation()
                      setRefs((prev) => ({ ...prev, [key]: null }))
                    }}
                  >
                    <Icon name="trash" size={14} />
                  </button>
                </div>
              </div>
            ))}
          </div>

          <div className="section">
            <div className="section-head">
              <span>③ 描述</span>
              <span className={`badge ${activeProvider.refs ? 'badge-neutral' : 'badge-warn'}`}>
                {activeProvider.refs ? '可选' : '必填'}
              </span>
            </div>
            <textarea
              ref={promptRef}
              className={`input textarea ${missing === 'pose' && !activeProvider.refs && !prompt.trim() ? 'is-error' : ''}`}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={
                activeProvider.refs
                  ? '不填也行，默认沿用参考图里的人物、服装和姿势'
                  : `描述要画什么，例如：一位穿冲锋衣的年轻女性站在雪山下`
              }
              rows={3}
            />
          </div>

          <div className="inspector-footer">
            {censor && (
              <div className="censor-note" role="alert">
                <div className="censor-head">⛔ 疑似内容审核拦截 · 不是软件故障</div>
                <p className="censor-body">
                  服务商的安全审核没有放行这次生成（描述或参考图里有它认为敏感的内容），Key、网络与接口都正常。
                  可以打开「模型配置」给当前模型开启「委婉描述」（改用含蓄说法，多数能过），
                  或开启「允许成人向内容」解除得体约束；也可以接入不限制内容的服务商。
                </p>
                <button className="key-jump censor-jump" onClick={() => openPanel()}>
                  打开模型配置调整
                </button>
              </div>
            )}
            <button className={`primary ${!ready && !busy ? 'is-guiding' : ''}`} onClick={runPrimary} disabled={busy}>
              <Icon name={ready ? 'sparkle' : hasKey ? 'library' : 'settings'} size={16} />
              {primaryLabel}
            </button>
            <p className="footer-note">
              {ready ? '⌘↵ 快捷生成 · 结果自动载入画板' : '按顺序完成两步，按钮就会变成“生成图像”'}
            </p>
          </div>
        </aside>
      </div>
      )}

      {galleryOpen && CATALOGS[galleryOpen] && (
        <RefGallery
          key={galleryOpen}
          kind={galleryOpen}
          catalog={CATALOGS[galleryOpen]}
          activeCode={refMeta[galleryOpen]?.code ?? ''}
          hideSensitive={galleryOpen === 'costume' && !effConfig().adult}
          onClose={() => setGalleryOpen(null)}
          onApply={(item, view) => {
            const kind = galleryOpen
            const url = assetUrl(CATALOGS[kind]!.origin, view.full)
            setRef(kind, url)
            // 预热整图进本地库：之后断网也能用这张参考生成
            invoke('image_data_uri', { url, kind }).catch(() => {})
            setRefMeta((prev) => ({ ...prev, [kind]: { name: item.name, code: item.code, angle: view.angle } }))
            setResult('')
            setMissing(null)
            setGalleryOpen(null)
            setStatus({ text: `已载入${REF_META[kind].name} ${item.code} ${item.name}${view.angle && view.angle !== '参考' ? ` · ${view.angle}` : ''}`, tone: 'ok' })
          }}
        />
      )}

      {!isPhone && templateOpen && (
        <TemplateGallery
          items={templates}
          onClose={() => setTemplateOpen(false)}
          onLoad={(tpl, slot) => void loadTemplateIntoSlot(tpl, slot)}
          onDelete={(t) => void deleteTemplate(t.id)}
        />
      )}

      {preview && (
        <div className="overlay" onClick={() => setPreview(null)}>
          <div className="preview-card" onClick={(e) => e.stopPropagation()}>
            <button className="preview-close" onClick={() => setPreview(null)} title="关闭" aria-label="关闭">
              <Icon name="close" size={18} />
            </button>
            <div className="preview-body">
              <PreviewImg url={preview.src} />
            </div>
            <div className="preview-title">{preview.title}</div>
          </div>
        </div>
      )}

      {showGuide && (
        <div className="overlay" onClick={dismissGuide}>
          <div className="guide" onClick={(e) => e.stopPropagation()}>
            <div className="guide-head">
              <Icon name="sparkle" size={18} />
              <h2>三步就能出图</h2>
              <button className="icon-btn guide-close" onClick={dismissGuide} title="关闭">
                <Icon name="close" size={15} />
              </button>
            </div>
            <ol className="guide-steps">
              <li>
                <span className="guide-num">1</span>
                <div>
                  <b>配置模型</b>
                  <p>打开「模型配置」，给要用的模型填上 API Key（每个模型的 Key 分开保存，只需填一次）。</p>
                </div>
              </li>
              <li>
                <span className="guide-num">2</span>
                <div>
                  <b>选姿势或传照片</b>
                  <p>从姿势图库挑一张线稿，或直接上传一张参考图——两者给一个就能出图；服装和人脸可选，加了更像。</p>
                </div>
              </li>
              <li>
                <span className="guide-num">3</span>
                <div>
                  <b>点“生成图像”</b>
                  <p>结果会自动出现在中间的画板里，右上角可以下载。</p>
                </div>
              </li>
            </ol>
            <div className="guide-actions">
              <button className="ghost-btn" onClick={dismissGuide}>
                我先自己看看
              </button>
              <button
                className="primary guide-start"
                onClick={() => {
                  dismissGuide()
                  openPanel()
                }}
              >
                开始第 1 步
              </button>
            </div>
          </div>
        </div>
      )}

      {panelOpen && (
        <div className="overlay" onClick={() => setPanelOpen(false)}>
          <div className="model-panel" onClick={(e) => e.stopPropagation()}>
            <div className="panel-head">
              <Icon name="settings" size={16} />
              <h2>模型配置</h2>
              <span className="panel-hint">每个模型的 API Key 分开保存 · 只存本机</span>
              <button className="icon-btn" onClick={() => setPanelOpen(false)} title="关闭" aria-label="关闭">
                <Icon name="close" size={16} />
              </button>
            </div>
            <div className="panel-body">
              <nav className="panel-list">
                {providers.map((p) => {
                  const hasK = effKey(p.value).trim().length > 0
                  return (
                    <button
                      key={p.value}
                      className={`panel-item ${panelProvider === p.value ? 'is-active' : ''}`}
                      onClick={() => setPanelProvider(p.value)}
                    >
                      <span className={`key-dot ${hasK ? 'is-ok' : ''}`} />
                      <span className="panel-item-text">
                        <span className="panel-item-label">{p.label}</span>
                        <span className="panel-item-sub">{p.sub}</span>
                      </span>
                    </button>
                  )
                })}
                <button
                  className="panel-add"
                  onClick={() => void addCustomProvider()}
                  title="新增一个 OpenAI 兼容的中转站，名称可改、可加多个"
                >
                  ＋ 新增中转站
                </button>
              </nav>
              <div className="panel-edit">
                <p className="provider-desc">{panelMeta.desc}</p>
                {isCustomProvider(panelMeta.value) && (
                  <div className="field">
                    <label>名称</label>
                    <input
                      ref={nameInputRef}
                      className="input"
                      defaultValue={panelMeta.label}
                      key={`name-${panelMeta.value}`}
                      placeholder="给这个中转站起个名字，如「XX 中转」"
                      onBlur={(e) => void renameCustomProvider(panelMeta.value, e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                      }}
                    />
                    <p className="help">只改列表里的显示名（回车或点别处保存）；Key、模型仍按供应商各存各的</p>
                  </div>
                )}
                <div className="field">
                  <label>API Key</label>
                  <div className="key-row">
                    <input
                      className="input mono"
                      type="password"
                      value={effKey(panelMeta.value)}
                      onChange={(e) => updateProviderConfig(panelMeta.value, { apiKey: e.target.value })}
                      placeholder={`粘贴 ${panelMeta.label} 的 API Key`}
                    />
                    {panelMeta.keyUrl && (
                      <button className="key-link" onClick={() => openExternal(panelMeta.keyUrl)} title={`申请入口 · ${panelMeta.keyHint}`}>
                        <Icon name="chevron" size={13} />
                      </button>
                    )}
                  </div>
                  <p className="help">
                    {panelMeta.keyUrl && (
                      <button className="key-jump" onClick={() => openExternal(panelMeta.keyUrl)}>
                        一键前往申请页 ↗
                      </button>
                    )}
                    {panelMeta.keyHint} · 自动保存
                  </p>
                </div>
                <div className="field">
                  <label>模型</label>
                  <input
                    className="input mono"
                    value={effConfig(panelMeta.value).model}
                    onChange={(e) => updateProviderConfig(panelMeta.value, { model: e.target.value })}
                    placeholder={panelMeta.model}
                  />
                </div>
                <div className="field">
                  <label>接口地址</label>
                  <input
                    className="input mono"
                    value={effConfig(panelMeta.value).baseUrl}
                    onChange={(e) => updateProviderConfig(panelMeta.value, { baseUrl: e.target.value })}
                    placeholder={panelMeta.baseUrl}
                  />
                </div>
                <div className="field">
                  <label>内容合规</label>
                  <div className="panel-check">
                    <label title="生成时自动把提示词改写得含蓄些，并剥掉「不要人/不要皮肤」这类易触发审核的短语；提示词不再原样发出">
                      <input
                        type="checkbox"
                        checked={effConfig(panelMeta.value).soft !== false}
                        onChange={(e) => updateProviderConfig(panelMeta.value, { soft: e.target.checked })}
                      />
                      <span>委婉描述（避开内容审核）</span>
                    </label>
                    <label title="不附加「画面得体、可公开展示」的约束句；服装图库会同时显示内衣・睡衣、性感穿搭、泳装・度假等敏感分类">
                      <input
                        type="checkbox"
                        checked={!!effConfig(panelMeta.value).adult}
                        onChange={(e) => updateProviderConfig(panelMeta.value, { adult: e.target.checked })}
                      />
                      <span>允许成人向内容（解除得体约束）</span>
                    </label>
                    <p className="help">
                      只对「{panelMeta.label}」生效，默认打开；被审核拦下时保持打开多数能过，服务商不限制内容时可关掉。
                    </p>
                  </div>
                </div>
                <div className="field">
                  <label>连通性测试</label>
                  <div className="test-row">
                    <button
                      className="test-btn"
                      disabled={testing !== null}
                      title="发一次最小生成请求验证 Key、模型与网络，与正式生成走同一链路"
                      onClick={() => void runTest(panelMeta.value)}
                    >
                      {testing === panelMeta.value ? '测试中…' : '测试连通'}
                    </button>
                    {testing !== panelMeta.value && testOut[panelMeta.value] && (
                      <span className={`test-out ${testOut[panelMeta.value].ok ? 'is-ok' : 'is-bad'}`}>
                        {testOut[panelMeta.value].ok ? '✓' : '✗'} {testOut[panelMeta.value].text}
                      </span>
                    )}
                  </div>
                  <p className="help">发一次最小生成请求验证 Key、模型与网络；可能产生少量费用。</p>
                </div>
                {!panelMeta.refs && <p className="help">该模型只按文字画图，不支持参考图。</p>}
                {panelMeta.value.startsWith('custom-') && (
                  <div className="field">
                    <label>删除</label>
                    <DeleteConfirm
                      label="删除这个中转站，连同它的 Key"
                      onConfirm={() => void deleteCustomProvider(panelMeta.value)}
                    />
                  </div>
                )}
              </div>
            </div>
            <div className="panel-foot">
              <div className="provider-config">
                {/* 手机端没有系统编辑器/日志查看的入口，这三项只留在桌面 */}
                {!isPhone && (
                  <>
                    <span className="provider-config-label">providers.json</span>
                    <button
                      className="key-jump"
                      title={providersPath || '用系统文本编辑器打开 providers.json'}
                      onClick={() =>
                        invoke<string | null>('read_config_file', { name: 'providers.json' })
                          .then((cur) =>
                            cur === null
                              ? invoke('write_config_file', { name: 'providers.json', contents: JSON.stringify(DEFAULT_PROVIDERS, null, 2) })
                              : undefined,
                          )
                          .then(() => invoke('edit_config_file', { name: 'providers.json' }))
                          .then(() => setStatus({ text: 'providers.json 已在系统文本编辑器打开，改完保存，回来点「重新加载」生效', tone: 'ok' }))
                          .catch(() => setStatus({ text: '没能打开编辑器，可手动编辑配置文件夹里的 providers.json', tone: 'err' }))
                      }
                    >
                      编辑配置文件 ↗
                    </button>
                    <button className="key-jump" onClick={() => void applyProvidersFile(true)}>
                      重新加载
                    </button>
                    <button
                      className="key-jump"
                      title="打开 ziran.log：生成与连通性测试的错误都记录在这里（不含 Key）"
                      onClick={() =>
                        invoke('open_log_file')
                          .then(() => setStatus({ text: 'ziran.log 已在文本编辑器打开', tone: 'ok' }))
                          .catch(() => setStatus({ text: '没能打开日志文件', tone: 'err' }))
                      }
                    >
                      打开日志
                    </button>
                  </>
                )}
                <button
                  className="key-jump"
                  onClick={() =>
                    invoke('write_config_file', { name: 'providers.json', contents: JSON.stringify(DEFAULT_PROVIDERS, null, 2) })
                      .then(() => {
                        setProviders(DEFAULT_PROVIDERS)
                        setStatus({ text: '已恢复内置供应商默认配置', tone: 'ok' })
                      })
                      .catch(() => setStatus({ text: '当前是开发预览，没有本地配置目录', tone: 'err' }))
                  }
                >
                  恢复默认
                </button>
              </div>
              <button className="primary panel-done" onClick={() => setPanelOpen(false)}>
                完成
              </button>
            </div>
          </div>
        </div>
      )}

      {!isPhone && (
      <footer className="statusbar">
        <div className="status-left">
          <span className={`dot dot-${status.tone}`} />
          <span className="status-text">{status.text}</span>
        </div>
        <div className="status-right">
          <span>缩放 {Math.round(zoom * 100)}%</span>
          <span className="status-sep" />
          <span>RGB · 8 位</span>
          <span className="status-sep" />
          <span className="mono">{activeProvider.label} / {effModel()}</span>
          <span className="status-sep" />
          <span className="mono">{hasKey ? '密钥已设置' : '密钥未设置'}</span>
          <span className="status-sep" />
          <span className="mono">v{APP_VERSION}</span>
        </div>
      </footer>
      )}
    </div>
  )
}

/* 模板库浮层（桌面）：用户收藏的成图，选中后作为参考图载入画板，
   有描述的模板连提示词一起回填——「同一配方换个说法」直接再生成。
   不分页/不搜索（模板是用户亲手存的，量级远小于内置图库）。 */
function TemplateGallery({
  items,
  onClose,
  onLoad,
  onDelete
}: {
  items: TemplateItem[]
  onClose: () => void
  onLoad: (t: TemplateItem, slot: RefKey) => void
  onDelete: (t: TemplateItem) => void
}) {
  const [picked, setPicked] = useState<TemplateItem | null>(null)
  const [slot, setSlot] = useState<RefKey>('photo')

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // 被选中的模板如果被删除，选择态就失效了
  useEffect(() => {
    if (picked && !items.some((t) => t.id === picked.id)) {
      setPicked(null)
    }
  }, [items, picked])

  const slots = Object.keys(REF_META) as RefKey[]

  return (
    <div className="overlay" onClick={onClose}>
      <div className="gallery tpl" onClick={(e) => e.stopPropagation()}>
        <header className="gallery-head">
          <div className="gallery-title">
            <Icon name="bookmark" size={18} />
            <h2>模板库</h2>
            <span className="gallery-count">{items.length} 个 · 存了模板就能基于它再出图</span>
          </div>
          <button className="icon-btn" onClick={onClose} title="关闭">
            <Icon name="close" size={18} />
          </button>
        </header>

        <div className="gallery-body is-single">
          <div className="gallery-main">
            <div className="pose-grid tpl-grid">
              {items.map((t) => {
                const isPicked = picked?.id === t.id
                return (
                  <button
                    key={t.id}
                    className={`tpl-card ${isPicked ? 'is-picked' : ''}`}
                    onClick={() => setPicked(t)}
                    onDoubleClick={() => onLoad(t, slot)}
                    title="单击选中 · 双击载入画板"
                  >
                    <span className="tpl-thumb">
                      <TemplateThumb id={t.id} />
                    </span>
                    <span className="tpl-meta">
                      <span className="tpl-time">{historyTime(t.created)} · {t.provider || '—'}</span>
                      {t.prompt && <span className="tpl-prompt">{t.prompt}</span>}
                    </span>
                  </button>
                )
              })}
              {!items.length && (
                <p className="gallery-empty">还没有模板 · 出图后画板右上角点「存为模板」即可入库</p>
              )}
            </div>
          </div>
        </div>

        <footer className="gallery-foot">
          <div className="foot-info tpl-info">
            {picked ? (
              <span className="foot-name" title={picked.prompt || picked.model}>
                {picked.prompt ? picked.prompt : `${picked.provider} ${picked.model}`} · 模板 #{picked.id}
              </span>
            ) : (
              <span className="foot-hint">选择一个模板 · 载入后作为参考图回到画板</span>
            )}
          </div>
          <div className="tpl-tools">
            {slots.map((k) => (
              <button key={k} className={`chip ${slot === k ? 'is-active' : ''}`} onClick={() => setSlot(k)} title={REF_META[k].hint}>
                {REF_META[k].name}
              </button>
            ))}
            {/* 删除规则：必须先选中一张模板，单击即删（无二次确认） */}
            <button
              className="tpl-del"
              disabled={!picked}
              title={picked ? `删除模板 #${picked.id}` : '先选中一张模板再删除'}
              onClick={() => picked && onDelete(picked)}
            >
              <Icon name="trash" size={14} />
              删除
            </button>
            <button className="primary gallery-apply" disabled={!picked} onClick={() => picked && onLoad(picked, slot)}>
              <Icon name="check" size={15} />
              载入画板
            </button>
          </div>
        </footer>
      </div>
    </div>
  )
}

function RefGallery({
  kind,
  catalog,
  activeCode,
  hideSensitive,
  onClose,
  onApply
}: {
  kind: RefKey
  catalog: GalleryCatalog
  activeCode: string
  hideSensitive?: boolean
  onClose: () => void
  onApply: (item: GalleryItem, view: GalleryView) => void
}) {
  const isPhone = useIsPhone()
  const [systemId, setSystemId] = useState(catalog.systems[0]?.id ?? catalog.poses[0]?.systemId ?? '')
  const [category, setCategory] = useState('全部')
  const [query, setQuery] = useState('')
  const [picked, setPicked] = useState<{ item: GalleryItem; angleId: string } | null>(null)
  const [dl, setDl] = useState<{ total: number; done: number; failed: number; active: boolean } | null>(null)
  const [dlErr, setDlErr] = useState('')

  // 重新打开图库时恢复进行中的下载进度（后台任务不随面板关闭而停止）
  useEffect(() => {
    let cancelled = false
    invoke<{ total: number; done: number; failed: number; active: boolean }>('prefetch_status')
      .then((s) => {
        if (!cancelled && s.active) setDl(s)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  const systemItems = useMemo(
    () =>
      catalog.poses.filter(
        (p) =>
          (catalog.systems.length > 1 ? p.systemId === systemId : true) &&
          !(hideSensitive && SENSITIVE_CATEGORIES.includes(p.category))
      ),
    [catalog, systemId, hideSensitive]
  )

  // 开关变化后，当前停留的分类可能已被隐藏，退回「全部」避免空列表
  useEffect(() => {
    if (!hideSensitive || category === '全部') return
    if (!systemItems.some((p) => p.category === category)) setCategory('全部')
  }, [hideSensitive, category, systemItems])

  const categories = useMemo(() => {
    const set = new Set(systemItems.map((p) => p.category))
    return ['全部', ...Array.from(set)]
  }, [systemItems])

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return systemItems.filter((p) => {
      if (category !== '全部' && p.category !== category) return false
      if (!q) return true
      return (
        p.code.toLowerCase().includes(q) ||
        p.name.toLowerCase().includes(q) ||
        p.category.toLowerCase().includes(q)
      )
    })
  }, [systemItems, category, query])

  useEffect(() => {
    if (!picked) return
    if (!visible.some((p) => p.id === picked.item.id)) setPicked(null)
  }, [visible, picked])

  // 分块渲染：服装/人脸图库上千张卡，全部一次性铺进 DOM 会让点选重
  // 渲染变成一次长任务（选中高亮要等整帧画完才出现，手感是「点了
  // 有延迟」）。先渲染一屏多一点，滚动临近底部再追加；范围一变
  // （换库/换系统/换分类/改搜索）就从首屏重来。
  const CHUNK = 120
  const [limit, setLimit] = useState(CHUNK)
  const sentinelEl = useRef<HTMLDivElement | null>(null)
  const scopeKey = `${kind}:${systemId}:${category}:${query}`
  useEffect(() => {
    setLimit(CHUNK)
  }, [scopeKey])
  useEffect(() => {
    if (limit >= visible.length) return
    const el = sentinelEl.current
    if (!el) return
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setLimit((l) => Math.min(l + CHUNK, visible.length))
        }
      },
      { rootMargin: '900px' }
    )
    io.observe(el)
    return () => io.disconnect()
  }, [limit, visible.length])

  const selected = useMemo(() => {
    if (!picked) return null
    const view = picked.item.views.find((v) => v.angleId === picked.angleId) ?? picked.item.views[0]
    return view ? { item: picked.item, view } : null
  }, [picked])

  // 单选即预热整图：点一下卡片，全图就开始进本地库，等真的
  // 「载入画板」时多半已经就位，画板立即显示高清版
  useEffect(() => {
    const sel = selected
    if (!sel || !catalog.origin || !sel.view.full) return
    invoke('image_data_uri', { url: assetUrl(catalog.origin, sel.view.full), kind }).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picked])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    if (!dl?.active) return
    const t = setInterval(async () => {
      try {
        const s = await invoke<{ total: number; done: number; failed: number; active: boolean }>(
          'prefetch_status'
        )
        setDl(s)
        if (!s.active) clearInterval(t)
      } catch {
        // ignore polling errors
      }
    }, 700)
    return () => clearInterval(t)
  }, [dl?.active])

  // 打开图库或切换分类时，后台把当前范围的缩略图预热进本地库
  // （gallery.db），翻页/重开就是秒开。搜索词不触发，避免每敲一个
  // 字都起一轮任务；后台进行中的进度由上面的 dl 轮询展示。
  const warmKey = `${kind}:${systemId}:${category}`
  const warmScope = useMemo(
    () =>
      catalog.origin
        ? systemItems
            .filter((p) => category === '全部' || p.category === category)
            .flatMap((p) => (p.views[0]?.thumb ? [assetUrl(catalog.origin, p.views[0].thumb)] : []))
        : [],
    [catalog.origin, systemItems, category]
  )
  useEffect(() => {
    if (!warmScope.length) return
    let cancelled = false
    invoke<number>('prefetch_start', { urls: warmScope, kind })
      .then((missing) => {
        if (!cancelled && missing > 0) setDl({ total: missing, done: 0, failed: 0, active: true })
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
    // warmScope 随 warmKey 一起变；按 key 触发，搜索词变化不重跑
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [warmKey])

  // 把该图库的全部缩略图下载进本机 SQLite（gallery.db），离线可浏览
  const startOffline = async () => {
    if (dl?.active) return
    setDlErr('')
    const urls = catalog.origin
      ? catalog.poses.flatMap((p) => (p.views[0]?.thumb ? [assetUrl(catalog.origin, p.views[0].thumb)] : []))
      : []
    try {
      const missing = await invoke<number>('prefetch_start', { urls, kind })
      setDl(missing > 0 ? { total: missing, done: 0, failed: 0, active: true } : { total: 0, done: 0, failed: 0, active: false })
    } catch (e) {
      setDl(null)
      setDlErr(e instanceof Error ? e.message : String(e))
    }
  }

  const dlDone = dl && !dl.active && dl.failed === 0 && (dl.total === 0 || dl.done >= dl.total)
  const title = kind === 'pose' ? '姿势图库' : kind === 'costume' ? '服装图库' : '人脸图库'

  return (
    <div className="overlay" onClick={onClose}>
      <div className="gallery" data-kind={kind} onClick={(e) => e.stopPropagation()}>
        <header className="gallery-head">
          <div className="gallery-title">
            <Icon name="library" size={18} />
            <h2>{title}</h2>
            <span className="gallery-count">
              {catalog.poses.length} 张 · {REF_META[kind].name}参考
            </span>
          </div>
          <div className="gallery-tools">
            <button
              className={`dl-btn ${dlDone ? 'is-done' : ''} ${dlErr ? 'is-error' : ''}`}
              onClick={startOffline}
              title={dlErr ? `出错了：${dlErr}` : '把该图库全部缩略图下载进本机数据库 gallery.db，离线也能浏览'}
            >
              {dl?.active ? `存本地 ${dl.done}/${dl.total}` : dlDone ? '已存本地 ✓' : '缩略图存本地'}
            </button>
            <label className="search">
              <Icon name="search" size={15} />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="搜索编号、名称、分类"
                autoFocus={!isPhone}
              />
            </label>
            <button className="icon-btn" onClick={onClose} title="关闭">
              <Icon name="close" size={18} />
            </button>
          </div>
        </header>

        <div className={`gallery-body ${catalog.systems.length > 1 ? '' : 'is-single'}`}>
          {catalog.systems.length > 1 && (
            <nav className="gallery-side">
              {catalog.systems.map((s) => (
                <button
                  key={s.id}
                  className={`side-item ${systemId === s.id ? 'is-active' : ''}`}
                  onClick={() => {
                    setSystemId(s.id)
                    setCategory('全部')
                  }}
                >
                  <span className="side-name">{s.name}</span>
                  <span className="side-count">
                    {catalog.poses.filter((p) => p.systemId === s.id).length}
                  </span>
                </button>
              ))}
            </nav>
          )}

          <div className="gallery-main">
            <div className="chips">
              {categories.map((c) => (
                <button
                  key={c}
                  className={`chip ${category === c ? 'is-active' : ''}`}
                  onClick={() => setCategory(c)}
                >
                  {c}
                </button>
              ))}
            </div>

            <div className="pose-grid">
              {visible.slice(0, limit).map((item) => {
                const view = item.views[0]
                const isPicked = picked?.item.id === item.id
                return (
                  <button
                    key={item.id}
                    className={`pose-card ${isPicked ? 'is-picked' : ''}`}
                    onClick={() => setPicked({ item, angleId: view.angleId })}
                    onDoubleClick={() => onApply(item, view)}
                    title={`${item.code} ${item.name}`}
                  >
                    <span className="pose-thumb">
                      <GalleryImage view={view} origin={catalog.origin} alt={item.name} kind={kind} />
                    </span>
                    <span className="pose-caption">
                      <span className="pose-code">{item.code}</span>
                      <span className="pose-name">{item.name}</span>
                    </span>
                    {activeCode === item.code && <span className="pose-badge">当前</span>}
                  </button>
                )
              })}
              {limit < visible.length && (
                <div className="grid-sentinel" ref={sentinelEl} aria-hidden="true" />
              )}
              {!visible.length && <p className="gallery-empty">没有匹配的内容</p>}
            </div>
          </div>
        </div>

        <footer className="gallery-foot">
          <div className="foot-info">
            {selected ? (
              <>
                <span className="foot-name">
                  {selected.item.code} · {selected.item.name}
                </span>
                {selected.item.views.length > 1 && (
                  <div className="angles">
                    {selected.item.views.map((v) => (
                      <button
                        key={v.angleId}
                        className={`angle ${selected.view.angleId === v.angleId ? 'is-active' : ''}`}
                        onClick={() => setPicked({ item: selected.item, angleId: v.angleId })}
                      >
                        {v.angle}
                      </button>
                    ))}
                  </div>
                )}
              </>
            ) : (
              <span className="foot-hint">
                {isPhone ? (
                  <>点选一项{kind === 'pose' ? '，可换机位' : ''}</>
                ) : (
                  <>选择一项 · 双击直接载入{kind === 'pose' ? '，再选机位' : ''}</>
                )}
              </span>
            )}
          </div>
          {catalog.source ? (
            // 应用内不做真实跳转：外部链接交给系统浏览器（open_url）
            <button className="foot-credit" onClick={() => openExternal(catalog.source)} title={catalog.source}>
              {catalog.attribution || '图源归原作者所有'}
            </button>
          ) : (
            <span className="foot-credit">{catalog.attribution || ''}</span>
          )}
          <button
            className="primary gallery-apply"
            disabled={!selected}
            onClick={() => selected && onApply(selected.item, selected.view)}
          >
            <Icon name="check" size={15} />
            载入画板
          </button>
        </footer>
      </div>
    </div>
  )
}

const container = document.getElementById('root')
if (!container) throw new Error('#root container missing')
createRoot(container).render(<App />)
