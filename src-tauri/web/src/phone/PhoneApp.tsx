import { useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { save } from '@tauri-apps/plugin-dialog'
import {
  APP_VERSION,
  CATALOGS,
  HistoryThumb,
  historyTime,
  Icon,
  RATIOS,
  ratioMeta,
  REF_META,
  RefThumb,
  TemplateThumb
} from '../shared'
import type {
  HistoryItem,
  ProviderDef,
  RefKey,
  RefMeta,
  Refs,
  Settings,
  TemplateItem,
  Tone
} from '../shared'

/* ---------------- 安卓返回键：最后打开的浮层最先关闭 ----------------
   每个浮层开时压一条带 id 的 history 占位，界面按钮关闭时延迟消费。
   同帧「关 A 开 B」不会打架：A 的 back() 落到 B 的占位之下时，
   popstate 里查不到活浮层，按纯记账忽略。系统返回键则关栈顶。 */
type BackEntry = { id: number; close: () => void; consumed?: boolean }
const backStack: BackEntry[] = []
let backSeq = 0

if (typeof window !== 'undefined') {
  window.addEventListener('popstate', () => {
    const st = (history.state as { ziran?: number } | null)?.ziran
    // 落点是已关浮层的占位（界面关后延迟 back 的残留），不动 UI
    if (st && !backStack.some((e) => e.id === st)) return
    const top = backStack[backStack.length - 1]
    if (!top) return
    top.consumed = true
    backStack.pop()
    top.close()
  })
}

function useBackClose(open: boolean, close: () => void) {
  const closeRef = useRef(close)
  closeRef.current = close
  useEffect(() => {
    if (!open) return
    const entry: BackEntry = { id: ++backSeq, close: () => closeRef.current() }
    backStack.push(entry)
    try {
      history.pushState({ ziran: entry.id }, '')
    } catch {
      // 个别 WebView 禁用 history 操作，退化为无返回键支持
    }
    return () => {
      const i = backStack.indexOf(entry)
      if (i >= 0) backStack.splice(i, 1)
      if (entry.consumed) return // popstate 已消费该占位，不再 back
      setTimeout(() => {
        try {
          if ((history.state as { ziran?: number } | null)?.ziran) history.back()
        } catch {
          // ignore
        }
      }, 0)
    }
  }, [open])
}

/* ---------------- PinchImg：手势缩放 ----------------
   双指捏合缩放（0.8–4）、单指拖移、双击在放大/复位间切换；
   松手时缩放不足 1.05 自动回弹。transform 全程走 ref 直写 style，
   不经过 setState，保证跟手。底片回看大图用它。 */
function PinchImg({ src, alt }: { src: string; alt: string }) {
  const boxRef = useRef<HTMLDivElement>(null)
  const imgRef = useRef<HTMLImageElement>(null)
  const [loaded, setLoaded] = useState(false)
  const st = useRef({
    scale: 1,
    tx: 0,
    ty: 0,
    ptrs: new Map<number, { x: number; y: number }>(),
    startDist: 0,
    startScale: 1,
    startMid: { x: 0, y: 0 },
    moved: 0,
    downT: 0,
    panning: false,
    lastTapT: 0
  })

  useEffect(() => {
    const s = st.current
    s.scale = 1
    s.tx = 0
    s.ty = 0
    s.ptrs.clear()
    setLoaded(false)
    const el = imgRef.current
    if (el) {
      el.classList.remove('is-zoomed')
      el.style.transform = ''
    }
  }, [src])

  const apply = () => {
    const el = imgRef.current
    if (!el) return
    const s = st.current
    el.style.transform = `translate(${s.tx}px, ${s.ty}px) scale(${s.scale})`
    el.classList.toggle('is-zoomed', s.scale > 1.02)
  }

  const animate = () => {
    const el = imgRef.current
    if (!el) return
    el.classList.add('is-anim')
    apply()
    window.setTimeout(() => el.classList.remove('is-anim'), 260)
  }

  // 平移限位：图片放大后拖不出画面太远（留 32px 弹性）
  const clampPan = () => {
    const img = imgRef.current
    const box = boxRef.current
    if (!img || !box) return
    const s = st.current
    const maxX = Math.max(0, (img.offsetWidth * s.scale - box.clientWidth) / 2 + 32)
    const maxY = Math.max(0, (img.offsetHeight * s.scale - box.clientHeight) / 2 + 32)
    s.tx = Math.min(maxX, Math.max(-maxX, s.tx))
    s.ty = Math.min(maxY, Math.max(-maxY, s.ty))
    animate()
  }

  const onDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const s = st.current
    s.ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY })
    e.currentTarget.setPointerCapture(e.pointerId)
    if (s.ptrs.size === 1) {
      s.moved = 0
      s.downT = performance.now()
      s.panning = false
    } else if (s.ptrs.size === 2) {
      const [a, b] = [...s.ptrs.values()]
      s.startDist = Math.hypot(a.x - b.x, a.y - b.y)
      s.startScale = s.scale
      s.startMid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
    }
  }

  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const s = st.current
    const prev = s.ptrs.get(e.pointerId)
    if (!prev) return
    const dx = e.clientX - prev.x
    const dy = e.clientY - prev.y
    s.ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY })
    s.moved += Math.abs(dx) + Math.abs(dy)

    if (s.ptrs.size === 2) {
      const [a, b] = [...s.ptrs.values()]
      const dist = Math.hypot(a.x - b.x, a.y - b.y)
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
      if (s.startDist > 0 && dist > 0) {
        const next = Math.min(4, Math.max(0.8, s.startScale * (dist / s.startDist)))
        s.tx += mid.x - s.startMid.x
        s.ty += mid.y - s.startMid.y
        s.scale = next
        s.startDist = dist
        s.startScale = next
        s.startMid = mid
        apply()
      }
    } else if (s.ptrs.size === 1 && s.scale > 1.02) {
      s.tx += dx
      s.ty += dy
      s.panning = true
      apply()
    }
  }

  const onUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const s = st.current
    if (!s.ptrs.has(e.pointerId)) return
    s.ptrs.delete(e.pointerId)
    if (s.ptrs.size === 0) {
      if (s.scale < 1.05) {
        s.scale = 1
        s.tx = 0
        s.ty = 0
        animate()
      } else {
        clampPan()
      }
      // 双击判定：两次短促、几乎不动的单指点击
      const quick = performance.now() - s.downT < 350 && s.moved < 8 && !s.panning
      if (quick) {
        const now = performance.now()
        if (now - s.lastTapT < 320) {
          s.lastTapT = 0
          if (s.scale > 1.02) {
            s.scale = 1
            s.tx = 0
            s.ty = 0
          } else {
            s.scale = 2.5
          }
          animate()
        } else {
          s.lastTapT = now
        }
      }
    } else if (s.ptrs.size === 1) {
      // 捏合结束后剩单指：重置捏合基准，避免下一帧跳变
      s.startDist = 0
    }
  }

  return (
    <div
      className={`ph-stage ${loaded ? 'is-loaded' : ''}`}
      ref={boxRef}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onContextMenu={(e) => e.preventDefault()}
    >
      <img
        ref={imgRef}
        className="ph-stage-img"
        src={src}
        alt={alt}
        draggable={false}
        onLoad={() => setLoaded(true)}
      />
    </div>
  )
}

