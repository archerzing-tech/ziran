import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import poseCatalogJson from './data/poses.json'
import costumeCatalogJson from './data/costumes.json'
import faceCatalogJson from './data/faces.json'

type Settings = {
  apiKey: string
  provider: string
  model: string
  baseUrl: string
  ratio: string
}

type RefKey = 'pose' | 'costume' | 'face'
type Refs = Record<RefKey, string | null>
type Tone = 'neutral' | 'busy' | 'ok' | 'err'

type ProviderShape = 'ark' | 'siliconflow' | 'openai'

const PROVIDERS: {
  value: string
  label: string
  sub: string
  model: string
  baseUrl: string
  desc: string
  keyUrl: string
  keyHint: string
  refs: boolean
  shape: ProviderShape
}[] = [
  {
    value: 'ark',
    label: 'Seedream',
    sub: '火山方舟',
    model: 'doubao-seedream-5-0-flash-260915',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    desc: '国内直连最快，姿势/服装/人脸三张参考图都吃。',
    keyUrl: 'https://console.volcengine.com/ark',
    keyHint: '火山方舟控制台 → API Key 管理',
    refs: true,
    shape: 'ark'
  },
  {
    value: 'siliconflow',
    label: '硅基流动',
    sub: 'Qwen-Image-Edit',
    model: 'Qwen/Qwen-Image-Edit-2509',
    baseUrl: 'https://api.siliconflow.cn/v1',
    desc: '阿里通义千问图像编辑，最多三张参考图，改姿势改服装都行。',
    keyUrl: 'https://cloud.siliconflow.cn/account/ak',
    keyHint: '硅基流动 → 账户管理 → API 密钥',
    refs: true,
    shape: 'siliconflow'
  },
  {
    value: 'zhipu',
    label: '智谱 CogView',
    sub: 'bigmodel',
    model: 'glm-image',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    desc: '国产文生图，中文提示词理解好；不支持参考图，只会按描述画。',
    keyUrl: 'https://bigmodel.cn/usercenter/apikeys',
    keyHint: '智谱开放平台 → API Keys',
    refs: false,
    shape: 'openai'
  },
  {
    value: 'openai',
    label: 'OpenAI',
    sub: 'gpt-image-1',
    model: 'gpt-image-1',
    baseUrl: 'https://api.openai.com/v1',
    desc: '官方 images 接口，需能直连 openai.com。',
    keyUrl: 'https://platform.openai.com/api-keys',
    keyHint: 'OpenAI Platform → API keys',
    refs: true,
    shape: 'openai'
  },
  {
    value: 'custom',
    label: '自定义 / 中转站',
    sub: 'OpenAI 兼容',
    model: '',
    baseUrl: '',
    desc: '任何 OpenAI 兼容接口都能填：中转站、ComfyUI 网关、自建代理。',
    keyUrl: '',
    keyHint: '填写服务商给你的 Base URL 与模型名',
    refs: true,
    shape: 'openai'
  }
]

const RATIOS = [
  { id: '1:1', label: '1:1', w: 1, h: 1, size: '1024x1024' },
  { id: '3:4', label: '3:4', w: 3, h: 4, size: '864x1152' },
  { id: '4:3', label: '4:3', w: 4, h: 3, size: '1152x864' },
  { id: '9:16', label: '9:16', w: 9, h: 16, size: '720x1280' },
  { id: '16:9', label: '16:9', w: 16, h: 9, size: '1280x720' }
]

const providerMeta = (id: string) => PROVIDERS.find((p) => p.value === id) ?? PROVIDERS[0]
const ratioMeta = (id: string) => RATIOS.find((r) => r.id === id) ?? RATIOS[0]

const DEFAULT_SETTINGS: Settings = {
  apiKey: '',
  provider: 'ark',
  model: 'doubao-seedream-5-0-flash-260915',
  baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
  ratio: '1:1'
}

const STORAGE_KEY = 'ziran.settings'
const EMPTY_REFS: Refs = { pose: null, costume: null, face: null }
const REF_META: Record<RefKey, { name: string; hint: string }> = {
  pose: { name: '姿势', hint: '人体姿态参考' },
  costume: { name: '服装', hint: '服饰材质参考' },
  face: { name: '人脸', hint: '五官与发型参考' }
}
const ARTBOARD = 512

