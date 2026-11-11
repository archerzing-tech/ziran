// 桌面与手机两个界面共用的数据结构、常量与小型组件。
// main.tsx（App/桌面 UI/生成逻辑）与 phone/*（手机 UI）都从这里取，
// 避免 2800 行单文件互相牵扯。
import { memo, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { invoke } from '@tauri-apps/api/core'
import poseCatalogJson from './data/poses.json'
import costumeCatalogJson from './data/costumes.json'
import faceCatalogJson from './data/faces.json'

// 构建时由 vite 注入（值来自 tauri.conf.json 的 version）
declare const __APP_VERSION__: string
export const APP_VERSION = __APP_VERSION__

export type ProviderUserConfig = { apiKey: string; model: string; baseUrl: string; soft?: boolean; adult?: boolean }
export type Theme = 'dark' | 'light'

export type Settings = {
  provider: string
  ratio: string
  // 每个供应商一份独立配置：切模型各用各的 Key，模型/地址的自定义也互不覆盖
  configs: Record<string, ProviderUserConfig>
  // 界面主题：标题栏太阳/月亮按钮切换，随设置持久化
  theme: Theme
  // 委婉描述默认改「开」的一次性迁移标记：见 loadSettings（v0.3.0）
  softDefaultOn?: boolean
}
// soft 未设置 = 默认开；显式 false 才代表用户主动关
export const EMPTY_PCONF: ProviderUserConfig = { apiKey: '', model: '', baseUrl: '', soft: true, adult: false }

// 本地生成历史的一条元数据（图片本体在应用数据目录 history/ 下）
// prompt 是生成时的描述（早期数据没有，为空串）：从历史图「存为模板」时带上
export type HistoryItem = { id: number; created: number; provider: string; model: string; prompt?: string; size: number; ws?: number }

// 用户收藏的「生成模板」：图存应用数据目录 templates/，可基于它再出图
export type TemplateItem = { id: number; created: number; provider: string; model: string; prompt: string; size: number }

export type RefKey = 'photo' | 'pose' | 'costume' | 'face'
export type Refs = Record<RefKey, string | null>
export type Tone = 'neutral' | 'busy' | 'ok' | 'err'

export type ProviderShape = 'ark' | 'siliconflow' | 'openai' | 'gptimage' | 'gemini' | 'minimax'

export type ProviderDef = {
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
}

export const PROVIDER_SHAPES: ProviderShape[] = ['ark', 'siliconflow', 'openai', 'gptimage', 'gemini', 'minimax']

// 内置默认供应商，同时是 providers.json 的种子内容：
// 配置文件在应用数据目录（首次启动写入），用户可直接编辑增删改，
// 界面里「编辑配置文件」可打开所在文件夹，「重新加载」即时生效。
export const DEFAULT_PROVIDERS: ProviderDef[] = [
  {
    value: 'ark',
    label: '火山引擎',
    sub: 'Seedream · 方舟',
    model: 'doubao-seedream-5-0-flash-260915',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    desc: '国内直连最快，姿势/服装/人脸三张参考图都吃。Key 必须是「火山方舟」控制台签发的 API Key；IAM 子账号的访问密钥（AKLT 开头）是另一套体系，填进来会报 Key 格式错误。',
    keyUrl: 'https://console.volcengine.com/ark',
    keyHint: '火山引擎控制台 → 火山方舟 → 左侧「API Key 管理」→ 新建 API Key',
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
    label: '智谱 GLM-Image',
    sub: 'bigmodel 国内站',
    model: 'glm-image',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    desc: '国内直连 bigmodel.cn（无需代理），中文提示词理解好；只按文字画图，不支持参考图。',
    keyUrl: 'https://bigmodel.cn/usercenter/apikeys',
    keyHint: '智谱开放平台 bigmodel.cn → API Keys',
    refs: false,
    shape: 'openai'
  },
  {
    value: 'openai',
    label: 'OpenAI',
    sub: 'gpt-image-1',
    model: 'gpt-image-1',
    baseUrl: 'https://api.openai.com/v1',
    desc: '官方 images/edits 接口，最多 3 张参考图；尺寸只有方/竖/横三档，需能直连 openai.com。',
    keyUrl: 'https://platform.openai.com/api-keys',
    keyHint: 'OpenAI Platform → API keys',
    refs: true,
    shape: 'gptimage'
  },
  {
    value: 'gemini',
    label: 'Gemini',
    sub: 'Nano Banana',
    model: 'gemini-2.5-flash-image',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    desc: 'Google 图像模型，多参考图、人物一致性强；国内网络需代理。进阶可把模型改成 gemini-3-pro-image（更强更贵）。',
    keyUrl: 'https://aistudio.google.com/apikey',
    keyHint: 'Google AI Studio → Get API key（免费额度）',
    refs: true,
    shape: 'gemini'
  },
  {
    value: 'minimax',
    label: 'MiniMax',
    sub: 'image-01',
    model: 'image-01',
    baseUrl: 'https://api.minimax.io/v1',
    desc: '官方图像接口只认一张角色参考图（优先取人脸），姿势主要靠文字描述；H3 是视频模型，暂不适用。',
    keyUrl: 'https://platform.minimax.io/console',
    keyHint: 'MiniMax 开放平台 → 账户管理 → API Keys',
    refs: true,
    shape: 'minimax'
  },
  {
    value: 'custom',
    label: '自定义 / 中转站',
    sub: 'OpenAI 兼容',
    model: '',
    baseUrl: '',
    desc: '任何 OpenAI 兼容接口都能填：中转站、ComfyUI 网关、自建代理。接口地址填根地址即可，粘成完整端点会自动纠正。',
    keyUrl: '',
    keyHint: '填写服务商给你的 Base URL 与模型名',
    refs: true,
    shape: 'openai'
  }
]

export const RATIOS = [
  { id: '1:1', label: '1:1', w: 1, h: 1, size: '1024x1024' },
  { id: '3:4', label: '3:4', w: 3, h: 4, size: '864x1152' },
  { id: '4:3', label: '4:3', w: 4, h: 3, size: '1152x864' },
  { id: '9:16', label: '9:16', w: 9, h: 16, size: '720x1280' },
  { id: '16:9', label: '16:9', w: 16, h: 9, size: '1280x720' }
]

export const ratioMeta = (id: string) => RATIOS.find((r) => r.id === id) ?? RATIOS[0]

// providers.json 内容 → 合法供应商列表：字段缺失给默认值，value 重复/非法的条目丢弃
export function sanitizeProviders(raw: unknown): ProviderDef[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: ProviderDef[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const p = item as Partial<ProviderDef>
    if (typeof p.value !== 'string' || !p.value.trim()) continue
    if (typeof p.label !== 'string' || !p.label.trim()) continue
    if (seen.has(p.value)) continue
    out.push({
      value: p.value,
      label: p.label,
      sub: typeof p.sub === 'string' ? p.sub : '',
      model: typeof p.model === 'string' ? p.model : '',
      baseUrl: typeof p.baseUrl === 'string' ? p.baseUrl : '',
      desc: typeof p.desc === 'string' ? p.desc : '',
      keyUrl: typeof p.keyUrl === 'string' ? p.keyUrl : '',
      keyHint: typeof p.keyHint === 'string' ? p.keyHint : '',
      refs: p.refs !== false,
      shape: PROVIDER_SHAPES.includes(p.shape as ProviderShape) ? (p.shape as ProviderShape) : 'openai'
    })
    seen.add(p.value)
  }
  return out
}

// 服装图库里的敏感分类：跟随「允许成人向内容」开关隐藏（与 catalog 原文精确匹配）
export const SENSITIVE_CATEGORIES = ['内衣・睡衣', '性感穿搭', '泳装・度假']

async function openExternal(url: string) {
  try {
    await invoke('open_url', { url })
  } catch {
    // plain-browser dev mode: Tauri command unavailable
    window.open(url, '_blank')
  }
}

export { openExternal }

export const DEFAULT_SETTINGS: Settings = { provider: 'ark', ratio: '1:1', configs: {}, theme: 'dark' }

export const STORAGE_KEY = 'ziran.settings'
export const EMPTY_REFS: Refs = { photo: null, pose: null, costume: null, face: null }
export const REF_META: Record<RefKey, { name: string; hint: string }> = {
  photo: { name: '参考图', hint: '上传一张照片作为人物依据，可与人脸、姿势、服装叠加' },
  pose: { name: '姿势', hint: '人体姿态参考' },
  costume: { name: '服装', hint: '服饰材质参考' },
  face: { name: '人脸', hint: '五官与发型参考' }
}

export type GalleryView = { id: string; angle: string; angleId: string; thumb: string; full: string }
export type GalleryItem = { id: string; systemId: string; system: string; code: string; category: string; name: string; views: GalleryView[] }
export type GalleryCatalog = {
  origin: string
  source: string
  attribution: string
  systems: { id: string; name: string; poseCount: number }[]
  poses: GalleryItem[]
}
export type RefMeta = { name: string; code: string; angle: string }

const POSE_CATALOG = poseCatalogJson as GalleryCatalog
const COSTUME_CATALOG = costumeCatalogJson as GalleryCatalog
const FACE_CATALOG = faceCatalogJson as GalleryCatalog
export const CATALOGS: Partial<Record<RefKey, GalleryCatalog>> = {
  pose: POSE_CATALOG,
  costume: COSTUME_CATALOG,
  face: FACE_CATALOG
}

export const assetUrl = (origin: string, path: string) => {
  if (!path) return ''
  if (/^(data:|https?:|blob:)/.test(path)) return path
  const base = (origin || '').replace(/\/$/, '')
  return base ? `${base}/${path}` : path
}

// 全图 → 缩略图映射：图库源站在慢网下可能要好几秒才吐出一张全图，
// 画板和小条先用缩略图秒显（浏览图库时已进内存/本地库），全图解析
// 完成后再替换。refs 里存的仍是全图 URL，生成请求按 URL 现取，不受影响。
export const FULL_TO_THUMB = new Map<string, string>()
for (const cat of Object.values(CATALOGS)) {
  if (!cat?.origin) continue
  for (const p of cat.poses) {
    for (const v of p.views) {
      if (v.full && v.thumb) FULL_TO_THUMB.set(assetUrl(cat.origin, v.full), assetUrl(cat.origin, v.thumb))
    }
  }
}

export function loadRefMeta() {
  const out: Record<RefKey, RefMeta | null> = { photo: null, pose: null, costume: null, face: null }
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

// 配置项清洗：只留字符串字段，全空的条目丢弃
export function sanitizeConfigs(raw: unknown): Record<string, ProviderUserConfig> {
  const out: Record<string, ProviderUserConfig> = {}
  if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (!v || typeof v !== 'object') continue
      const c = v as Record<string, unknown>
      const apiKey = typeof c.apiKey === 'string' ? c.apiKey : ''
      const model = typeof c.model === 'string' ? c.model : ''
      const baseUrl = typeof c.baseUrl === 'string' ? c.baseUrl : ''
      // soft 三态：未设置 = 默认开，只有显式 false（用户主动关）才值得留条目
      if (apiKey || model || baseUrl || c.soft === false || c.adult === true)
        out[k] = { apiKey, model, baseUrl, soft: c.soft !== false, adult: c.adult === true }
    }
  }
  return out
}

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_SETTINGS
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const pickRatio = (v: unknown) =>
      typeof v === 'string' && RATIOS.some((r) => r.id === v) ? v : DEFAULT_SETTINGS.ratio
    const pickTheme = (v: unknown): Theme => (v === 'light' ? 'light' : 'dark')
    // 旧格式（全局单一 apiKey）迁移：挪进当时所用供应商名下，其余供应商不受影响
    const legacy = typeof parsed.apiKey === 'string' && !parsed.configs
    const legacyProvider =
      typeof parsed.provider === 'string' && DEFAULT_PROVIDERS.some((p) => p.value === parsed.provider)
        ? parsed.provider
        : DEFAULT_SETTINGS.provider
    const configs = sanitizeConfigs(
      legacy
        ? { [legacyProvider]: { apiKey: parsed.apiKey, model: parsed.model, baseUrl: parsed.baseUrl } }
        : parsed.configs
    )
    // 委婉描述默认从「关」改为「开」：旧存档里写死的 soft:false 是旧默认值，不是用户的
    // 明确选择，一次性翻成开；softDefaultOn 标记保证只翻这一次，此后的 false 才是用户主动关
    if (!parsed.softDefaultOn) for (const c of Object.values(configs)) if (c.soft === false) c.soft = true
    const provider = legacy
      ? legacyProvider
      : typeof parsed.provider === 'string' && DEFAULT_PROVIDERS.some((p) => p.value === parsed.provider)
        ? parsed.provider
        : DEFAULT_SETTINGS.provider
    return { provider, ratio: pickRatio(parsed.ratio), configs, theme: pickTheme(parsed.theme), softDefaultOn: true }
  } catch {
    return DEFAULT_SETTINGS
  }
}