/* ---------------- 组件上下文：main.tsx 传入的手机端依赖 ----------------
   状态归属 App 组件；PhoneApp 只做快门台呈现与手机侧交互。 */
export type PhoneCtx = {
  settings: Settings
  update: (patch: Partial<Settings>) => void
  providers: ProviderDef[]
  activeProvider: ProviderDef
  effModel: (value?: string) => string
  hasKey: boolean
  refs: Refs
  refMeta: Record<RefKey, RefMeta | null>
  setActive: (k: RefKey) => void
  clearSlot: (k: RefKey) => void
  pickFile: (file: File | undefined, key: RefKey) => void
  /** 手机端「最近底片 → 设为槽位」：整图 data URI 直接进槽 */
  setSlotImage: (key: RefKey, uri: string) => void
  prompt: string
  setPrompt: (v: string) => void
  busy: boolean
  /** 发起一次生成；校验不过（没 Key / 没参考）返回 undefined，连拍靠它停 */
  runPrimary: () => Promise<void> | undefined
  /** 打断生成中的在途请求（快门旁「取消」按它） */
  cancelGenerate: () => void
  status: { text: string; tone: Tone }
  history: HistoryItem[]
  deleteHistory: (id: number) => void
  saveImage: (src?: string) => void
  templates: TemplateItem[]
  saveTemplateFromHistory: (item: HistoryItem) => void
  saveCanvasTemplate: () => void
  loadTemplateIntoSlot: (t: TemplateItem, slot: RefKey) => void
  canvasSource: string
  canvasBusy: boolean
  canvasLabel: string
  hasResult: boolean
  galleryOpen: RefKey | null
  setGalleryOpen: (k: RefKey | null) => void
  preview: { src: string; title: string } | null
  setPreview: (p: { src: string; title: string } | null) => void
  openPanel: () => void
  setShowGuide: (v: boolean) => void
}

const SLOT_KEYS: RefKey[] = ['photo', 'pose', 'costume', 'face']
const SLOT_ICON: Record<RefKey, 'image' | 'pose' | 'shirt' | 'face'> = {
  photo: 'image',
  pose: 'pose',
  costume: 'shirt',
  face: 'face'
}

/** 连拍上限：同配方多方案，控成本（见设计稿 D-1） */
const BURST_MAX = 4
const IS_ANDROID = typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent)