type GalleryView = { id: string; angle: string; angleId: string; thumb: string; full: string }
type GalleryItem = { id: string; systemId: string; system: string; code: string; category: string; name: string; views: GalleryView[] }
type GalleryCatalog = {
  origin: string
  source: string
  attribution: string
  systems: { id: string; name: string; poseCount: number }[]
  poses: GalleryItem[]
}
type RefMeta = { name: string; code: string; angle: string }

const POSE_CATALOG = poseCatalogJson as GalleryCatalog
const COSTUME_CATALOG = costumeCatalogJson as GalleryCatalog
const FACE_CATALOG = faceCatalogJson as GalleryCatalog
const CATALOGS: Record<RefKey, GalleryCatalog> = {
  pose: POSE_CATALOG,
  costume: COSTUME_CATALOG,
  face: FACE_CATALOG
}

const assetUrl = (origin: string, path: string) => {
  if (!path) return ''
  if (/^(data:|https?:|blob:)/.test(path)) return path
  const base = (origin || '').replace(/\/$/, '')
  return base ? `${base}/${path}` : path
}

function loadRefMeta() {
  const out: Record<RefKey, RefMeta | null> = { pose: null, costume: null, face: null }
  try {
    const legacy = JSON.parse(localStorage.getItem(`${STORAGE_KEY}.pose`) || 'null') as RefMeta | null
    if (legacy) out.pose = legacy
  } catch {}
  try {
    const all = JSON.parse(localStorage.getItem(`${STORAGE_KEY}.refmeta`) || 'null') as Partial<Record<RefKey, RefMeta>> | null
    if (all) {
      if (all.pose) out.pose = all.pose
      if (all.costume) out.costume = all.costume
      if (all.face) out.face = all.face
    }
  } catch {}
  return out
}

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_SETTINGS
    const parsed = { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } as Settings
    const known = PROVIDERS.some((p) => p.value === parsed.provider)
    if (!known) parsed.provider = DEFAULT_SETTINGS.provider
    if (!RATIOS.some((r) => r.id === parsed.ratio)) parsed.ratio = DEFAULT_SETTINGS.ratio
    return parsed
  } catch {
    return DEFAULT_SETTINGS
  }
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

type IconName =
  | 'pointer'
  | 'pose'
  | 'shirt'
  | 'face'
  | 'grid'
  | 'image'
  | 'sparkle'
  | 'plus'
  | 'trash'
  | 'undo'
  | 'redo'
  | 'zoomIn'
  | 'zoomOut'
  | 'fit'
  | 'key'
  | 'download'
  | 'check'
  | 'chevron'
  | 'library'
  | 'close'
  | 'search'
  | 'help'