export function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

export type IconName =
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
  | 'pen'
  | 'settings'
  | 'camera'
  | 'bookmark'
  | 'history'
  | 'sun'
  | 'moon'

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
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 3.4v2M12 18.6v2M3.4 12h2M18.6 12h2M5.9 5.9l1.4 1.4M16.7 16.7l1.4 1.4M18.1 5.9l-1.4 1.4M7.3 16.7l-1.4 1.4" />
    </>
  ),
  moon: <path d="M20 13.2A8.2 8.2 0 1110.8 4a6.5 6.5 0 009.2 9.2z" />,
  settings: (
    <>
      <path d="M4.5 7.5h15M4.5 16.5h15" />
      <circle cx="9.5" cy="7.5" r="2.2" />
      <circle cx="14.5" cy="16.5" r="2.2" />
    </>
  ),
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
  ),
  pen: <path d="M5 15.8l9.9-9.9a1.9 1.9 0 012.7 0l.5.5a1.9 1.9 0 010 2.7l-9.9 9.9-3.9 1zM14.4 6.4l3.2 3.2" />,
  camera: (
    <>
      <path d="M4 9.1A2.1 2.1 0 016.1 7h1.4l1.2-1.9h6.6l1.2 1.9h1.4A2.1 2.1 0 0120 9.1v7.6a2.1 2.1 0 01-2.1 2.1H6.1A2.1 2.1 0 014 16.7z" />
      <circle cx="12" cy="12.6" r="3.2" />
    </>
  ),
  bookmark: <path d="M7 4.5h10a1 1 0 011 1V20l-6-3.6L6 20V5.5a1 1 0 011-1z" />,
  history: (
    <>
      <circle cx="12" cy="12" r="7.6" />
      <path d="M12 7.8v4.4l3 1.8" />
    </>
  ),
}