/* ---------------- 底部面板（槽位选源）：相册 / 拍一张 / 模板库 / 最近底片 ---------------- */
function SlotSheet({
  ctx,
  slot,
  onCatalog,
  onGallery,
  onCamera,
  onTemplates,
  onHistory,
  onClose
}: {
  ctx: PhoneCtx
  slot: RefKey
  onCatalog: (k: RefKey) => void
  onGallery: (k: RefKey) => void
  onCamera: (k: RefKey) => void
  onTemplates: (k: RefKey) => void
  onHistory: (k: RefKey) => void
  onClose: () => void
}) {
  const url = ctx.refs[slot]
  return (
    <div className="k-wrap" onClick={onClose}>
      <div className="k-sheet" onClick={(e) => e.stopPropagation()}>
        <span className="k-grab" />
        <header className="k-sheet-head">
          {url ? (
            <span className="k-sheet-cur">
              <RefThumb url={url} kind={slot} />
            </span>
          ) : (
            <span className="k-sheet-cur is-empty">
              <Icon name={SLOT_ICON[slot]} size={18} />
            </span>
          )}
          <h4>
            {REF_META[slot].name}
            <span>{url ? '已选 · 点来源直接替换' : '还没放 · 选一个来源'}</span>
          </h4>
          {url && (
            <button className="k-clear" onClick={() => { ctx.clearSlot(slot); onClose() }}>
              清除
            </button>
          )}
        </header>
        <div className="k-src-grid">
          {CATALOGS[slot] && (
            <button className="k-src is-catalog" onClick={() => onCatalog(slot)}>
              <b>
                <Icon name="library" size={14} />
                {REF_META[slot].name}图库
              </b>
              <span>{CATALOGS[slot]!.poses.length} 张可选 · 点选即载入</span>
            </button>
          )}
          <button className="k-src" onClick={() => onGallery(slot)}>
            <b>
              <Icon name="image" size={14} />
              相册选图
            </b>
            <span>从手机里挑一张</span>
          </button>
          <button className="k-src" onClick={() => onCamera(slot)}>
            <b>
              <Icon name="camera" size={14} />
              拍一张
            </b>
            <span>对着镜子也行</span>
          </button>
          <button className="k-src" onClick={() => onTemplates(slot)}>
            <b>
              <Icon name="bookmark" size={14} />
              模板库
            </b>
            <span>{ctx.templates.length ? `${ctx.templates.length} 个可用` : '存过成图就有'}</span>
          </button>
          <button className="k-src" onClick={() => onHistory(slot)} disabled={!ctx.history.length}>
            <b>
              <Icon name="history" size={14} />
              最近底片
            </b>
            <span>拿生成过的图当参考</span>
          </button>
        </div>
      </div>
    </div>
  )
}

/* ---------------- 模板库整屏：点卡片 → 底部「导入到」选槽 ---------------- */
function TemplatePanel({
  ctx,
  presetSlot,
  onClose
}: {
  ctx: PhoneCtx
  presetSlot: RefKey | null
  onClose: () => void
}) {
  const [picked, setPicked] = useState<TemplateItem | null>(null)
  const [slot, setSlot] = useState<RefKey>(presetSlot ?? 'photo')
  return (
    <div className="k-panel">
      <header className="k-panel-head">
        <h4>
          模板库
          <span>{ctx.templates.length} 个 · 存了模板就能基于它再出图</span>
        </h4>
        <button className="k-close" onClick={onClose} aria-label="关闭">
          <Icon name="close" size={14} />
        </button>
      </header>
      {ctx.templates.length ? (
        <div className="k-tgrid">
          {ctx.templates.map((t) => (
            <button
              key={t.id}
              className={`k-tcell${picked?.id === t.id ? ' is-pick' : ''}`}
              onClick={() => setPicked(picked?.id === t.id ? null : t)}
              aria-label="选择模板"
            >
              <TemplateThumb id={t.id} />
            </button>
          ))}
        </div>
      ) : (
        <div className="k-panel-empty">
          <Icon name="bookmark" size={26} />
          <b>还没有模板</b>
          <p>出片后点「存模板」，满意图都能变成模板</p>
        </div>
      )}
      {picked && (
        <div className="k-tbar">
          <b>导入到</b>
          {SLOT_KEYS.map((k) => (
            <button
              key={k}
              className={slot === k ? 'is-hot' : ''}
              onClick={() => setSlot(k)}
              aria-label={REF_META[k].name}
            >
              {REF_META[k].name}
            </button>
          ))}
          <button
            className="is-hot is-go"
            onClick={() => {
              ctx.loadTemplateIntoSlot(picked, slot)
              onClose()
            }}
          >
            <Icon name="check" size={12} />
            载入
          </button>
          <button className="k-tbar-x" onClick={() => setPicked(null)} aria-label="取消选择">
            <Icon name="close" size={12} />
          </button>
        </div>
      )}
    </div>
  )
}

