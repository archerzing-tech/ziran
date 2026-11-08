import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { invoke } from '@tauri-apps/api/core'
import { save } from '@tauri-apps/plugin-dialog'
import poseCatalogJson from './data/poses.json'
import costumeCatalogJson from './data/costumes.json'
import faceCatalogJson from './data/faces.json'

type ProviderUserConfig = { apiKey: string; model: string; baseUrl: string; soft?: boolean; adult?: boolean }
type Settings = {
  provider: string
  ratio: string
  // 每个供应商一份独立配置：切模型各用各的 Key，模型/地址的自定义也互不覆盖
  configs: Record<string, ProviderUserConfig>
}
const EMPTY_PCONF: ProviderUserConfig = { apiKey: '', model: '', baseUrl: '', soft: false, adult: false }

type RefKey = 'photo' | 'pose' | 'costume' | 'face'
type Refs = Record<RefKey, string | null>
type Tone = 'neutral' | 'busy' | 'ok' | 'err'

type ProviderShape = 'ark' | 'siliconflow' | 'openai' | 'gptimage' | 'gemini' | 'minimax'

type ProviderDef = {
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

const PROVIDER_SHAPES: ProviderShape[] = ['ark', 'siliconflow', 'openai', 'gptimage', 'gemini', 'minimax']

// 内置默认供应商，同时是 providers.json 的种子内容：
// 配置文件在应用数据目录（首次启动写入），用户可直接编辑增删改，
// 界面里「编辑配置文件」可打开所在文件夹，「重新加载」即时生效。
const DEFAULT_PROVIDERS: ProviderDef[] = [
  {
    value: 'ark',
    label: 'Seedream',
    sub: '火山引擎 · 方舟',
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

const RATIOS = [
  { id: '1:1', label: '1:1', w: 1, h: 1, size: '1024x1024' },
  { id: '3:4', label: '3:4', w: 3, h: 4, size: '864x1152' },
  { id: '4:3', label: '4:3', w: 4, h: 3, size: '1152x864' },
  { id: '9:16', label: '9:16', w: 9, h: 16, size: '720x1280' },
  { id: '16:9', label: '16:9', w: 16, h: 9, size: '1280x720' }
]

const ratioMeta = (id: string) => RATIOS.find((r) => r.id === id) ?? RATIOS[0]

// providers.json 内容 → 合法供应商列表：字段缺失给默认值，value 重复/非法的条目丢弃
function sanitizeProviders(raw: unknown): ProviderDef[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: ProviderDef[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const p = item as Partial<ProviderDef>
    if (typeof p.value !== 'string' || !p.value.trim()) continue
    if (typeof p.label !== 'string' || !p.label.trim()) continue
    if (seen.has(p.value)) continue
    seen.add(p.value)
    out.push({
      value: p.value,
      label: p.label,
      sub: typeof p.sub === 'string' ? p.sub : '',
      model: typeof p.model === 'string' ? p.model : '',
      baseUrl: typeof p.baseUrl === 'string' ? p.baseUrl : '',
      desc: typeof p.desc === 'string' ? p.desc : '',
      keyUrl: typeof p.keyUrl === 'string' ? p.keyUrl : '',
      keyHint: typeof p.keyHint === 'string' ? p.keyHint : '',
      refs: p.refs === true,
      shape: PROVIDER_SHAPES.includes(p.shape as ProviderShape) ? (p.shape as ProviderShape) : 'openai'
    })
  }
  return out
}

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
  }
): Promise<HttpResult> => {
  if (IN_TAURI) {
    return invoke<HttpResult>('provider_fetch', {
      request: {
        url,
        headers,
        json_body: init.json ?? null,
        form_fields: init.fields ?? [],
        form_files: init.files ?? []
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

// 服装图库里的敏感分类：跟随「允许成人向内容」开关隐藏（与 catalog 原文精确匹配）
const SENSITIVE_CATEGORIES = ['内衣・睡衣', '性感穿搭', '泳装・度假']

// 判定一次生成失败是否疑似「内容审核拦截」：方舟是
// OutputImageSensitiveContentDetected / InputImageSensitiveContentDetected，
// 其他常见写法一并覆盖；宁可多提示，也不要把审核问题当软件故障让用户白查
const CENSOR_RE =
  /SensitiveContentDetected|content_policy|ContentPolicy|content_moderation|内容审核|审核未通过|审核拦截|敏感内容|违规内容/i
function isCensorError(msg: string): boolean {
  return CENSOR_RE.test(msg)
}

async function openExternal(url: string) {
  try {
    await invoke('open_url', { url })
  } catch {
    // plain-browser dev mode: Tauri command unavailable
    window.open(url, '_blank')
  }
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

const DEFAULT_SETTINGS: Settings = { provider: 'ark', ratio: '1:1', configs: {} }

const STORAGE_KEY = 'ziran.settings'
const EMPTY_REFS: Refs = { photo: null, pose: null, costume: null, face: null }
const REF_META: Record<RefKey, { name: string; hint: string }> = {
  photo: { name: '人物照片', hint: '上传一张照片，配姿势即可生成（与人脸二选一）' },
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
const CATALOGS: Partial<Record<RefKey, GalleryCatalog>> = {
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

// 全图 → 缩略图映射：图库源站在慢网下可能要好几秒才吐出一张全图，
// 画板和小条先用缩略图秒显（浏览图库时已进内存/本地库），全图解析
// 完成后再替换。refs 里存的仍是全图 URL，生成请求按 URL 现取，不受影响。
const FULL_TO_THUMB = new Map<string, string>()
for (const cat of Object.values(CATALOGS)) {
  if (!cat?.origin) continue
  for (const p of cat.poses) {
    for (const v of p.views) {
      if (v.full && v.thumb) FULL_TO_THUMB.set(assetUrl(cat.origin, v.full), assetUrl(cat.origin, v.thumb))
    }
  }
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

// 配置项清洗：只留字符串字段，全空的条目丢弃
function sanitizeConfigs(raw: unknown): Record<string, ProviderUserConfig> {
  const out: Record<string, ProviderUserConfig> = {}
  if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (!v || typeof v !== 'object') continue
      const c = v as Record<string, unknown>
      const apiKey = typeof c.apiKey === 'string' ? c.apiKey : ''
      const model = typeof c.model === 'string' ? c.model : ''
      const baseUrl = typeof c.baseUrl === 'string' ? c.baseUrl : ''
      if (apiKey || model || baseUrl || c.soft === true || c.adult === true)
        out[k] = { apiKey, model, baseUrl, soft: c.soft === true, adult: c.adult === true }
    }
  }
  return out
}

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_SETTINGS
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const pickRatio = (v: unknown) =>
      typeof v === 'string' && RATIOS.some((r) => r.id === v) ? v : DEFAULT_SETTINGS.ratio
    // 旧格式（全局单一 apiKey）迁移：挪进当时所用供应商名下，其余供应商不受影响
    if (typeof parsed.apiKey === 'string' && !parsed.configs) {
      const legacyProvider =
        typeof parsed.provider === 'string' && DEFAULT_PROVIDERS.some((p) => p.value === parsed.provider)
          ? parsed.provider
          : DEFAULT_SETTINGS.provider
      return {
        provider: legacyProvider,
        ratio: pickRatio(parsed.ratio),
        configs: sanitizeConfigs({
          [legacyProvider]: { apiKey: parsed.apiKey, model: parsed.model, baseUrl: parsed.baseUrl }
        }),
      }
    }
    const provider =
      typeof parsed.provider === 'string' && DEFAULT_PROVIDERS.some((p) => p.value === parsed.provider)
        ? parsed.provider
        : DEFAULT_SETTINGS.provider
    return { provider, ratio: pickRatio(parsed.ratio), configs: sanitizeConfigs(parsed.configs) }
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
  const [providers, setProviders] = useState<ProviderDef[]>(DEFAULT_PROVIDERS)
  const [providersPath, setProvidersPath] = useState('')
  const providerMeta = (id: string) => providers.find((p) => p.value === id) ?? providers[0]
  const [refs, setRefs] = useState<Refs>(EMPTY_REFS)
  const [active, setActive] = useState<RefKey>('pose')
  const [prompt, setPrompt] = useState('')
  const [result, setResult] = useState('')
  const [status, setStatus] = useState<{ text: string; tone: Tone }>({ text: '就绪', tone: 'neutral' })
  const [busy, setBusy] = useState(false)
  const [refMeta, setRefMeta] = useState<Record<RefKey, RefMeta | null>>(loadRefMeta)
  const [galleryOpen, setGalleryOpen] = useState<RefKey | null>(null)
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
      const fit = Math.min((area.clientWidth - 96) / boardW, (area.clientHeight - 96) / boardH)
      setZoom(Math.max(0.2, Math.min(1.6, Number(fit.toFixed(2)))))
    }
    compute()
    window.addEventListener('resize', compute)
    return () => window.removeEventListener('resize', compute)
  }, [autoFit, boardW, boardH])

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
    setRefs((prev) => {
      const next = { ...prev, [key]: value }
      // 人物照片与人脸同为「人物身份」来源，二者互斥，后选的生效
      if (key === 'photo' && value && prev.face) {
        next.face = null
        setStatus({ text: '已改用人物照片作为人物依据，原人脸参考已移除', tone: 'ok' })
      } else if (key === 'face' && value && prev.photo) {
        next.photo = null
        setStatus({ text: '已改用人脸参考作为人物依据，原人物照片已移除', tone: 'ok' })
      }
      return next
    })
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
      setStatus({ text: '请先选一个姿势，或上传一张人物照片', tone: 'err' })
      void logEvent('warn', 'generate', `provider=${settings.provider} aborted: no reference`)
      return
    }
    if (!meta.refs && !prompt.trim()) {
      setStatus({ text: `${meta.label} 只按文字画图，请先写一段描述`, tone: 'err' })
      void logEvent('warn', 'generate', `provider=${settings.provider} aborted: no prompt`)
      return
    }

    const refList = [refs.photo, refs.pose, refs.costume, refs.face].filter(Boolean) as string[]
    // 委婉描述按服务商开关：接入不设限的服务商时关掉，保提示词原样；
    // 「允许成人向内容」打开时不附加「画面得体」的约束句
    const conf = effConfig()
    const rawPrompt = prompt.trim() || autoPrompt(refs)
    const promptText = conf.soft ? softenPrompt(rawPrompt, !!conf.adult) : rawPrompt
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

    setBusy(true)
    setCensor(false)
    setStatus({ text: `正在生成图像 · ${meta.label}`, tone: 'busy' })
    const startedAt = Date.now()
    const genLog = (level: 'info' | 'error', rest: string) =>
      void logEvent(
        level,
        'generate',
        `provider=${settings.provider} model=${model} keyLen=${key.length} base=${base} ratio=${ratio.id} soft=${!!conf.soft} adult=${!!conf.adult} refs=${refList.length} ${rest}`
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
            })
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
            })
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
            { fields: [['model', model], ['prompt', promptText], ['size', gptSize]], files }
          )
        } else {
          out = await providerPost(
            `${base}/images/generations`,
            { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
            { json: JSON.stringify({ model, prompt: promptText, size: gptSize }) }
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
          { json: JSON.stringify(body) }
        )
        if (status >= 400) throw new Error(`生成失败 ${status} · ${humanizeError(text.slice(0, 180))}`)
        const data = JSON.parse(text)
        output = data?.data?.[0]?.url || data?.data?.[0]?.b64_json || ''
        if (output && !output.startsWith('http') && !output.startsWith('data:')) {
          output = `data:image/png;base64,${output}`
        }
      }

      if (output.startsWith('http') || output.startsWith('data:')) {
        setResult(output)
        setCensor(false)
        setStatus({ text: '生成完成', tone: 'ok' })
        genLog('info', `status=ok durMs=${Date.now() - startedAt}`)
      } else {
        setStatus({ text: '响应里没有图像数据', tone: 'err' })
        genLog('error', `status=no-image durMs=${Date.now() - startedAt}`)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : `请求失败 · ${String(err)}`
      const censored = isCensorError(msg)
      setCensor(censored)
      const statusMatch = /^生成失败 (\d+)/.exec(msg)
      genLog(
        'error',
        `status=${statusMatch ? statusMatch[1] : 'transport'} durMs=${Date.now() - startedAt} censor=${censored} msg=${msg}`
      )
      setStatus({ text: `${msg}（已记入日志）`, tone: 'err' })
    } finally {
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

  // 保存成图：系统保存对话框 + Rust 落盘。webview 对 <a download> 的支持
  // 不可靠（WKWebView 常把它当页面导航），落盘这件事交给后端才稳。
  // 远端 URL 先借 Rust 的下载缓存通道转成 data: URI（前端 fetch 会撞 CORS）；
  // 纯浏览器开发预览没有对话框，退回老的 <a download> 路径。
  const saveResult = async () => {
    if (!result) return
    const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')
    let dataUrl = result
    if (!dataUrl.startsWith('data:image/')) {
      try {
        dataUrl = await invoke<string>('image_data_uri', { url: result, kind: 'result' })
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
        setStatus({ text: '第二步：选一个姿势，或上传一张人物照片', tone: 'err' })
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
          <button className="icon-btn" title="保存成图（⌘S）" onClick={saveResult} disabled={!result}>
            <Icon name="download" size={17} />
          </button>
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
            </div>
          </div>

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
                  <span className="ref-strip-label">{stripLabel(k)}</span>
                </button>
              ))}
            </div>
          )}

          {busy && (
            <div className="gen-veil" role="status" aria-live="polite">
              <span className="gen-ring" />
              <p className="gen-title">正在生成图像 · {activeProvider.label}</p>
              <p className="gen-sub">
                请求已发往 {activeProvider.sub || '服务商'}，一般 10–30 秒出图；可以继续浏览，完成后自动载入画板
              </p>
            </div>
          )}

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
                {activeProvider.refs ? '照片与人脸二选一 · 姿势、服装可叠加' : '当前服务商不支持参考图'}
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

      {galleryOpen && (
        <RefGallery
          key={galleryOpen}
          kind={galleryOpen}
          catalog={CATALOGS[galleryOpen]}
          activeCode={refMeta[galleryOpen]?.code ?? ''}
          hideSensitive={galleryOpen === 'costume' && !effConfig().adult}
          onClose={() => setGalleryOpen(null)}
          onApply={(item, view) => {
            const kind = galleryOpen
            const url = assetUrl(CATALOGS[kind].origin, view.full)
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
                  <p>从姿势图库挑一张线稿，或直接上传一张人物照片——两者给一个就能出图；服装和人脸可选，加了更像。</p>
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
              </nav>
              <div className="panel-edit">
                <p className="provider-desc">{panelMeta.desc}</p>
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
                        checked={!!effConfig(panelMeta.value).soft}
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
                      只对上面选中的「{panelMeta.label}」生效，各模型互不影响。生成被审核拦下时，开「委婉描述」多数能过；
                      接入不限制内容的服务商时可以都关掉，提示词保持原样。
                    </p>
                  </div>
                </div>
                <div className="field">
                  <label>连通性测试</label>
                  <div className="test-row">
                    <button
                      className="test-btn"
                      disabled={testing !== null}
                      title="发一次最小生成请求，验证 Key、模型与网络"
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
                  <p className="help">发一次最小生成请求验证 Key、模型与网络，与正式生成走同一链路；可能产生少量费用。</p>
                </div>
                {!panelMeta.refs && <p className="help">该模型只按文字画图，不支持参考图。</p>}
              </div>
            </div>
            <div className="panel-foot">
              <div className="provider-config">
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
        </div>
      </footer>
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
                autoFocus
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
async function cachedSrc(url: string, kind: string): Promise<string> {
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
function RefThumb({ url, kind }: { url: string | null; kind: RefKey }) {
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

// 大图预览走本地库：全图多半已被画板/点选预热，直接命中缓存
function PreviewImg({ url }: { url: string }) {
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

function GalleryImage({
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

const container = document.getElementById('root')
if (!container) throw new Error('#root container missing')
createRoot(container).render(<App />)