const ICON_PATHS: Record<IconName, ReactNode> = {
  pointer: <path d="M6 3.5l9.4 8.5-4.2.6 2.4 4.9-1.9.9-2.4-4.9L6 15.9z" />,
  pose: (
    <>
      <circle cx="12" cy="5.6" r="2.3" />
      <path d="M12 8.4v5.2M12 10.2L8.6 12.6M12 10.2l3.4 2.4M12 13.6l-2.8 5.6M12 13.6l2.8 5.6" />
    </>
  ),
  shirt: <path d="M8.2 4.1L4 6.8l1.7 3.6 2.5-1.1V20h7.6V9.3l2.5 1.1L20 6.8l-4.2-2.7-1.9 1.4h-3.8z" />,
  face: (
    <>
      <circle cx="12" cy="12" r="7.4" />
      <path d="M9.2 10.4v.9M14.8 10.4v.9M9.4 14.4c1.4 1.3 3.8 1.3 5.2 0" />
    </>
  ),
  grid: (
    <>
      <rect x="3.5" y="3.5" width="17" height="17" rx="1.5" />
      <path d="M9.2 3.5v17M14.8 3.5v17M3.5 9.2h17M3.5 14.8h17" />
    </>
  ),
  image: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="1.8" />
      <circle cx="8.6" cy="9.4" r="1.4" />
      <path d="M4.2 17.4l4.9-4.6 3.3 3 2.6-2.3 4.6 4.2" />
    </>
  ),
  sparkle: (
    <>
      <path d="M11 3.4l1.7 4.6 4.6 1.7-4.6 1.7L11 16.1 9.3 11.4 4.7 9.7l4.6-1.7z" />
      <path d="M17.6 15.2l.9 2.3 2.3.9-2.3.9-.9 2.3-.9-2.3-2.3-.9 2.3-.9z" />
    </>
  ),
  plus: <path d="M12 5.5v13M5.5 12h13" />,
  trash: <path d="M4.5 7h15M9.5 7V4.8h5V7M6.6 7l.9 12.5h9l.9-12.5M10.4 10.6v5.6M13.6 10.6v5.6" />,
  undo: <path d="M8.6 7.4L4.4 11.6l4.2 4.2M4.6 11.6h8.3a5.1 5.1 0 010 10.2H11" />,
  redo: <path d="M15.4 7.4l4.2 4.2-4.2 4.2M19.4 11.6H11a5.1 5.1 0 000 10.2h1.9" />,
  zoomIn: (
    <>
      <circle cx="10.8" cy="10.8" r="5.6" />
      <path d="M14.9 14.9L19.6 19.6M10.8 8.3v5M8.3 10.8h5" />
    </>
  ),
  zoomOut: (
    <>
      <circle cx="10.8" cy="10.8" r="5.6" />
      <path d="M14.9 14.9L19.6 19.6M8.3 10.8h5" />
    </>
  ),
  fit: <path d="M4.5 9.4V4.5h4.9M19.5 9.4V4.5h-4.9M4.5 14.6v4.9h4.9M19.5 14.6v4.9h-4.9" />,
  key: (
    <>
      <circle cx="8.2" cy="12" r="3.7" />
      <path d="M11.9 12h7.6M16.4 12v3M19.5 12v2.2" />
    </>
  ),
  download: <path d="M12 4.2v10.4M8.2 11l3.8 3.8L15.8 11M5 19.4h14" />,
  check: <path d="M5 12.6l4.4 4.4L19 7.4" />,
  chevron: <path d="M9 5.5l6.5 6.5L9 18.5" />,
  library: (
    <>
      <rect x="3.5" y="4" width="7" height="16" rx="1.2" />
      <rect x="13.5" y="4" width="7" height="9" rx="1.2" />
      <path d="M13.5 16.5h7" />
    </>
  ),
  close: <path d="M6 6l12 12M18 6L6 18" />,
  search: (
    <>
      <circle cx="11" cy="11" r="6.2" />
      <path d="M15.6 15.6L20 20" />
    </>
  ),
  help: (
    <>
      <circle cx="12" cy="12" r="8.2" />
      <path d="M9.6 9.4a2.5 2.5 0 114.1 1.9c-.9.7-1.7 1.1-1.7 2.3M12 16.6v.2" />
    </>
  )
}

function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {ICON_PATHS[name]}
    </svg>
  )
}