/* ---------------- 底片整屏：按天分组；pickMode 下点一张直接进槽 ---------------- */
function dayLabel(created: number): string {
  const d = new Date(created * 1000)
  const now = new Date()
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
  const yesterday = new Date(now.getTime() - 86400000)
  if (sameDay(d, now)) return '今天'
  if (sameDay(d, yesterday)) return '昨天'
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日`
}

function HistoryPanel({
  ctx,
  pickMode,
  onPick,
  onOpen,
  onClose
}: {
  ctx: PhoneCtx
  pickMode: boolean
  onPick: (item: HistoryItem) => void
  onOpen: (item: HistoryItem) => void
  onClose: () => void
}) {
  const groups: Array<{ label: string; items: HistoryItem[] }> = []
  for (const h of ctx.history) {
    const label = dayLabel(h.created)
    const last = groups[groups.length - 1]
    if (last && last.label === label) last.items.push(h)
    else groups.push({ label, items: [h] })
  }
  return (
    <div className="k-panel">
      <header className="k-panel-head">
        <h4>
          底片
          <span>{ctx.history.length} 张 · 本机留存</span>
        </h4>
        <button className="k-close" onClick={onClose} aria-label="关闭">
          <Icon name="close" size={14} />
        </button>
      </header>
      {ctx.history.length ? (
        <div className="k-hgroups">
          {groups.map((g) => (
            <div key={`${g.label}-${g.items[0]?.id}`}>
              <p className="k-hg-label">{g.label}</p>
              <div className="k-hrow">
                {g.items.map((h) => (
                  <button
                    key={h.id}
                    className="k-hcell"
                    onClick={() => (pickMode ? onPick(h) : onOpen(h))}
                    aria-label={pickMode ? '设为参考' : '回看底片'}
                  >
                    <HistoryThumb id={h.id} />
                    <span className="k-hcell-t">{historyTime(h.created)}</span>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="k-panel-empty">
          <Icon name="grid" size={26} />
          <b>还没有底片</b>
          <p>按下快门，出过的图都会自动收进来</p>
        </div>
      )}
      {pickMode && (
        <p className="k-pick-hint">点一张底片，设为参考</p>
      )}
    </div>
  )
}

/* ---------------- 设置整屏：模型与接入 / 说明 / 日志 ---------------- */
function SettingsPanel({ ctx, onClose }: { ctx: PhoneCtx; onClose: () => void }) {
  return (
    <div className="k-panel">
      <header className="k-panel-head">
        <h4>设置</h4>
        <button className="k-close" onClick={onClose} aria-label="关闭">
          <Icon name="close" size={14} />
        </button>
      </header>
      <div className="k-setbody">
        <p className="k-s-label">接入</p>
        <button className="k-set-row" onClick={() => { onClose(); ctx.openPanel() }}>
          <span className="k-row-ic">
            <Icon name="key" size={14} />
          </span>
          <span className="k-row-main">
            <b>模型与接入</b>
            <small>
              {ctx.hasKey
                ? `${ctx.activeProvider.label} · ${ctx.effModel()}`
                : '还没接入 · 中转站地址、Key、模型'}
            </small>
          </span>
          <Icon name="chevron" size={12} />
        </button>
        <button className="k-set-row" onClick={() => { onClose(); ctx.setShowGuide(true) }}>
          <span className="k-row-ic">
            <Icon name="help" size={14} />
          </span>
          <span className="k-row-main">
            <b>使用说明</b>
            <small>怎么摆参考、怎么出片</small>
          </span>
          <Icon name="chevron" size={12} />
        </button>
        <p className="k-s-label">诊断</p>
        <button className="k-set-row" onClick={() => { invoke('open_log_file').catch(() => {}) }}>
          <span className="k-row-ic">
            <Icon name="pen" size={14} />
          </span>
          <span className="k-row-main">
            <b>诊断日志</b>
            <small>出问题时发给开发者</small>
          </span>
          <Icon name="chevron" size={12} />
        </button>
        <p className="k-about">Ziran v{APP_VERSION} · Key 与底片只存本机</p>
      </div>
    </div>
  )
}

/* ---------------- 模型切换底部抽屉 ---------------- */
function ProviderSheet({
  providers,
  settings,
  effModel,
  onPick,
  onManage,
  onClose
}: {
  providers: ProviderDef[]
  settings: Settings
  effModel: (value?: string) => string
  onPick: (value: string) => void
  onManage: () => void
  onClose: () => void
}) {
  const hasCfgKey = (p: ProviderDef) => Boolean(settings.configs[p.value]?.apiKey?.trim())
  return (
    <div className="k-wrap" onClick={onClose}>
      <div className="k-sheet" onClick={(e) => e.stopPropagation()}>
        <span className="k-grab" />
        <header className="k-sheet-head">
          <h4>
            模型
            <span>Key 按模型分开存 · 只存本机</span>
          </h4>
          <button className="k-close" onClick={onClose} aria-label="关闭">
            <Icon name="close" size={14} />
          </button>
        </header>
        <div className="k-prov-list">
          {providers.map((p) => {
            const active = p.value === settings.provider
            return (
              <button key={p.value} className={`k-prov${active ? ' is-active' : ''}`} onClick={() => onPick(p.value)}>
                <span className="k-prov-main">
                  <span className="k-prov-name">{p.label}</span>
                  <span className="k-prov-sub">{p.sub}</span>
                </span>
                <span className="k-prov-model">{effModel(p.value)}</span>
                <span className={`k-prov-key${hasCfgKey(p) ? ' on' : ''}`} title={hasCfgKey(p) ? 'Key 已设置' : 'Key 未设置'} />
                {active && <Icon name="check" size={13} />}
              </button>
            )
          })}
          <button className="k-prov is-manage" onClick={onManage}>
            <Icon name="settings" size={14} />
            接入与 Key 管理…
          </button>
        </div>
      </div>
    </div>
  )
}

/* ---------------- 底片回看：手势缩放大图 + 保存 / 存模板 / 删除 ---------------- */
function WorksViewer({
  item,
  providers,
  onClose,
  onSave,
  onSaveTemplate,
  onDelete
}: {
  item: HistoryItem
  providers: ProviderDef[]
  onClose: () => void
  onSave: (src: string) => void
  onSaveTemplate: () => void
  onDelete: (id: number) => void
}) {
  const [full, setFull] = useState('')
  const [arm, setArm] = useState(false)
  const armT = useRef(0)

  useEffect(() => {
    let cancelled = false
    setFull('')
    invoke<string>('history_image', { id: item.id })
      .then((s) => {
        if (!cancelled) setFull(s)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [item.id])

  useEffect(() => () => window.clearTimeout(armT.current), [])

  const prov = providers.find((p) => p.value === item.provider)
  const del = () => {
    if (!arm) {
      setArm(true)
      window.clearTimeout(armT.current)
      armT.current = window.setTimeout(() => setArm(false), 2600)
      return
    }
    window.clearTimeout(armT.current)
    onDelete(item.id)
  }

  return (
    <div className="k-viewer">
      <header className="k-viewer-top">
        <button className="k-iconbtn" onClick={onClose} aria-label="关闭">
          <Icon name="close" size={16} />
        </button>
        <div className="k-viewer-meta">
          <b>{prov?.label ?? item.provider}</b>
          <span>{historyTime(item.created)}</span>
        </div>
        <button className="k-iconbtn" onClick={() => full && onSave(full)} aria-label="保存">
          <Icon name="download" size={16} />
        </button>
        <button className="k-iconbtn" onClick={onSaveTemplate} aria-label="存为模板" title="存为模板，之后可基于它再生成">
          <Icon name="bookmark" size={16} />
        </button>
        <button className={`k-iconbtn is-danger${arm ? ' is-arm' : ''}`} onClick={del} aria-label={arm ? '再点一次确认删除' : '删除'}>
          <Icon name="trash" size={16} />
        </button>
      </header>
      <div className="k-viewer-stage">
        {full ? <PinchImg src={full} alt="底片原图" /> : <span className="k-spin" aria-label="加载中" />}
      </div>
    </div>
  )
}

/* ---------------- 手机端外壳：快门台 ---------------- */
export function PhoneApp(ctx: PhoneCtx) {
  // busy 只表示「在生成」：快门转圈、取消按钮、手势守卫都只认它。
  // canvasBusy 是画板换参考图的短暂加载，之前混进 busy，结果每选一张
  // 图库图片快门就假装在生成——用 mediaBusy 单独驱动取景框的转圈。
  const busy = ctx.busy
  const mediaBusy = busy || ctx.canvasBusy
  const ratio = ratioMeta(ctx.settings.ratio)

  // 浮层状态全部归属外壳：槽位面板 / 模板库 / 底片 / 设置 / 模型抽屉 / 回看
  const [slotSheet, setSlotSheet] = useState<RefKey | null>(null)
  const [tplOpen, setTplOpen] = useState<{ slot: RefKey | null } | null>(null)
  const [histOpen, setHistOpen] = useState<{ pick: RefKey | null } | null>(null)
  const [setOpen, setSetOpen] = useState(false)
  const [provSheet, setProvSheet] = useState(false)
  const [viewerItem, setViewerItem] = useState<HistoryItem | null>(null)
  const [ratioOpen, setRatioOpen] = useState(false)

  // 取景框：翻底片的下标；null = 看最新成片
  const [vfIdx, setVfIdx] = useState<number | null>(null)
  // 出片瞬间：闪光 + 操作条（6 秒后收起）
  const [flash, setFlash] = useState(false)
  const [actsOn, setActsOn] = useState(false)
  // 连拍进行到第几张；0 = 没在连拍
  const [burstShot, setBurstShot] = useState(0)
  // 首启一次性提示
  const [tipOn, setTipOn] = useState(() => {
    try {
      return localStorage.getItem('ziran.ph.tip') !== '1'
    } catch {
      return true
    }
  })
  const dismissTip = () => {
    setTipOn(false)
    try {
      localStorage.setItem('ziran.ph.tip', '1')
    } catch {
      // ignore
    }
  }

  const [toast, setToast] = useState<{ text: string; tone: Tone } | null>(null)
  const lastToast = useRef(ctx.status.text)
  const notify = (text: string, tone: Tone) => {
    setToast({ text, tone })
    window.setTimeout(() => setToast(null), 4000)
  }

  // 状态栏消息 → 轻提示：首帧的初始消息不弹，只有变化才弹
  useEffect(() => {
    if (!ctx.status.text || ctx.status.text === lastToast.current) return
    lastToast.current = ctx.status.text
    setToast({ text: ctx.status.text, tone: ctx.status.tone })
    const t = window.setTimeout(() => setToast(null), 4000)
    return () => window.clearTimeout(t)
  }, [ctx.status])

  const busyRef = useRef(busy)
  // 换图加载的几百毫秒里也不接手势（保持原行为），但不算「生成中」
  busyRef.current = busy || ctx.canvasBusy

  // 新成片回到取景框：闪一下 + 浮出操作条；翻页状态归零
  const prevSrc = useRef(ctx.canvasSource)
  useEffect(() => {
    if (ctx.canvasSource && ctx.canvasSource !== prevSrc.current) {
      setVfIdx(null)
      setFlash(true)
      setActsOn(true)
      window.setTimeout(() => setFlash(false), 950)
      window.setTimeout(() => setActsOn(false), 6000)
    }
    prevSrc.current = ctx.canvasSource
  }, [ctx.canvasSource])

  // —— 取景框左右滑翻底片 ——
  const swipe = useRef({ x: 0, on: false })
  const onVfDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (busy) return
    swipe.current = { x: e.clientX, on: true }
  }
  const onVfUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!swipe.current.on) return
    swipe.current.on = false
    const dx = e.clientX - swipe.current.x
    if (Math.abs(dx) < 44 || !ctx.history.length) return
    setActsOn(false)
    if (dx > 0) {
      // 右滑 → 往新翻
      setVfIdx((i) => (i === null ? null : Math.max(0, i - 1)))
    } else {
      // 左滑 → 往旧翻；从最新进入时 0 是最新，下一张是 1
      setVfIdx((i) => (i === null ? Math.min(1, ctx.history.length - 1) : Math.min(ctx.history.length - 1, i + 1)))
    }
  }

  // —— 快门：轻点生成，长按连拍 ——
  const pressT = useRef(0)
  const burstStop = useRef(false)
  const runBurst = async () => {
    if (busyRef.current) return
    burstStop.current = false
    for (let i = 1; i <= BURST_MAX; i++) {
      if (burstStop.current) break
      setBurstShot(i)
      const p = ctx.runPrimary()
      if (!p) break // 校验没过（没 Key / 没参考），停下别空转
      await p
    }
    setBurstShot(0)
  }
  const onShutterDown = () => {
    if (busyRef.current) return
    window.clearTimeout(pressT.current)
    pressT.current = window.setTimeout(() => void runBurst(), 420)
  }
  const onShutterUp = () => {
    window.clearTimeout(pressT.current)
    if (busyRef.current || burstShot > 0) return
    void ctx.runPrimary()
  }
  useEffect(() => () => window.clearTimeout(pressT.current), [])

  const cancelAll = () => {
    burstStop.current = true
    ctx.cancelGenerate()
  }

  // —— 槽位面板的来源动作 ——
  const pendingSlot = useRef<RefKey>('photo')
  const galleryRef = useRef<HTMLInputElement>(null)
  const cameraRef = useRef<HTMLInputElement>(null)
  const openGallery = (k: RefKey) => {
    pendingSlot.current = k
    setSlotSheet(null)
    galleryRef.current?.click()
  }
  const openCamera = (k: RefKey) => {
    pendingSlot.current = k
    setSlotSheet(null)
    cameraRef.current?.click()
  }
  const onFilePicked = (e: React.ChangeEvent<HTMLInputElement>) => {
    ctx.pickFile(e.target.files?.[0], pendingSlot.current)
    e.currentTarget.value = ''
  }

  // —— 底片 → 设为参考 ——
  const pickHistory = async (item: HistoryItem) => {
    const slot = histOpen?.pick
    if (!slot) return
    setHistOpen(null)
    try {
      const uri = await invoke<string>('history_image', { id: item.id })
      ctx.setSlotImage(slot, uri)
    } catch {
      notify('读这张底片失败，换一张试试', 'err')
    }
  }

  // —— 存相册：安卓走 SAF（选 Pictures 目录进相册），桌面走原保存对话框 ——
  const saveGallery = async (src?: string) => {
    const target = src ?? ctx.canvasSource
    if (!target) return
    if (!IS_ANDROID) {
      ctx.saveImage(src)
      return
    }
    try {
      let dataUrl = target
      if (!dataUrl.startsWith('data:')) {
        dataUrl = await invoke<string>('image_data_uri', { url: dataUrl, kind: 'result' })
      }
      const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')
      const picked = await save({ title: '存成图', defaultPath: `ziran-${stamp}.png` })
      if (!picked) return
      await invoke('save_image_saf', { uri: picked, dataUrl })
      notify('已保存 · 存到 Pictures 就能在相册看到', 'ok')
    } catch (e) {
      notify(`保存失败：${e instanceof Error ? e.message : String(e)}`, 'err')
    }
  }

  // —— 分享：能拿系统分享就分享，拿不到就说明 ——
  const shareResult = async () => {
    try {
      let dataUrl = ctx.canvasSource
      if (!dataUrl) return
      if (!dataUrl.startsWith('data:')) {
        dataUrl = await invoke<string>('image_data_uri', { url: dataUrl, kind: 'result' })
      }
      const blob = await (await fetch(dataUrl)).blob()
      const file = new File([blob], 'ziran.png', { type: blob.type || 'image/png' })
      const nav = navigator as Navigator & { canShare?: (d: { files: File[] }) => boolean }
      if (typeof nav.share !== 'function' || !nav.canShare?.({ files: [file] })) {
        throw new Error('unsupported')
      }
      await nav.share({ files: [file], title: 'Ziran 成图' })
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') return
      notify('这部机型不支持直接分享，先存相册再转发', 'neutral')
    }
  }

  // 返回键：后开先关
  useBackClose(viewerItem !== null, () => setViewerItem(null))
  useBackClose(ctx.preview !== null, () => ctx.setPreview(null))
  useBackClose(slotSheet !== null, () => setSlotSheet(null))
  useBackClose(tplOpen !== null, () => setTplOpen(null))
  useBackClose(histOpen !== null, () => setHistOpen(null))
  useBackClose(setOpen, () => setSetOpen(false))
  useBackClose(provSheet, () => setProvSheet(false))
  useBackClose(ratioOpen, () => setRatioOpen(false))
  useBackClose(ctx.galleryOpen !== null, () => ctx.setGalleryOpen(null))

  const refCount = SLOT_KEYS.filter((k) => ctx.refs[k]).length
  const viewing = vfIdx !== null && ctx.history[vfIdx] !== undefined
  const showActs = actsOn && !busy && !viewing && Boolean(ctx.canvasSource)
  const combo =
    refCount === 0
      ? '还没放参考 · 放一个就能拍'
      : SLOT_KEYS.filter((k) => ctx.refs[k]).map((k) => REF_META[k].name).join(' + ')

  return (
    <div className="k-app">
      {/* 顶栏：模型芯片 + 设置 */}
      <header className="k-top">
        <button
          className="k-model"
          onClick={() => (ctx.hasKey ? setProvSheet(true) : ctx.openPanel())}
          aria-label={ctx.hasKey ? '切换模型' : '接入模型'}
        >
          <span className={`k-model-dot${ctx.hasKey ? ' on' : ''}`} />
          {ctx.hasKey ? (
            <>
              <span className="k-model-name">
                {ctx.activeProvider.label} · {ctx.effModel()}
              </span>
              <Icon name="chevron" size={11} />
            </>
          ) : (
            <span className="k-model-name">未接入 · 点此配置</span>
          )}
        </button>
        <button className="k-gear" onClick={() => setSetOpen(true)} aria-label="设置">
          <Icon name="settings" size={15} />
        </button>
      </header>

      {/* 取景框：最新成片 / 翻底片 / 生成中 / 空态 */}
      <div
        className="k-vf"
        onPointerDown={onVfDown}
        onPointerUp={onVfUp}
        onPointerCancel={() => (swipe.current.on = false)}
      >
        <div className="k-vf-media" style={{ aspectRatio: `${ratio.w} / ${ratio.h}` }}>
          {mediaBusy ? (
            <div className="k-vf-gen">
              <span className="k-spin k-spin-lg" />
              {busy && (
                <>
                  <b>生成中</b>
                  <span className="k-gen-sub">
                    {burstShot > 0 ? `连拍 ${burstShot} / ${BURST_MAX}` : '单张约 6–30 秒'}
                  </span>
                </>
              )}
            </div>
          ) : viewing ? (
            <div className="k-vf-hist">
              <HistoryThumb id={ctx.history[vfIdx].id} />
            </div>
          ) : ctx.canvasSource ? (
            <img className="k-vf-img" src={ctx.canvasSource} alt={ctx.canvasLabel} draggable={false} />
          ) : (
            <div className="k-vf-empty">
              {ctx.hasKey ? (
                <>
                  <Icon name="camera" size={32} />
                  <b>摆好参考，按下快门</b>
                  <span>
                    快门按下即 AI 出片 · 姿势 / 服装 / 人脸
                    <br />
                    叠上去一起出片
                  </span>
                </>
              ) : (
                <>
                  <Icon name="key" size={32} />
                  <b>先接入模型</b>
                  <span>填中转站地址和 Key，一次就好</span>
                  <button
                    className="k-vf-btn"
                    onClick={(e) => {
                      e.stopPropagation()
                      ctx.openPanel()
                    }}
                  >
                    接入模型
                  </button>
                </>
              )}
            </div>
          )}
        </div>

        {/* 取景框四角 */}
        {!mediaBusy && <span className="k-br k-br-tl" />}
        {!mediaBusy && <span className="k-br k-br-tr" />}
        {!mediaBusy && <span className="k-br k-br-bl" />}
        {!mediaBusy && <span className="k-br k-br-br" />}

        {/* AI 角标（生成中让位给取消） */}
        {busy ? (
          <button className="k-vf-cancel" onClick={cancelAll}>
            <Icon name="close" size={10} />
            取消
          </button>
        ) : (
          <span className="k-vf-ai">
            <b>AI</b> 生成
          </span>
        )}

        {/* 底片计数（翻页时显示） */}
        {viewing && (
          <button className="k-vf-count" onClick={() => setVfIdx(null)} aria-label="回到最新">
            {vfIdx + 1} / {ctx.history.length}
          </button>
        )}

        {/* 画幅角标 + 展开选择 */}
        {!busy && !ratioOpen && (
          <button className="k-vf-ratio" onClick={() => setRatioOpen(true)}>
            {ratio.label}
          </button>
        )}
        {!busy && !viewing && ctx.canvasSource && (
          <button
            className="k-vf-mark"
            onClick={ctx.saveCanvasTemplate}
            aria-label="存为模板"
            title="存为模板，之后可基于它再生成"
          >
            <Icon name="bookmark" size={13} />
          </button>
        )}
        {ratioOpen && (
          <div className="k-vf-ratios">
            {RATIOS.map((r) => (
              <button
                key={r.id}
                className={r.id === ctx.settings.ratio ? 'is-on' : ''}
                onClick={() => {
                  ctx.update({ ratio: r.id })
                  setRatioOpen(false)
                }}
              >
                {r.label}
              </button>
            ))}
          </div>
        )}

        {/* 出片闪光 + 操作条 */}
        {flash && <div className="k-vf-flash" />}
        {showActs && (
          <div className="k-vf-acts">
            <button className="is-hot" onClick={() => void saveGallery()}>
              <Icon name="download" size={11} />
              存相册
            </button>
            <button onClick={ctx.saveCanvasTemplate}>
              <Icon name="bookmark" size={11} />
              存模板
            </button>
            <button onClick={() => void shareResult()}>
              <Icon name="grid" size={11} />
              分享
            </button>
          </div>
        )}

        {/* 首启一次性提示 */}
        {tipOn && !busy && !actsOn && !flash && !ratioOpen && (
          <button className="k-tip" onClick={dismissTip}>
            按下快门 = AI 出片 · 点掉不再出现
          </button>
        )}
      </div>

      {/* 槽位排 */}
      <div className="k-slots">
        {SLOT_KEYS.map((k) => {
          const url = ctx.refs[k]
          const allEmpty = refCount === 0
          return (
            <button className="k-slot" key={k} onClick={() => setSlotSheet(k)} aria-label={REF_META[k].name}>
              {k === 'pose' && allEmpty && !busy && <span className="k-slot-lead">从这开始</span>}
              <span className={`k-orb${url ? ' is-filled' : ''}`}>
                {url ? <RefThumb url={url} kind={k} /> : <Icon name={SLOT_ICON[k]} size={16} />}
              </span>
              <i>{REF_META[k].name}</i>
            </button>
          )
        })}
      </div>

      {/* 配方条 */}
      <p className="k-combo">
        <span>{combo}</span>
      </p>

      {/* 描述 */}
      <div className={`k-prompt${ctx.prompt ? '' : ' is-empty'}`}>
        <textarea
          value={ctx.prompt}
          onChange={(e) => ctx.setPrompt(e.target.value)}
          placeholder="描述（可不填，默认沿用参考）"
          rows={2}
          aria-label="描述"
        />
      </div>

      {/* 底部坞：模板 | 快门 | 底片 */}
      <div className={`k-dock${busy ? ' is-dim' : ''}`}>
        <button
          className="k-dock-side is-tpl"
          onClick={() => setTplOpen({ slot: null })}
          disabled={busy}
          aria-label="模板库"
        >
          <Icon name="bookmark" size={15} />
          <i>模板</i>
        </button>

        <div className="k-shuttercol">
          <button
            className={`k-shutter${busy ? ' is-busy' : ''}`}
            onPointerDown={onShutterDown}
            onPointerUp={onShutterUp}
            onPointerLeave={() => window.clearTimeout(pressT.current)}
            onPointerCancel={() => window.clearTimeout(pressT.current)}
            onContextMenu={(e) => e.preventDefault()}
            aria-label={busy ? '生成中' : '生成'}
          >
            <i />
          </button>
          <i>{busy ? (burstShot > 0 ? `连拍 ${burstShot}/${BURST_MAX}` : '生成中') : '生成'}</i>
        </div>

        <button
          className="k-dock-side is-hist"
          onClick={() => setHistOpen({ pick: null })}
          disabled={busy}
          aria-label="底片"
        >
          <span className="k-dock-thumb">
            {ctx.history.length ? (
              <>
                <HistoryThumb id={ctx.history[0].id} />
                <span className="k-dock-cnt">{ctx.history.length}</span>
              </>
            ) : (
              <span className="k-dock-thumb-empty">
                <Icon name="grid" size={15} />
              </span>
            )}
          </span>
          <i>底片</i>
        </button>
      </div>

      {/* 隐藏文件输入：相册 / 相机（wry 的 onShowFileChooser 支持到系统选择器） */}
      <input ref={galleryRef} type="file" accept="image/*" hidden onChange={onFilePicked} />
      <input ref={cameraRef} type="file" accept="image/*" capture="environment" hidden onChange={onFilePicked} />

      {/* 轻提示 */}
      {toast && (
        <div className="k-toast" data-tone={toast.tone}>
          {toast.text}
        </div>
      )}

      {/* 槽位选源面板 */}
      {slotSheet && (
        <SlotSheet
          ctx={ctx}
          slot={slotSheet}
          onCatalog={(k) => {
            setSlotSheet(null)
            ctx.setGalleryOpen(k)
          }}
          onGallery={openGallery}
          onCamera={openCamera}
          onTemplates={(k) => {
            setSlotSheet(null)
            setTplOpen({ slot: k })
          }}
          onHistory={(k) => {
            setSlotSheet(null)
            setHistOpen({ pick: k })
          }}
          onClose={() => setSlotSheet(null)}
        />
      )}

      {/* 模型切换抽屉 */}
      {provSheet && (
        <ProviderSheet
          providers={ctx.providers}
          settings={ctx.settings}
          effModel={ctx.effModel}
          onPick={(value) => {
            ctx.update({ provider: value })
            setProvSheet(false)
          }}
          onManage={() => {
            setProvSheet(false)
            ctx.openPanel()
          }}
          onClose={() => setProvSheet(false)}
        />
      )}

      {/* 模板库整屏 */}
      {tplOpen && (
        <TemplatePanel ctx={ctx} presetSlot={tplOpen.slot} onClose={() => setTplOpen(null)} />
      )}

      {/* 底片整屏（pick 模式 = 给槽位选参考） */}
      {histOpen && (
        <HistoryPanel
          ctx={ctx}
          pickMode={histOpen.pick !== null}
          onPick={(h) => void pickHistory(h)}
          onOpen={setViewerItem}
          onClose={() => setHistOpen(null)}
        />
      )}

      {/* 设置整屏 */}
      {setOpen && <SettingsPanel ctx={ctx} onClose={() => setSetOpen(false)} />}

      {/* 底片回看 */}
      {viewerItem && (
        <WorksViewer
          item={viewerItem}
          providers={ctx.providers}
          onClose={() => setViewerItem(null)}
          onSave={(src) => void saveGallery(src)}
          onSaveTemplate={() => void ctx.saveTemplateFromHistory(viewerItem)}
          onDelete={(id) => {
            setViewerItem(null)
            ctx.deleteHistory(id)
          }}
        />
      )}
    </div>
  )
}