export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
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

// 手机端检测：WebView 宽屏桌面窗口仍走桌面布局；窄窗口或触控粗指针
// （安卓手机平板）走手机专属界面。JSX 分支在 App 内按该值切换。
export const PHONE_MQ = '(max-width: 640px), ((pointer: coarse) and (max-width: 900px))'

export function useIsPhone() {
  const [isPhone, setIsPhone] = useState(() => window.matchMedia(PHONE_MQ).matches)
  useEffect(() => {
    const mq = window.matchMedia(PHONE_MQ)
    const onChange = () => setIsPhone(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return isPhone
}

// data URI 内存缓存：LRU 上限，防止翻遍三个图库后常驻内存无界增长
// （一张缩略图 data URI 约 15~30KB，700 张 ≈ 20MB 封顶，盖住最大图库全套分类）
const THUMB_MEM_MAX = 700
const thumbMem = new Map<string, string>()

function cacheThumb(url: string, uri: string) {
  if (thumbMem.size >= THUMB_MEM_MAX) {
    const oldest = thumbMem.keys().next().value
    if (oldest !== undefined) thumbMem.delete(oldest)
  }
  thumbMem.set(url, uri)
}

// resolve a remote asset to a local copy stored in the SQLite gallery DB
// (remote has no CORS headers, so the webview cannot fetch it directly)
export async function cachedSrc(url: string, kind: string): Promise<string> {
  const hit = thumbMem.get(url)
  if (hit) {
    // 触碰一次，保持 LRU 顺序
    thumbMem.delete(url)
    thumbMem.set(url, hit)
    return hit
  }
  const uri = await invoke<string>('image_data_uri', { url, kind })
  cacheThumb(url, uri)
  return uri
}

// 参考图小条用本地缓存显示：优先缩略图（图库里点过就已在内存），
// 没有映射再退回全图本身。慢网下不再卡在远程地址上。
export function RefThumb({ url, kind }: { url: string | null; kind: RefKey }) {
  const [src, setSrc] = useState('')
  useEffect(() => {
    let cancelled = false
    setSrc('')
    if (!url) return
    if (url.startsWith('data:')) {
      setSrc(url)
      return
    }
    cachedSrc(FULL_TO_THUMB.get(url) ?? url, kind)
      .then((s) => {
        if (!cancelled) setSrc(s)
      })
      .catch(() => {
        if (!cancelled) setSrc(url)
      })
    return () => {
      cancelled = true
    }
  }, [url, kind])
  return src ? <img src={src} alt={REF_META[kind].name} /> : null
}

// 历史条缩略图：按条目 id 取 96px 小图（服务端已生成好，几 KB 一张），
// 读取失败就留空底色，不阻塞整条。
export function HistoryThumb({ id }: { id: number }) {
  const [src, setSrc] = useState('')
  useEffect(() => {
    let cancelled = false
    invoke<string>('history_thumb', { id })
      .then((s) => {
        if (!cancelled) setSrc(s)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [id])
  return src ? <img src={src} alt="" draggable={false} /> : <span className="history-thumb-wait" />
}

// 模板缩略图：与历史条同一套存读，只是走 templates 表
export function TemplateThumb({ id }: { id: number }) {
  const [src, setSrc] = useState('')
  useEffect(() => {
    let cancelled = false
    invoke<string>('template_thumb', { id })
      .then((s) => {
        if (!cancelled) setSrc(s)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [id])
  return src ? <img src={src} alt="" draggable={false} /> : <span className="history-thumb-wait" />
}

// 大图预览走本地库：全图多半已被画板/点选预热，直接命中缓存
export function PreviewImg({ url }: { url: string }) {
  const [src, setSrc] = useState(url.startsWith('data:') ? url : '')
  useEffect(() => {
    if (url.startsWith('data:')) return
    let cancelled = false
    cachedSrc(url, 'ref')
      .then((s) => {
        if (!cancelled) setSrc(s)
      })
      .catch(() => {
        if (!cancelled) setSrc(url)
      })
    return () => {
      cancelled = true
    }
  }, [url])
  if (!src) return <span className="thumb-loading" aria-label="加载中" />
  return <img src={src} alt="" />
}

export function GalleryImageImpl({
  view,
  origin,
  alt,
  kind
}: {
  view: GalleryView
  origin: string
  alt: string
  kind: RefKey
}) {
  const remote = assetUrl(origin, view.thumb)
  const [src, setSrc] = useState('')
  const [failed, setFailed] = useState(false)
  const holderRef = useRef<HTMLSpanElement | null>(null)

  useEffect(() => {
    setSrc('')
    setFailed(false)
    let cancelled = false
    const el = holderRef.current
    if (!el || !remote) return
    // lazy: only hit the cache/network once the card is near the viewport
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          io.disconnect()
          cachedSrc(remote, kind)
            .then((s) => {
              if (!cancelled) setSrc(s)
            })
            .catch(() => {
              if (!cancelled) setSrc(remote)
            })
        }
      },
      { rootMargin: '1000px' }
    )
    io.observe(el)
    return () => {
      cancelled = true
      io.disconnect()
    }
  }, [remote, kind])

  if (failed) {
    return (
      <span className="pose-fallback">
        <Icon name="image" size={18} />
      </span>
    )
  }
  return (
    <span className="pose-thumb-media" ref={holderRef}>
      {src ? (
        <img
          src={src}
          alt={alt}
          loading="lazy"
          decoding="async"
          onError={() => {
            if (src !== remote) setSrc(remote)
            else setFailed(true)
          }}
        />
      ) : null}
    </span>
  )
}

// memo：点选卡片只让被点中的那张重绘，其余上千张直接跳过调和。
// props（view/origin/alt/kind）都来自 catalog 的稳定引用，memo 有效。
export const GalleryImage = memo(GalleryImageImpl)

// 生成时间 → 「6/8 14:05」样式
export function historyTime(created: number) {
  const t = new Date(created * 1000)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${t.getMonth() + 1}/${t.getDate()} ${pad(t.getHours())}:${pad(t.getMinutes())}`
}