function App() {
  const [settings, setSettings] = useState<Settings>(loadSettings)
  const [refs, setRefs] = useState<Refs>(EMPTY_REFS)
  const [active, setActive] = useState<RefKey>('pose')
  const [prompt, setPrompt] = useState('')
  const [result, setResult] = useState('')
  const [status, setStatus] = useState<{ text: string; tone: Tone }>({ text: '就绪', tone: 'neutral' })
  const [busy, setBusy] = useState(false)
  const [refMeta, setRefMeta] = useState<Record<RefKey, RefMeta | null>>(loadRefMeta)
  const [galleryOpen, setGalleryOpen] = useState<RefKey | null>(null)
  const [preview, setPreview] = useState<{ src: string; title: string } | null>(null)
  const [advanced, setAdvanced] = useState(false)
  const [showGuide, setShowGuide] = useState(() => {
    try {
      return localStorage.getItem(`${STORAGE_KEY}.guide`) !== '1'
    } catch {
      return true
    }
  })
  const [missing, setMissing] = useState<'key' | 'pose' | null>(null)
  const keyRef = useRef<HTMLInputElement | null>(null)
  const promptRef = useRef<HTMLTextAreaElement | null>(null)
  const [zoom, setZoom] = useState(1)
  const [grid, setGrid] = useState(true)
  const [dragging, setDragging] = useState(false)
  const [autoFit, setAutoFit] = useState(true)
  const areaRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
    } catch {
      // storage can be unavailable (private mode); settings still live in memory
    }
  }, [settings])

  useEffect(() => {
    try {
      localStorage.setItem(`${STORAGE_KEY}.refmeta`, JSON.stringify(refMeta))
      if (refMeta.pose) localStorage.setItem(`${STORAGE_KEY}.pose`, JSON.stringify(refMeta.pose))
      else localStorage.removeItem(`${STORAGE_KEY}.pose`)
    } catch {
      // ignore storage failures
    }
  }, [refMeta])

  const activeRatio = ratioMeta(settings.ratio)
  const boardScale = ARTBOARD / Math.max(activeRatio.w, activeRatio.h)
  const boardW = Math.round(activeRatio.w * boardScale)
  const boardH = Math.round(activeRatio.h * boardScale)

  useEffect(() => {
    if (!autoFit) return
    const compute = () => {
      const area = areaRef.current
      if (!area) return
      const fit = Math.min((area.clientWidth - 96) / boardW, (area.clientHeight - 96) / boardH)
      setZoom(Math.max(0.2, Math.min(1.6, Number(fit.toFixed(2)))))
    }
    compute()
    window.addEventListener('resize', compute)
    return () => window.removeEventListener('resize', compute)
  }, [autoFit, boardW, boardH])

  const update = (patch: Partial<Settings>) => setSettings((prev) => ({ ...prev, ...patch }))
  const setRef = (key: RefKey, value: string | null) => {
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
    setStatus({ text: `已载入${REF_META[key].name}参考 · ${file.name}`, tone: 'ok' })
  }

  const generate = async () => {
    const meta = providerMeta(settings.provider)
    const ratio = ratioMeta(settings.ratio)

    if (!settings.apiKey.trim()) {
      setStatus({ text: '请先在右侧填入 API Key', tone: 'err' })
      return
    }
    if (meta.refs && !refs.pose) {
      setStatus({ text: '请先载入姿势参考图', tone: 'err' })
      return
    }
    if (!meta.refs && !prompt.trim()) {
      setStatus({ text: `${meta.label} 只按文字画图，请先写一段描述`, tone: 'err' })
      return
    }

    const refList = [refs.pose, refs.costume, refs.face].filter(Boolean) as string[]
    const promptText = prompt.trim() || '同一个人物，保持五官特征，穿着参考服装，摆出参考姿势'
    const base = (settings.baseUrl.trim() || meta.baseUrl).replace(/\/$/, '')
    if (!base) {
      setAdvanced(true)
      setStatus({ text: `${meta.label} 需要先填写接口根地址（高级设置）`, tone: 'err' })
      return
    }

    const body: Record<string, unknown> =
      meta.shape === 'siliconflow'
        ? {
            model: settings.model || meta.model,
            prompt: promptText,
            ...(refList[0] ? { image: refList[0] } : {}),
            ...(refList[1] ? { image2: refList[1] } : {}),
            ...(refList[2] ? { image3: refList[2] } : {})
          }
        : meta.shape === 'ark'
          ? {
              model: settings.model || meta.model,
              prompt: promptText,
              image: refList.slice(0, 3),
              response_format: 'url',
              size: ratio.size
            }
          : {
              model: settings.model || meta.model,
              prompt: promptText,
              ...(refList.length ? { image: refList } : {}),
              size: ratio.size
            }

    setBusy(true)
    setStatus({ text: `正在生成图像 · ${meta.label}`, tone: 'busy' })
    try {
      const res = await fetch(`${base}/images/generations`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${settings.apiKey.trim()}`
        },
        body: JSON.stringify(body)
      })

      const text = await res.text()
      if (!res.ok) {
        setStatus({ text: `生成失败 ${res.status} · ${text.slice(0, 180)}`, tone: 'err' })
        return
      }

      let output = ''
      try {
        const data = JSON.parse(text)
        output = data?.data?.[0]?.url || data?.data?.[0]?.b64_json || data?.url || ''
      } catch {
        // handled below
      }
      if (output.startsWith('http') || output.startsWith('data:')) {
        setResult(output)
        setStatus({ text: '生成完成', tone: 'ok' })
      } else {
        setStatus({ text: `已返回响应 · ${text.slice(0, 180)}`, tone: 'neutral' })
      }
    } catch (err) {
      setStatus({ text: `请求失败 · ${err instanceof Error ? err.message : String(err)}`, tone: 'err' })
    } finally {
      setBusy(false)
    }
  }

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
  const hasKey = settings.apiKey.trim().length > 0
  const hasPose = Boolean(refs.pose)
  const step2Done = activeProvider.refs ? hasPose : prompt.trim().length > 0
  const ready = hasKey && step2Done

  const dismissGuide = () => {
    setShowGuide(false)
    try {
      localStorage.setItem(`${STORAGE_KEY}.guide`, '1')
    } catch {
      // ignore storage failures
    }
  }

  const runPrimary = () => {
    if (!hasKey) {
      setMissing('key')
      setStatus({ text: '第一步：先填入 API Key', tone: 'err' })
      keyRef.current?.focus()
      return
    }
    if (!step2Done) {
      setMissing('pose')
      if (activeProvider.refs) {
        setStatus({ text: '第二步：选择一个姿势（可打开姿势图库）', tone: 'err' })
        setGalleryOpen('pose')
      } else {
        setStatus({ text: `第二步：${activeProvider.label} 只按文字画图，先写一段描述`, tone: 'err' })
        promptRef.current?.focus()
      }
      return
    }
    setMissing(null)
    void generate()
  }

  const primaryLabel = busy
    ? '生成中…'
    : !hasKey
      ? '第 1 步 · 填写 API Key'
      : !step2Done
        ? activeProvider.refs
          ? '第 2 步 · 选择姿势'
          : '第 2 步 · 写描述'
        : '生成图像'

  const showAdvanced = advanced || settings.provider === 'custom'

  const activeRef = refs[active]
  const canvasSource = result || activeRef
  const canvasLabel = result
    ? '生成结果'
    : activeRef
      ? active === 'pose' && refMeta.pose
        ? `姿势 · ${refMeta.pose.code} ${refMeta.pose.name}`
        : `${REF_META[active].name}参考`
      : '空画板'

  return (
    <div className="shell">
      <header className="titlebar">
        <div className="brand">
          <svg className="brand-mark" width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 2.6l9.4 9.4-9.4 9.4L2.6 12z" fill="none" stroke="currentColor" strokeWidth="1.6" />
            <path d="M12 7.4l4.6 4.6-4.6 4.6L7.4 12z" fill="currentColor" />
          </svg>
          <span className="brand-name">Ziran</span>
        </div>
        <span className="divider" />
        <span className="doc-name">
          无标题.pose<span className="doc-dirty">·</span>
        </span>

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
          <a
            className="icon-btn"
            title="下载结果"
            href={result || undefined}
            download={result ? 'ziran.png' : undefined}
            aria-disabled={!result}
          >
            <Icon name="download" size={17} />
          </a>
        </div>
      </header>

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
                data-tip={`${REF_META[key].name}参考${refs[key] ? ' · 已载入' : ''}`}
                onClick={() => setActive(key)}
              >
                <Icon name={key === 'pose' ? 'pose' : key === 'costume' ? 'shirt' : 'face'} />
                {refs[key] && <span className="rail-badge" />}
              </button>
            ))}
            <span className="rail-sep" />
            <button className="rail-btn" data-tip="姿势图库" onClick={() => setGalleryOpen('pose')}>
              <Icon name="library" />
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

        <section
          className={`canvas-area ${dragging ? 'is-dragging' : ''}`}
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
          <div className="artboard-shadow" style={{ transform: `scale(${zoom})` }}>
            <div className="artboard" style={{ width: boardW, height: boardH }}>
              <div className="checker" />
              {grid && <div className="artboard-grid" />}
              {canvasSource && <img className="artboard-image" src={canvasSource} alt={canvasLabel} />}
              {!canvasSource && (
                <div className="empty">
                  <Icon name="image" size={30} />
                </div>
              )}
              <span className="artboard-tag">{canvasLabel}</span>
            </div>
          </div>

          {!canvasSource && (
            <div className="canvas-hint">
              <p className="hint-title">三步开始出图</p>
              <ol className="hint-steps">
                <li className={hasKey ? 'is-done' : ''}>
                  <span className="hint-num">{hasKey ? <Icon name="check" size={10} /> : 1}</span>
                  填 API Key{hasKey ? <em>已完成</em> : <em>必填</em>}
                </li>
                <li className={step2Done ? 'is-done' : ''}>
                  <span className="hint-num">{step2Done ? <Icon name="check" size={10} /> : 2}</span>
                  {activeProvider.refs ? '选一个姿势' : '写一段描述'}
                  {step2Done ? <em>{activeProvider.refs ? '已选' : '已写'}</em> : <em>必填</em>}
                </li>
                <li className={ready ? '' : 'is-muted'}>
                  <span className="hint-num">3</span>
                  点“生成图像”
                </li>
              </ol>
              <button
                className="ghost-btn"
                onClick={() => (hasKey ? setGalleryOpen('pose') : keyRef.current?.focus())}
              >
                <Icon name={hasKey ? 'library' : 'key'} size={14} />
                {hasKey ? '打开姿势图库' : '去填写 API Key'}
              </button>
            </div>
          )}

          <div className="canvas-hud">
            <button className="hud-btn" onClick={() => bumpZoom(-0.1)} title="缩小">
              <Icon name="zoomOut" size={16} />
            </button>
            <button
              className="hud-zoom"
              onClick={() => setAutoFit(true)}
              title="适应窗口"
            >
              {Math.round(zoom * 100)}%
            </button>
            <button className="hud-btn" onClick={() => bumpZoom(0.1)} title="放大">
              <Icon name="zoomIn" size={16} />
            </button>
            <span className="hud-sep" />
            <span className="hud-meta">{activeRatio.size.replace('x', ' × ')}</span>
          </div>
        </section>

        <aside className="inspector">
          <div className="stepper">
            <button className={`step ${hasKey ? 'is-done' : 'is-current'}`} onClick={() => keyRef.current?.focus()}>
              <span className="step-num">{hasKey ? <Icon name="check" size={11} /> : 1}</span>
              <span className="step-text">填 Key</span>
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
              <span>① 选服务商 · 填密钥</span>
              <span className={`badge ${hasKey ? 'badge-ok' : 'badge-warn'}`}>{hasKey ? '已填写' : '必填'}</span>
            </div>

            <div className="provider-grid">
              {PROVIDERS.map((p) => (
                <button
                  key={p.value}
                  className={`provider ${settings.provider === p.value ? 'is-active' : ''}`}
                  onClick={() => {
                    const prev = providerMeta(settings.provider)
                    const keepModel = settings.model.trim() && settings.model !== prev.model
                    const keepBase = settings.baseUrl.trim() && settings.baseUrl !== prev.baseUrl
                    update({
                      provider: p.value,
                      model: keepModel ? settings.model : p.model,
                      baseUrl: keepBase ? settings.baseUrl : p.baseUrl
                    })
                  }}
                >
                  <span className="provider-label">{p.label}</span>
                  <span className="provider-sub">{p.sub}</span>
                  {p.refs && <span className="provider-tag">参考图</span>}
                </button>
              ))}
            </div>

            <p className="provider-desc">{activeProvider.desc}</p>

            <div className="key-row">
              <input
                ref={keyRef}
                className={`input mono ${missing === 'key' && !hasKey ? 'is-error' : ''}`}
                type="password"
                value={settings.apiKey}
                onChange={(e) => update({ apiKey: e.target.value })}
                placeholder={`粘贴 ${activeProvider.label} 的 API Key`}
              />
              {activeProvider.keyUrl && (
                <a className="key-link" href={activeProvider.keyUrl} target="_blank" rel="noreferrer" title="去申请">
                  <Icon name="download" size={13} />
                </a>
              )}
            </div>
            <p className="help">{activeProvider.keyHint} · 只存在本机，自动保存</p>
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
                {activeProvider.refs ? '姿势必选 · 服装/人脸可选' : '当前服务商不支持参考图'}
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
                  {refs[key] ? <img src={refs[key] as string} alt={REF_META[key].name} /> : <Icon name="plus" size={14} />}
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
            <div className="gallery-links">
              <button className="ghost-btn" onClick={() => setGalleryOpen('pose')}>
                <Icon name="library" size={14} />
                姿势图库 · {POSE_CATALOG.poses.length}
              </button>
              <button className="ghost-btn" onClick={() => setGalleryOpen('costume')}>
                <Icon name="shirt" size={14} />
                服装图库 · {COSTUME_CATALOG.poses.length}
              </button>
              <button className="ghost-btn" onClick={() => setGalleryOpen('face')}>
                <Icon name="face" size={14} />
                人脸图库 · {FACE_CATALOG.poses.length}
              </button>
            </div>
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
              className={`input textarea ${missing === 'pose' && !activeProvider.refs && !hasPrompt ? 'is-error' : ''}`}
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

          <div className="section">
            <button className="collapse-head" onClick={() => setAdvanced((v) => !v)}>
              <span className={`collapse-arrow ${advanced ? 'is-open' : ''}`}>
                <Icon name="chevron" size={11} />
              </span>
              <span>高级设置</span>
              <span className="collapse-hint">
                {settings.provider} · {settings.model}
              </span>
            </button>
            {showAdvanced && (
              <div className="collapse-body">
                <div className="field">
                  <label>服务商</label>
                  <select className="input" value={settings.provider} onChange={(e) => update({ provider: e.target.value })}>
                    {PROVIDERS.map((p) => (
                      <option key={p.value} value={p.value}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label>模型</label>
                  <input
                    className="input mono"
                    value={settings.model}
                    onChange={(e) => update({ model: e.target.value })}
                    placeholder="doubao-seedream-5-0-flash-260915"
                  />
                </div>
                <div className="field">
                  <label>Base URL</label>
                  <input
                    className="input mono"
                    value={settings.baseUrl}
                    onChange={(e) => update({ baseUrl: e.target.value })}
                    placeholder="https://ark.cn-beijing.volces.com/api/v3"
                  />
                </div>
              </div>
            )}
          </div>

          <div className="inspector-footer">
            <button className={`primary ${!ready && !busy ? 'is-guiding' : ''}`} onClick={runPrimary} disabled={busy}>
              <Icon name={ready ? 'sparkle' : hasKey ? 'library' : 'key'} size={16} />
              {primaryLabel}
            </button>
            <p className="footer-note">
              {ready ? '⌘↵ 快捷生成 · 结果自动载入画板' : '按顺序完成两步，按钮就会变成“生成图像”'}
            </p>
          </div>
        </aside>
      </div>

      {galleryOpen && (
        <RefGallery
          kind={galleryOpen}
          catalog={CATALOGS[galleryOpen]}
          activeCode={refMeta[galleryOpen]?.code ?? ''}
          onClose={() => setGalleryOpen(null)}
          onApply={(item, view) => {
            const kind = galleryOpen
            setRef(kind, assetUrl(CATALOGS[kind].origin, view.full))
            setRefMeta((prev) => ({ ...prev, [kind]: { name: item.name, code: item.code, angle: view.angle } }))
            setResult('')
            setMissing(null)
            setGalleryOpen(null)
            setStatus({ text: `已载入${REF_META[kind].name} ${item.code} ${item.name}${view.angle && view.angle !== '参考' ? ` · ${view.angle}` : ''}`, tone: 'ok' })
          }}
        />
      )}

      {preview && (
        <div className="overlay" onClick={() => setPreview(null)}>
          <div className="preview-card" onClick={(e) => e.stopPropagation()}>
            <button className="preview-close" onClick={() => setPreview(null)} title="关闭" aria-label="关闭">
              <Icon name="x" size={18} />
            </button>
            <div className="preview-body">
              <img src={preview.src} alt={preview.title} />
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
                  <b>填 API Key</b>
                  <p>去火山方舟控制台创建一个 Key，粘到右侧第一栏。只需填一次，之后自动记住。</p>
                </div>
              </li>
              <li>
                <span className="guide-num">2</span>
                <div>
                  <b>选一个姿势</b>
                  <p>点“打开姿势图库”，从 {POSE_CATALOG.poses.length} 张线稿里挑一张，再选好机位（正面/侧面…）。服装和人脸可选。</p>
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
                  keyRef.current?.focus()
                }}
              >
                开始第 1 步
              </button>
            </div>
          </div>
        </div>
      )}

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
          <span className="mono">{settings.provider} / {settings.model}</span>
          <span className="status-sep" />
          <span className="mono">{settings.apiKey.trim() ? '密钥已设置' : '密钥未设置'}</span>
        </div>
      </footer>
    </div>
  )
}

function RefGallery({
  kind,
  catalog,
  activeCode,
  onClose,
  onApply
}: {
  kind: RefKey
  catalog: GalleryCatalog
  activeCode: string
  onClose: () => void
  onApply: (item: GalleryItem, view: GalleryView) => void
}) {
  const [systemId, setSystemId] = useState(catalog.systems[0]?.id ?? catalog.poses[0]?.systemId ?? '')
  const [category, setCategory] = useState('全部')
  const [query, setQuery] = useState('')
  const [picked, setPicked] = useState<{ item: GalleryItem; angleId: string } | null>(null)

  const systemItems = useMemo(
    () => catalog.poses.filter((p) => (catalog.systems.length > 1 ? p.systemId === systemId : true)),
    [catalog, systemId]
  )

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

  const selected = useMemo(() => {
    if (!picked) return null
    const view = picked.item.views.find((v) => v.angleId === picked.angleId) ?? picked.item.views[0]
    return view ? { item: picked.item, view } : null
  }, [picked])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const title = kind === 'pose' ? '姿势图库' : kind === 'costume' ? '服装图库' : '人脸图库'

  return (
    <div className="overlay" onClick={onClose}>
      <div className="gallery" onClick={(e) => e.stopPropagation()}>
        <header className="gallery-head">
          <div className="gallery-title">
            <Icon name="library" size={18} />
            <h2>{title}</h2>
            <span className="gallery-count">
              {catalog.poses.length} 张 · {REF_META[kind].name}参考
            </span>
          </div>
          <div className="gallery-tools">
            <label className="search">
              <Icon name="search" size={15} />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="搜索编号、名称、分类"
                autoFocus
              />
            </label>
            <button className="icon-btn" onClick={onClose} title="关闭">
              <Icon name="x" size={18} />
            </button>
          </div>
        </header>

        <div className="gallery-body">
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
              {visible.map((item) => {
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
                      <GalleryImage view={view} origin={catalog.origin} alt={item.name} />
                    </span>
                    <span className="pose-caption">
                      <span className="pose-code">{item.code}</span>
                      <span className="pose-name">{item.name}</span>
                    </span>
                    {activeCode === item.code && <span className="pose-badge">当前</span>}
                  </button>
                )
              })}
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
              <span className="foot-hint">选择一项 · 双击直接载入{kind === 'pose' ? '，再选机位' : ''}</span>
            )}
          </div>
          {catalog.source ? (
            <a className="foot-credit" href={catalog.source} target="_blank" rel="noreferrer">
              {catalog.attribution || '图源归原作者所有'}
            </a>
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

function GalleryImage({ view, origin, alt }: { view: GalleryView; origin: string; alt: string }) {
  const [failed, setFailed] = useState(false)
  if (failed) {
    return (
      <span className="pose-fallback">
        <Icon name="image" size={18} />
      </span>
    )
  }
  return (
    <img
      src={assetUrl(origin, view.thumb)}
      alt={alt}
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
    />
  )
}

const container = document.getElementById('root')
if (!container) throw new Error('#root container missing')
createRoot(container).render(<App />)
