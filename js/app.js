// app.js — Lume: visualizador DICOM/NIfTI 100% no navegador.
// Leitor DICOM e conversão reaproveitados do MorfoStudio/SegmentaRM
// (dcm2niix WASM); renderização com NiiVue (WebGL2).

import { Niivue, NVImage, DRAG_MODE } from '../vendor/niivue.min.js'
import { splitInput, convertDicom, makeEntry, filesFromDrop } from './ingest.js'
import { scanDicomSeries, directSeriesToNifti } from './dicom-scan.js'
import { makeThumb } from './thumbs.js'
import { slabProject, axisLabels } from './mip.js'
import { createRoiTool } from './roi.js'
import { bakeOblique } from './oblique.js'
import { CONVENCOES, bordasDaTela, planeFromAffine } from './orient.js'

const $ = (id) => document.getElementById(id)
const VERSION = '0.9.1'

const state = {
  nv: null,            // visualizador do painel principal (nº 1) — ROI, janela, slab, oblíquo
  panels: [],          // {nv, canvas, id: seriesId, view} — painéis de comparação (índice 0 = principal)
  syncPosition: true,
  syncZoom: true,
  layout: 1,           // nº de painéis visíveis (1–4)
  focus: 0,            // painel focado: recebe as trocas de corte e as séries clicadas
  series: [],          // SeriesEntry[]
  activeId: null,
  vol: null,           // NVImage base em exibição (original ou oblíquo)
  origVol: null,       // NVImage original da série ativa (p/ desfazer o oblíquo)
  roi: null,           // controlador de ROIs
  busy: false,         // reconstrução pesada em andamento (MIP/oblíquo)
  convencao: 'radiologica', // orientação de exibição (padrão de PACS)
  cache: new Map(),    // id → NVImage (limitado, para trocar de série sem reconverter)
  measures: [],
  mouse: null, // gestos do mouse → ação (carregado de MOUSE_DEFAULTS + localStorage)
}

/* ---------------- gestos do mouse (customizáveis) ---------------- */
// Ações: as nativas usam os modos de arrasto do NiiVue; as demais são emuladas
// pelo app (interceptadas antes do NiiVue). Medir/ângulo só existem no motor,
// portanto ficam restritas aos botões esquerdo/meio/direito e Ctrl/Shift+esq.
const ACTIONS = {
  browse:      { label: 'Percorrer cortes',            native: false, emul: true },
  windowing:   { label: 'Janela (brilho/contraste)',   native: true,  emul: true },
  zoom:        { label: 'Zoom',                        native: false, emul: true },
  pan:         { label: 'Mover (pan)',                 native: true,  emul: true },
  crosshair:   { label: 'Cursor / localizar',          native: true,  emul: false },
  measurement: { label: 'Medir distância',             native: true,  emul: false },
  angle:       { label: 'Medir ângulo',                native: true,  emul: false },
}
// gestos configuráveis; emulOnly = sem suporte nativo do NiiVue (só ações emuláveis)
const GESTURES = [
  { key: 'left',      label: 'Botão esquerdo + arrastar' },
  { key: 'middle',    label: 'Botão do meio + arrastar' },
  { key: 'right',     label: 'Botão direito + arrastar' },
  { key: 'back',      label: 'Botão “voltar” (4º) + arrastar',   emulOnly: true },
  { key: 'forward',   label: 'Botão “avançar” (5º) + arrastar',  emulOnly: true },
  { key: 'ctrlLeft',  label: 'Ctrl + botão esquerdo + arrastar' },
  { key: 'shiftLeft', label: 'Shift + botão esquerdo + arrastar' },
  { key: 'altLeft',   label: 'Alt + botão esquerdo + arrastar',  emulOnly: true },
]
// padrão estilo workstation: esquerdo percorre, meio janela, direito zoom,
// “voltar” move, Ctrl+esq janela, Shift+esq move
const MOUSE_DEFAULTS = {
  left: 'browse', middle: 'windowing', right: 'zoom',
  back: 'pan', forward: 'windowing',
  ctrlLeft: 'windowing', shiftLeft: 'pan', altLeft: 'zoom',
}
function loadMouse() {
  const m = { ...MOUSE_DEFAULTS }
  try {
    const saved = JSON.parse(localStorage.getItem('lume-mouse') || '{}')
    for (const g of GESTURES) {
      const a = saved[g.key]
      if (a in ACTIONS && (!g.emulOnly || ACTIONS[a].emul)) m[g.key] = a
    }
  } catch { /* configuração corrompida → padrões */ }
  return m
}
function saveMouse() {
  try { localStorage.setItem('lume-mouse', JSON.stringify(state.mouse)) } catch { /* sem storage */ }
}
state.mouse = loadMouse()

/* ---------------- utilidades de interface ---------------- */
function log(msg) { $('statusMsg').textContent = msg }
function progress(p) {
  const bar = $('progress')
  bar.hidden = !(p > 0 && p < 1)
  $('progressFill').style.width = `${Math.round(p * 100)}%`
}
const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const fmt = (n, d = 1) => Number(n).toLocaleString('pt-BR', { maximumFractionDigits: d })

/** Traz um painel do inspetor à vista e o destaca — o resultado de uma
 *  ação nunca deve aparecer fora da área visível. */
function flashPanel(id) {
  const el = $(id)
  if (!el) return
  el.scrollIntoView({ block: 'nearest' })
  el.classList.remove('flash')
  void el.offsetWidth // reinicia a animação
  el.classList.add('flash')
  setTimeout(() => el.classList.remove('flash'), 1000)
}

/* ---------------- visualizador ---------------- */
async function initViewer() {
  const nv = new Niivue({
    backColor: [0, 0, 0, 1],
    crosshairColor: [0.95, 0.71, 0.25, 0.9], // âmbar do negatoscópio
    show3Dcrosshair: true,
    dragAndDropEnabled: false, // o drop é tratado pelo app (aceita pastas e ZIP)
    multiplanarForceRender: false,
  })
  await nv.attachToCanvas($('gl'))
  nv.setSliceType(nv.sliceTypeMultiplanar)
  nv.opts.yoke3Dto2DZoom = true

  nv.onIntensityChange = () => syncWindowInputs()
  state.nv = nv
  await ensurePanel(0) // registra o visualizador como painel principal
}

/* ---------------- orientação clínica ---------------- */
// A convenção de exibição vale para TODOS os painéis. Radiológica (padrão de
// PACS): a esquerda do paciente aparece à direita da tela em axial e coronal;
// o sagital é idêntico nas duas convenções. A orientação vem sempre da matriz
// afim do volume (LPS→RAS), nunca do nome da série ou da ordem dos arquivos.
function applyOrientation(nv) {
  const c = CONVENCOES[state.convencao] || CONVENCOES.radiologica
  nv.opts.isRadiologicalConvention = c.isRadiologicalConvention
  nv.opts.sagittalNoseLeft = true          // sagital visto pelo lado esquerdo: nariz à esquerda
  nv.opts.showAllOrientationMarkers = true // as quatro bordas, não só duas
  nv.opts.isOrientationTextVisible = true
  nv.opts.fontColor = [1, 0.86, 0.55, 1]   // âmbar claro: legível sobre osso e ar
  nv.opts.textHeight = 0.06                // letras de borda bem legíveis
  nv.opts.isCornerOrientationText = false
}

/** Troca a convenção em todos os painéis e avisa de forma inequívoca. */
function setConvencao(nome, silencioso = false) {
  if (!CONVENCOES[nome]) return
  state.convencao = nome
  try { localStorage.setItem('lume-convencao', nome) } catch { /* sem storage */ }
  for (const p of state.panels.filter(Boolean)) { applyOrientation(p.nv); p.nv.drawScene() }
  renderOrientBadge()
  if (!silencioso) {
    const c = CONVENCOES[nome]
    log(`Orientação ${c.label}: ${c.hint}.`)
  }
}

/** Selo permanente com a lateralidade — nunca deixar dúvida sobre R/L. */
function renderOrientBadge() {
  const el = $('orientBadge')
  if (!el) return
  const rad = CONVENCOES[state.convencao].isRadiologicalConvention
  const [esq, dir] = bordasDaTela('axial', rad)
  el.innerHTML = `<span class="ob-side">${esq}</span>` +
    `<span class="ob-mid">${CONVENCOES[state.convencao].label}</span>` +
    `<span class="ob-side">${dir}</span>`
  el.title = `${CONVENCOES[state.convencao].label} — ${CONVENCOES[state.convencao].hint}. ` +
    `Em axial e coronal, ${esq} fica à esquerda da tela e ${dir} à direita; o sagital é igual nas duas convenções.`
  el.dataset.conv = state.convencao
}

/* ---------------- medidas: distância e ângulo ---------------- */
// Traço e rótulo em âmbar (o vermelho padrão do NiiVue some sobre imagem
// clara) e texto maior — a medida precisa ser legível à distância da tela.
function styleMeasurements(nv) {
  nv.opts.rulerColor = [0.31, 0.85, 0.92, 0.95] // corpo do traço (ciano: contrasta com o cursor âmbar)
  nv.opts.rulerWidth = 3
  nv.opts.measureLineColor = [0.98, 0.9, 0.6, 1]  // marcas das extremidades
  nv.opts.measureTextColor = [0.99, 0.93, 0.75, 1]
  nv.opts.measureTextHeight = 0.095               // rótulo ~1,6× o padrão (o NiiVue escala por /0.06)
}

/** Registra medidas (distância e ângulo) feitas em qualquer painel. */
function installMeasureCallbacks(panel, i) {
  const nv = panel.nv
  panel.canvas.addEventListener('pointerdown', (e) => { state.lastGesture = gestureOf(e) }, true)
  // a coordenada na barra de status vem do painel que o usuário está usando
  nv.onLocationChange = (d) => { if (state.focus === i) $('statusLoc').textContent = d?.string || '' }
  nv.onDragRelease = (p) => {
    if (state.mouse[state.lastGesture] === 'measurement' && p?.mmLength > 0.5) {
      state.measures.push({ kind: 'dist', value: p.mmLength, panel: i })
      renderMeasures()
      flashPanel('panelMeasures')
      log(`Distância: ${fmt(p.mmLength, 1)} mm.`)
    }
  }
  nv.onAngleCompleted = (a) => {
    if (!(a?.angle >= 0)) return
    state.measures.push({ kind: 'angle', value: a.angle, panel: i })
    renderMeasures()
    flashPanel('panelMeasures')
    log(`Ângulo: ${fmt(a.angle, 1)}°. Arraste um novo traço para medir outro.`)
  }
}

/** Estado do ângulo → instrução na barra de status (fluxo de dois passos). */
function angleHint(panel) {
  if (state.mouse[state.lastGesture] !== 'angle') return
  const s = panel.nv.uiData?.angleState
  if (s === 'drawing_first_line') log('Ângulo: arraste o primeiro traço (o vértice fica no fim dele).')
  else if (s === 'drawing_second_line') log('Ângulo: mova o mouse e clique para fechar o ângulo (Esc cancela).')
}

/** Cancela um ângulo em andamento em todos os painéis. */
function cancelPendingAngle(quiet = false) {
  let had = false
  for (const p of state.panels.filter(Boolean)) {
    const u = p.nv.uiData
    if (!u || u.angleState === 'none') continue
    if (u.angleState === 'drawing_first_line' || u.angleState === 'drawing_second_line') had = true
    p.nv.resetAngleMeasurement?.()
    u.isDragging = false
    p.nv.clearActiveDragMode?.()
    p.nv.drawScene()
  }
  if (had && !quiet) log('Ângulo cancelado.')
  return had
}

/* ---------------- comparação em 1–4 painéis sincronizados ---------------- */
// Cada painel tem série e orientação próprias (ex.: coluna em axial, sagital e
// coronal ao mesmo tempo); o cursor/scroll é sincronizado em mm entre todos,
// o que localiza a mesma lesão tridimensionalmente em todos os painéis.
const PANEL_CANVAS = ['gl', 'gl2', 'gl3', 'gl4']
const DEFAULT_VIEWS = ['mpr', 'sagittal', 'coronal', 'axial'] // padrão ao abrir cada painel

const pendingPanels = new Map()
async function ensurePanel(i) {
  if (state.panels[i]) return state.panels[i]
  if (!pendingPanels.has(i)) pendingPanels.set(i, createPanel(i).finally(() => pendingPanels.delete(i)))
  return pendingPanels.get(i)
}

async function createPanel(i) {
  const canvas = $(PANEL_CANVAS[i])
  let nv
  if (i === 0) {
    nv = state.nv // o painel principal é o visualizador já criado
  } else {
    nv = new Niivue({
      backColor: [0, 0, 0, 1],
      crosshairColor: [0.31, 0.7, 0.75, 0.9], // teal nos painéis de comparação
      show3Dcrosshair: true,
      dragAndDropEnabled: false,
      multiplanarForceRender: false,
    })
    await nv.attachToCanvas(canvas)
    nv.opts.yoke3Dto2DZoom = true
  }
  canvas.hidden = i >= state.layout
  canvas.style.display = i >= state.layout ? 'none' : 'block'
  styleMeasurements(nv)
  applyOrientation(nv)
  const panel = { nv, canvas, id: null, view: DEFAULT_VIEWS[i], loadSeq: 0, loading: false }
  state.panels[i] = panel
  canvas.addEventListener('pointerdown', () => focusPanel(i, true), true)
  installMeasureCallbacks(panel, i)
  installPanelGestures(panel, i)
  // o NiiVue muda o estado do ângulo depois dos nossos handlers: consulta no fim do turno
  const hint = () => setTimeout(() => angleHint(panel), 0)
  canvas.addEventListener('pointerup', hint)
  canvas.addEventListener('pointerdown', hint)
  applyMouseConfig()
  rewireSync()
  return panel
}

// religa a sincronização bidirecional (cursor em mm, pan/zoom, câmera 3D)
// entre todos os painéis visíveis; a orientação de corte NÃO é sincronizada.
function rewireSync() {
  const active = state.panels.slice(0, state.layout).filter((p) => p && !p.loading && p.nv.volumes.length)
  for (const p of state.panels.filter(Boolean)) {
    const others = active.includes(p) ? active.filter((q) => q !== p).map((q) => q.nv) : []
    p.nv.broadcastTo(others, { crosshair: state.syncPosition, zoomPan: state.syncZoom, '3d': state.syncZoom })
  }
}

function applyPanelView(panel) {
  const nv = panel.nv
  const t = {
    mpr: nv.sliceTypeMultiplanar, axial: nv.sliceTypeAxial,
    coronal: nv.sliceTypeCoronal, sagittal: nv.sliceTypeSagittal, render: nv.sliceTypeRender,
  }[panel.view]
  nv.setSliceType(t)
}

let layoutSeq = 0
async function setLayout(n) {
  const seq = ++layoutSeq
  n = Math.max(1, Math.min(4, n))
  state.layout = n
  $('stage').className = `stage layout-${n}`
  document.querySelectorAll('.tool[data-layout]').forEach((b) =>
    b.classList.toggle('active', Number(b.dataset.layout) === n))
  for (let i = 0; i < 4; i++) {
    const c = $(PANEL_CANVAS[i])
    c.hidden = i >= n
    // o attachToCanvas do NiiVue define style inline no canvas; o inline vence a folha,
    // então o display precisa ser gerido aqui também
    c.style.display = i >= n ? 'none' : 'block'
  }
  rewireSync()
  // painéis que saíram de cena liberam o volume (memória de CPU e GPU)
  for (let i = n; i < 4; i++) {
    const p = state.panels[i]
    if (!p) continue
    p.loadSeq++ // invalida também uma abertura que ainda não chegou à GPU
    p.loading = false
    while (p.nv.volumes.length) p.nv.removeVolume(p.nv.volumes[0])
    p.id = null
  }
  for (let i = 0; i < n; i++) {
    const panel = await ensurePanel(i)
    if (seq !== layoutSeq) return
    // painel aberto (ou reaberto) sem série: recebe a ativa na orientação padrão
    if (i > 0 && state.activeId && !panel.id) {
      applyPanelView(panel)
      await loadIntoPanel(i, state.activeId)
      if (seq !== layoutSeq) return
    }
  }
  if (state.focus >= n) focusPanel(0)
  rewireSync()
  requestAnimationFrame(() => {
    for (const p of state.panels.slice(0, n)) { try { p?.nv.drawScene() } catch { /* sem tamanho ainda */ } }
  })
  markActiveThumbs()
  if (n > 1) log(`${n} painéis — clique num painel para focá-lo; miniatura carrega no focado; Ax/Cor/Sag muda o corte do focado.`)
}

function focusPanel(i, focusCanvas = false) {
  if (i >= state.layout || !state.panels[i]) return
  state.focus = i
  if (focusCanvas) state.panels[i].canvas.focus({ preventScroll: true })
  document.querySelectorAll('.stage canvas').forEach((c, k) => c.classList.toggle('focused', PANEL_CANVAS[i] === c.id && state.layout > 1))
  const view = state.panels[i].view
  document.querySelectorAll('.tool[data-view]').forEach((b) =>
    b.classList.toggle('active', b.dataset.view === view))
  $('panel3d').hidden = view !== 'render'
}

/** Carrega uma série num painel de comparação (índice ≥ 1). */
async function loadIntoPanel(i, id) {
  const entry = state.series.find((s) => s.id === id)
  const panel = state.panels[i]
  if (!entry || !panel || i === 0) return
  const seq = ++panel.loadSeq
  log(`Painel ${i + 1}: abrindo ${entry.file.name}…`); progress(0.3)
  try {
    let vol = await volumeFor(entry)
    if (seq !== panel.loadSeq || i >= state.layout) return
    const position = positionForLoad(panel)
    panel.loading = true
    rewireSync()
    // NVImage já exibido em outro painel: clona para não compartilhar entre contextos GL
    if (state.panels.some((p) => p && p.nv.volumes.includes(vol))) vol = vol.clone()
    const nv = panel.nv
    while (nv.volumes.length) nv.removeVolume(nv.volumes[0])
    nv.addVolume(vol)
    panel.id = id
    const v = nv.volumes[0]
    if (entry.sidecar.Modality === 'CT') { v.cal_min = 0; v.cal_max = 80 }
    else { v.cal_min = v.robust_min ?? v.global_min; v.cal_max = v.robust_max ?? v.global_max }
    nv.updateGLVolume()
    applyPanelView(panel)
    restorePosition(panel, position)
    nv.drawScene()
    markActiveThumbs()
    progress(0)
    log(`Painel ${i + 1}: ${entry.file.name} (${panel.view}) — ${state.syncPosition ? 'posição vinculada em mm' : 'posição independente'}.`)
  } catch (err) {
    if (seq !== panel.loadSeq) return
    console.error(err); progress(0)
    log('Falha ao abrir no painel: ' + err.message)
  } finally {
    if (seq === panel.loadSeq) { panel.loading = false; rewireSync() }
  }
}

// clique direito na miniatura: manda a série para o painel focado (ou o 2º)
async function compareSeries(id) {
  if (state.layout < 2) await setLayout(2)
  const target = state.focus > 0 ? state.focus : 1
  await loadIntoPanel(target, id)
}

function markActiveThumbs() {
  const cmpIds = new Set(state.panels.slice(1, state.layout).map((p) => p?.id).filter(Boolean))
  document.querySelectorAll('.thumb').forEach((t) => {
    t.classList.toggle('active', t.id === `th-${state.activeId}`)
    t.classList.toggle('active-cmp', cmpIds.has(t.id.replace(/^th-/, '')))
  })
}

/* ---------------- gestos por painel: interceptação e emulação ---------------- */
function gestureOf(e) {
  if (e.button === 0) {
    if (e.ctrlKey) return 'ctrlLeft'
    if (e.shiftKey) return 'shiftLeft'
    if (e.altKey) return 'altLeft'
    return 'left'
  }
  return { 1: 'middle', 2: 'right', 3: 'back', 4: 'forward' }[e.button] || null
}

const VIEW_AXIS = { axial: 2, coronal: 1, sagittal: 0, mpr: 2 } // componente frac RAS do corte

// Preserva a localização física, não o índice do corte, entre matrizes diferentes.
function positionForLoad(panel) {
  const focused = state.panels[state.focus]
  const src = state.syncPosition && focused?.nv.volumes.length ? focused
    : panel.nv.volumes.length ? panel
    : state.syncPosition ? state.panels.find((p, i) => i < state.layout && p?.nv.volumes.length) : null
  return src ? Array.from(src.nv.frac2mm(src.nv.scene.crosshairPos)).slice(0, 3) : null
}

function restorePosition(panel, mm) {
  if (!mm || !mm.every(Number.isFinite)) return
  const frac = panel.nv.mm2frac(mm)
  if (Array.from(frac).every(Number.isFinite)) panel.nv.scene.crosshairPos = frac
}

// Não limita a posição ao FOV: isso indicaria uma estrutura diferente como correspondente.
function propagateCrosshair(from) {
  if (!from.nv.volumes.length) return
  if (state.syncPosition) {
    const mm = Array.from(from.nv.frac2mm(from.nv.scene.crosshairPos)).slice(0, 3)
    for (const p of state.panels.slice(0, state.layout)) {
      if (!p || p === from || p.loading || !p.nv.volumes.length) continue
      restorePosition(p, mm)
      p.nv.drawScene()
      p.nv.createOnLocationChange?.()
    }
  }
  from.nv.createOnLocationChange?.()
}

function stepSlice(panel, dir, axis = VIEW_AXIS[panel.view]) {
  const vol = panel.nv.volumes[0]
  if (axis === undefined || !vol) return
  const dim = vol.dimsRAS?.[axis + 1] || vol.hdr.dims[axis + 1] || 1
  const f = panel.nv.scene.crosshairPos.slice()
  f[axis] = Math.min(1 - 0.5 / dim, Math.max(0.5 / dim, f[axis] + dir / dim))
  panel.nv.scene.crosshairPos = f
  panel.nv.drawScene()
  propagateCrosshair(panel)
}

function zoomPanel(panel, factor) {
  const nv = panel.nv
  if (panel.view === 'render') {
    nv.scene.volScaleMultiplier = Math.min(8, Math.max(0.2, nv.scene.volScaleMultiplier * factor))
  } else {
    // ancora o zoom no cursor (mesma correção de pan que o NiiVue aplica),
    // senão a estrutura sob o cursor foge da tela ao ampliar
    const p = nv.scene.pan2Dxyzmm
    const newZoom = Math.min(16, Math.max(0.2, p[3] * factor))
    const zoomChange = p[3] - newZoom
    const mm = nv.frac2mm(nv.scene.crosshairPos)
    p[3] = newZoom
    p[0] += zoomChange * mm[0]
    p[1] += zoomChange * mm[1]
    p[2] += zoomChange * mm[2]
    nv.scene.pan2Dxyzmm = p
    if (nv.opts.yoke3Dto2DZoom) nv.scene.volScaleMultiplier = newZoom
  }
  nv.drawScene()
}

function windowPanel(panel, dx, dy) {
  const v = panel.nv.volumes[0]
  if (!v) return
  const range = Math.max(1e-6, (v.global_max ?? 1) - (v.global_min ?? 0)) / 250 // por pixel
  let wl = (v.cal_min + v.cal_max) / 2 + dy * range
  let ww = Math.max(range, v.cal_max - v.cal_min + dx * range * 2)
  v.cal_min = wl - ww / 2; v.cal_max = wl + ww / 2
  panel.nv.updateGLVolume()
  if (panel === state.panels[0]) syncWindowInputs()
}

function panMmPerPx(panel) {
  for (const s of panel.nv.screenSlices) {
    if (s.axCorSag <= 2 && s.fovMM?.[0] && s.leftTopWidthHeight?.[2]) {
      return s.fovMM[0] / Math.abs(s.leftTopWidthHeight[2])
    }
  }
  return 0.5
}

// eixos anatômicos de cada plano: [eixo horizontal, eixo vertical] do tile
const PLANE_AXES = { 0: [0, 1], 1: [0, 2], 2: [1, 2] } // axial · coronal · sagital
function panPanel(panel, dx, dy, scale, acs = 0) {
  const [hx, vy] = PLANE_AXES[acs] || PLANE_AXES[0]
  const p = panel.nv.scene.pan2Dxyzmm
  p[hx] += dx * scale
  p[vy] -= dy * scale // a tela cresce para baixo; os eixos anatômicos, para cima
  panel.nv.scene.pan2Dxyzmm = p
  panel.nv.drawScene()
}

function installPanelGestures(panel, idx) {
  const canvas = panel.canvas
  const dpr = () => canvas.width / (canvas.clientWidth || 1)
  let drag = null

  // intercepta os gestos que o NiiVue não cobre (browse/zoom, Alt, botões 4/5)
  canvas.addEventListener('pointerdown', (e) => {
    // ROI armada tem prioridade sobre o botão esquerdo no painel principal
    if (idx === 0 && e.button === 0 && state.roi?.armed) return
    const g = gestureOf(e)
    if (!g) return
    const act = state.mouse[g]
    const needsEmul = e.button >= 3 || g === 'altLeft' || !ACTIONS[act]?.native
    if (!needsEmul) return
    if (!ACTIONS[act]?.emul) { e.preventDefault(); return } // bloqueia navegação do browser
    if (panel.view === 'render' && (act === 'browse' || act === 'pan')) {
      if (e.button === 0 && g === 'left') return // 3D: arrasto esquerdo gira o volume (padrão)
    }
    e.preventDefault(); e.stopImmediatePropagation()
    canvas.setPointerCapture(e.pointerId)
    // o plano do tile onde o arrasto começou define os eixos do pan (no MPR
    // cada tile tem orientação própria)
    const r = canvas.getBoundingClientRect()
    const tile = panel.nv.tileIndex((e.clientX - r.left) * dpr(), (e.clientY - r.top) * dpr())
    const acs = panel.nv.screenSlices?.[tile]?.axCorSag
    drag = {
      act, x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, moved: false, acc: 0,
      acs: acs >= 0 && acs <= 2 ? acs : 0,
      mmpp: act === 'pan' ? panMmPerPx(panel) : 0,
    }
  }, true)

  canvas.addEventListener('pointermove', (e) => {
    if (!drag) return
    e.preventDefault(); e.stopImmediatePropagation()
    const dx = (e.clientX - drag.x) * dpr(), dy = (e.clientY - drag.y) * dpr()
    drag.x = e.clientX; drag.y = e.clientY
    if (Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) > 3) drag.moved = true
    if (drag.act === 'browse') {
      drag.acc += dy
      const step = 5 * dpr()
      while (drag.acc >= step) { stepSlice(panel, -1, [2, 1, 0][drag.acs]); drag.acc -= step }
      while (drag.acc <= -step) { stepSlice(panel, 1, [2, 1, 0][drag.acs]); drag.acc += step }
    } else if (drag.act === 'zoom') zoomPanel(panel, Math.exp(-dy * 0.004))
    else if (drag.act === 'windowing') windowPanel(panel, dx, dy)
    else if (drag.act === 'pan') panPanel(panel, dx, dy, drag.mmpp, drag.acs)
  }, true)

  const finish = (e) => {
    if (!drag) return
    e.preventDefault(); e.stopImmediatePropagation()
    // clique sem arrasto com “percorrer cortes”: posiciona o cursor (localiza)
    if (!drag.moved && drag.act === 'browse') {
      const r = canvas.getBoundingClientRect()
      const frac = panel.nv.canvasPos2frac([(e.clientX - r.left) * dpr(), (e.clientY - r.top) * dpr()])
      if (frac && frac[0] >= 0) { panel.nv.scene.crosshairPos = frac; panel.nv.drawScene(); propagateCrosshair(panel) }
    }
    drag = null
  }
  canvas.addEventListener('pointerup', finish, true)
  canvas.addEventListener('pointercancel', () => { drag = null }, true)
  // impede voltar/avançar do navegador e o menu de contexto quando o direito é custom
  canvas.addEventListener('auxclick', (e) => { if (e.button >= 3 || e.button === 1) e.preventDefault() })
  canvas.addEventListener('contextmenu', (e) => e.preventDefault())

  // roda: vertical percorre cortes (NiiVue, por painel); Ctrl+roda = zoom;
  // roda horizontal = série anterior/seguinte
  let wheelLock = 0
  canvas.addEventListener('wheel', (e) => {
    focusPanel(idx, true)
    if (e.ctrlKey) {
      e.preventDefault(); e.stopImmediatePropagation()
      zoomPanel(panel, Math.exp(-Math.sign(e.deltaY) * 0.12))
      return
    }
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY) && Math.abs(e.deltaX) > 4) {
      e.preventDefault(); e.stopImmediatePropagation()
      const now = Date.now()
      if (now - wheelLock < 250 || state.series.length < 2) return
      wheelLock = now
      const cur = idx === 0 ? state.activeId : panel.id
      const at = state.series.findIndex((s) => s.id === cur)
      const next = state.series[(at + (e.deltaX > 0 ? 1 : -1) + state.series.length) % state.series.length]
      if (idx === 0) openSeries(next.id)
      else loadIntoPanel(idx, next.id)
    }
  }, { capture: true, passive: false })
}

/* ---------------- barra de cortes por painel ---------------- */
function buildSliceBars() {
  const stage = $('stage')
  state.sliceBars = PANEL_CANVAS.map((_, i) => {
    const wrap = document.createElement('div')
    wrap.className = 'slice-ctl'
    wrap.hidden = true
    wrap.innerHTML = '<input type="range" min="0" max="1" step="1" value="0" title="Percorrer cortes deste painel" /><span class="mono"></span>'
    stage.appendChild(wrap)
    const input = wrap.querySelector('input')
    let held = false
    input.addEventListener('pointerdown', () => { held = true; focusPanel(i) })
    input.addEventListener('pointercancel', () => { held = false })
    window.addEventListener('pointerup', () => { held = false })
    input.addEventListener('input', () => {
      focusPanel(i)
      // Evita que outro canvas focado retransmita uma posição antiga.
      input.focus({ preventScroll: true })
      const panel = state.panels[i]
      const axis = VIEW_AXIS[panel?.view]
      const vol = panel?.nv.volumes[0]
      if (!vol || axis === undefined) return
      const dim = vol.dimsRAS?.[axis + 1] || vol.hdr.dims[axis + 1] || 1
      const f = panel.nv.scene.crosshairPos.slice()
      f[axis] = (Number(input.value) + 0.5) / dim
      panel.nv.scene.crosshairPos = f
      panel.nv.drawScene()
      propagateCrosshair(panel)
    })
    return { wrap, input, label: wrap.querySelector('span'), isHeld: () => held }
  })
  const stageR = () => stage.getBoundingClientRect()
  function tick() {
    for (let i = 0; i < 4; i++) {
      const bar = state.sliceBars[i]
      const panel = state.panels[i]
      const show = i < state.layout && panel && panel.nv.volumes.length > 0 && VIEW_AXIS[panel.view] !== undefined
      bar.wrap.hidden = !show
      if (!show) continue
      const r = panel.canvas.getBoundingClientRect(), sr = stageR()
      Object.assign(bar.wrap.style, {
        left: `${r.right - sr.left - 22}px`, top: `${r.top - sr.top + 8}px`, height: `${Math.max(60, r.height - 40)}px`,
      })
      const axis = VIEW_AXIS[panel.view]
      const vol = panel.nv.volumes[0]
      const dim = vol.dimsRAS?.[axis + 1] || vol.hdr.dims[axis + 1] || 1
      const vox = Math.min(dim - 1, Math.max(0, Math.round(panel.nv.scene.crosshairPos[axis] * dim - 0.5)))
      bar.input.max = dim - 1
      if (!bar.isHeld()) bar.input.value = vox
      const outside = Array.from(panel.nv.scene.crosshairPos).some((v) => !Number.isFinite(v) || v < 0 || v > 1)
      bar.label.textContent = outside ? 'Fora do FOV' : `${vox + 1}/${dim}`
      bar.input.title = outside ? 'A posição vinculada está fora da cobertura desta série' : 'Percorrer cortes deste painel'
    }
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}

/** Abre uma série num painel novo (Ctrl+clique na miniatura). */
async function openInNewPanel(id) {
  if (state.layout < 4) {
    const n = state.layout + 1
    await setLayout(n)
    // setLayout já povoa o painel novo com a série ativa; só recarrega se for outra
    if (state.panels[n - 1]?.id !== id) await loadIntoPanel(n - 1, id)
    focusPanel(n - 1)
  } else {
    const t = state.focus > 0 ? state.focus : 1
    await loadIntoPanel(t, id)
  }
}

const TOOL_MODES = {
  crosshair: DRAG_MODE.crosshair,
  windowing: DRAG_MODE.windowing,
  measurement: DRAG_MODE.measurement,
  angle: DRAG_MODE.angle,
  pan: DRAG_MODE.pan,
}
const MOUSE_LABEL = { left: 'E', right: 'D', middle: 'M' } // esquerdo · direito · meio

/** Associa uma ação a um gesto do mouse (validando o que o gesto suporta). */
function assignTool(gesture, action) {
  const g = GESTURES.find((x) => x.key === gesture)
  if (!g || !(action in ACTIONS)) return
  if (g.emulOnly && !ACTIONS[action].emul) { log(`${ACTIONS[action].label} não é possível nesse botão.`); return }
  // um ângulo pela metade não pode sobreviver à troca de ferramenta:
  // o próximo arrasto fecharia o ângulo antigo em vez de começar um novo
  cancelPendingAngle(true)
  state.mouse[gesture] = action
  applyMouseConfig()
  const names = { left: 'esquerdo', right: 'direito', middle: 'do meio' }
  if (action === 'angle' && gesture === 'left') {
    log('Ângulo: arraste o primeiro traço; solte, mova o mouse e clique para fechar (Esc cancela).')
  } else if (action === 'measurement' && gesture === 'left') {
    log('Medir: arraste sobre a imagem — o valor entra no painel Medidas.')
  } else if (names[gesture]) {
    log(`${ACTIONS[action].label} no botão ${names[gesture]} do mouse.`)
  }
}

function applyMouseConfig() {
  const m = state.mouse
  // gesto custom (browse/zoom) é interceptado antes do NiiVue; para o motor,
  // cai em crosshair — que no painel 3D preserva a rotação padrão por arrasto
  const nvMode = (a) => (ACTIONS[a]?.native ? TOOL_MODES[a] : DRAG_MODE.crosshair)
  // opts.dragMode é só o fallback (mouseEventConfig manda), mas o NiiVue o
  // consulta em dois pontos: com 'pan' a roda vira zoom, e o ângulo depende
  // dele para preservar o vértice do segundo traço
  const usaAngulo = Object.values(m).includes('angle')
  const fallback = usaAngulo ? DRAG_MODE.angle
    : m.right === 'pan' ? DRAG_MODE.crosshair
      : nvMode(m.right)
  for (const nv of state.panels.filter(Boolean).map((p) => p.nv)) {
    nv.opts.dragModePrimary = nvMode(m.left)
    nv.opts.dragMode = fallback
    nv.opts.mouseEventConfig = {
      leftButton: {
        primary: nvMode(m.left),
        withCtrl: ACTIONS[m.ctrlLeft]?.native ? TOOL_MODES[m.ctrlLeft] : undefined,
        withShift: ACTIONS[m.shiftLeft]?.native ? TOOL_MODES[m.shiftLeft] : undefined,
      },
      rightButton: nvMode(m.right),
      centerButton: nvMode(m.middle),
    }
  }
  document.querySelectorAll('.tool[data-tool]').forEach((b) => {
    const letters = ['left', 'right', 'middle']
      .filter((k) => state.mouse[k] === b.dataset.tool)
      .map((k) => MOUSE_LABEL[k])
    let chip = b.querySelector('.mb')
    if (!chip) { chip = document.createElement('span'); chip.className = 'mb'; b.appendChild(chip) }
    chip.textContent = letters.join('·')
    chip.hidden = !letters.length
    b.classList.toggle('active', letters.length > 0)
  })
  // espelha nos seletores do diálogo de atalhos, se já montado
  document.querySelectorAll('#dlgHelp select[data-gesture]').forEach((s) => { s.value = state.mouse[s.dataset.gesture] })
  saveMouse()
}

function setView(view) {
  // a orientação vale para o painel focado — os demais mantêm o corte próprio
  const panel = state.panels[state.focus]
  if (!panel) return
  panel.view = view
  applyPanelView(panel)
  $('panel3d').hidden = view !== 'render'
  if (view === 'render' && state.focus === 0) applyIllumination()
  document.querySelectorAll('.tool[data-view]').forEach((b) =>
    b.classList.toggle('active', b.dataset.view === view))
}

/* ---------------- janela ---------------- */
// A janela age no painel focado — é o painel que o usuário está lendo.
function focusedNv() { return (state.panels[state.focus] || state.panels[0])?.nv || state.nv }
function displayedVol() { return focusedNv().volumes[0] || null }

function syncWindowInputs() {
  const v = displayedVol()
  if (!v) return
  const wl = (v.cal_min + v.cal_max) / 2
  const ww = v.cal_max - v.cal_min
  $('wl').value = Math.round(wl)
  $('ww').value = Math.round(ww)
}

function applyWindow(wl, ww) {
  const v = displayedVol()
  if (!v || !(ww > 0)) return
  v.cal_min = wl - ww / 2
  v.cal_max = wl + ww / 2
  focusedNv().updateGLVolume()
  syncWindowInputs()
}

function autoWindow() {
  const v = displayedVol()
  if (!v) return
  v.cal_min = v.robust_min ?? v.global_min
  v.cal_max = v.robust_max ?? v.global_max
  focusedNv().updateGLVolume()
  syncWindowInputs()
}

/* ---------------- séries ---------------- */
/**
 * Ponderação/sequência aproximada da série, a partir do sidecar do dcm2niix
 * (descrição, sequência e, na falta de texto, TR/TE/TI) — para a legenda
 * sobreposta à miniatura. Heurística: informativa, não diagnóstica.
 */
function inferSequence(sc, filename = '') {
  const txt = [sc.SeriesDescription, sc.ProtocolName, sc.SequenceName, sc.PulseSequenceDetails, filename]
    .filter(Boolean).join(' ').toUpperCase()
    .replace(/\.NII(\.GZ)?$/, '').replace(/[_.\-]+/g, ' ') // separadores viram espaço p/ os \b
  const contrast = Boolean(sc.ContrastBolusAgent) || /GADO|\bGD\b|\+\s*C\b|POS.?CONTRASTE|POST.?CONTRAST/.test(txt)
  const tag = (s) => (contrast ? `${s} +C` : s)
  if ((sc.Modality || '') === 'CT') return tag('TC')

  if (/LOCALIZER|SCOUT|SURVEY|3.?PLANE/.test(txt)) return 'Localizador'
  if (/\bADC\b|APPARENT/.test(txt)) return 'ADC'
  if (/DTI|TENSOR|FA\b.*MAP|TRACTO/.test(txt)) return 'DTI'
  if (/DWI|DIFF|TRACE|\bB0\b|B[- ]?1000/.test(txt)) return 'DWI'
  if (/FLAIR/.test(txt)) return tag('FLAIR')
  if (/SWI|SWAN|VENOBOLD/.test(txt)) return 'SWI'
  if (/T2\s?\*|\bGRE\b|HEMO|MEDIC|\bFFE\b/.test(txt)) return 'T2*'
  if (/\bTOF\b|ANGIO|\bMRA\b|\bARM\b/.test(txt)) return 'Angio'
  if (/\bASL\b/.test(txt)) return 'ASL'
  if (/PERF|\bPWI\b|\bDSC\b|\bDCE\b/.test(txt)) return 'Perfusão'
  if (/\bBOLD\b|FMRI|\bREST\b/.test(txt)) return 'BOLD'
  if (/\bSTIR\b/.test(txt)) return 'STIR'
  if (/T1|MPRAGE|MP ?RAGE|SPGR|BRAVO|\bTFL\b/.test(txt)) return tag('T1')
  if (/T2|\bTSE\b|\bFSE\b|HASTE|SS ?FSE/.test(txt)) return tag('T2')
  if (/\bPD\b|\bDP\b|PROTON/.test(txt)) return 'DP'

  // sem texto reconhecível: classifica por tempos de eco/repetição/inversão (s → ms)
  const te = (sc.EchoTime || 0) * 1000, tr = (sc.RepetitionTime || 0) * 1000, ti = (sc.InversionTime || 0) * 1000
  if (ti > 1500 && ti < 3200) return tag('FLAIR')
  if (ti > 80 && ti < 350) return 'STIR'
  if (te >= 80) return tag('T2')
  if (te > 0 && te <= 30 && tr > 0 && tr <= 900) return tag('T1')
  if (tr > 2000 && te > 0 && te < 30) return 'DP'
  if ((sc.Modality || '') === 'MR') return 'RM'
  return ''
}

async function addSeries(entries) {
  for (const e of entries) {
    state.series.push(e)
    const item = document.createElement('button')
    item.className = 'thumb'
    item.id = `th-${e.id}`
    item.setAttribute('role', 'option')
    const sc = e.sidecar
    const title = esc(sc.SeriesDescription || sc.ProtocolName || e.file.name.replace(/\.nii(\.gz)?$/i, ''))
    const mod = sc.Modality || (e.kind === 'nifti' ? 'NIfTI' : '')
    const seq = inferSequence(sc, e.file.name)
    item.innerHTML = `<div class="th-im"><div class="ph"></div>
      ${seq ? `<span class="seq" title="Ponderação/sequência inferida dos metadados">${esc(seq)}</span>` : ''}
      <span class="th-cap"><strong title="${title}">${title}</strong>
      <span>${mod ? `<span class="badge">${mod}</span>` : ''}<span class="dims mono"></span></span></span>
    </div>`
    // clique: abre no painel focado; Ctrl+clique: abre em painel novo; clique direito: comparar
    item.onclick = (ev) => {
      if (ev.ctrlKey || ev.metaKey) { openInNewPanel(e.id); return }
      if (state.focus > 0) loadIntoPanel(state.focus, e.id)
      else openSeries(e.id)
    }
    item.oncontextmenu = (ev) => { ev.preventDefault(); compareSeries(e.id) }
    item.title = `${sc.SeriesDescription || e.file.name} — clique: abrir no painel focado · Ctrl+clique: novo painel · clique direito: comparar`
    $('seriesList').appendChild(item)
    makeThumb(e.file).then(({ canvas, hdr }) => {
      item.querySelector('.ph').replaceWith(canvas)
      item.querySelector('.dims').textContent =
        ` ${hdr.nx}×${hdr.ny}×${hdr.nz} · ${fmt(hdr.dx)}×${fmt(hdr.dy)} mm`
    }).catch(() => { /* miniatura é opcional */ })
  }
  $('stripCount').textContent = state.series.length
}

/** Carrega (ou reaproveita do cache) o NVImage de uma série. */
async function volumeFor(entry) {
  let vol = state.cache.get(entry.id)
  if (!vol) {
    vol = await NVImage.loadFromFile({ file: entry.file, name: entry.file.name })
    state.cache.set(entry.id, vol)
    // limita o cache para conter a memória, preservando os painéis em exibição
    const shown = new Set([entry.id, state.activeId, ...state.panels.map((p) => p?.id)])
    for (const k of state.cache.keys()) {
      if (state.cache.size <= 6) break
      if (!shown.has(k)) state.cache.delete(k)
    }
  }
  return vol
}

let openSeq = 0 // serializa aberturas concorrentes (duas seleções em sequência)
async function openSeries(id) {
  const entry = state.series.find((s) => s.id === id)
  if (!entry) return
  const seq = ++openSeq
  log(`Abrindo ${entry.file.name}…`); progress(0.3)
  try {
    let vol = await volumeFor(entry)
    if (seq !== openSeq) return // outra série foi pedida durante o carregamento
    const panel = state.panels[0]
    const position = positionForLoad(panel)
    panel.loading = true
    rewireSync()
    // NVImage já exibido noutro painel: clona para não compartilhar entre contextos GL
    if (state.panels.some((p, k) => k > 0 && p && p.nv.volumes.includes(vol))) vol = vol.clone()
    const nv = state.nv
    while (nv.volumes.length) nv.removeVolume(nv.volumes[0])
    nv.addVolume(vol)
    restorePosition(panel, position)
    state.vol = vol
    state.origVol = vol
    state.activeId = id
    if (state.panels[0]) state.panels[0].id = id
    $('btnMipOff').hidden = true
    $('btnObliqueOff').hidden = true
    // os controles precisam refletir a série nova, não a anterior
    $('obLR').value = $('obAP').value = $('obSI').value = 0
    $('colormap').value = vol.colormap || 'gray'
    state.roi?.clear()
    $('dropzone').classList.add('hidden')
    markActiveThumbs()

    // janela inicial: preset de crânio em TC, percentis robustos no resto
    const isCT = entry.sidecar.Modality === 'CT'
    $('ctPresets').hidden = !isCT
    if (isCT) applyWindow(40, 80)
    else autoWindow()

    populateMipAxes(vol)
    renderMeta(entry, vol)
    progress(0)
    log(`${entry.file.name} — ${vol.hdr.dims[1]}×${vol.hdr.dims[2]}×${vol.hdr.dims[3]} voxels`)
  } catch (err) {
    if (seq !== openSeq) return
    console.error(err)
    progress(0)
    log('Falha ao abrir a série: ' + err.message)
  } finally {
    if (seq === openSeq) { state.panels[0].loading = false; rewireSync() }
  }
}

function renderMeta(entry, vol) {
  const sc = entry.sidecar
  const dims = vol.hdr.dims, pd = vol.hdr.pixDims
  // plano e códigos de eixo vêm da matriz afim (LPS→RAS), nunca do nome da série
  let orient = null
  try {
    const { codes, plane } = planeFromAffine(vol.hdr.affine)
    state.axCodes = codes.join('')
    const nomes = { axial: 'Axial', coronal: 'Coronal', sagital: 'Sagital' }
    const obl = entry.geometry?.obliqueDeg
    orient = `${nomes[plane] || plane}${obl > 3 ? ` · oblíquo ${fmt(obl, 0)}°` : ''} (${codes.join('')})`
  } catch { /* afim ausente */ }
  const rows = [
    ['Descrição', sc.SeriesDescription || entry.file.name],
    ['Modalidade', sc.Modality || '—'],
    ['Orientação', orient],
    ['Matriz', `${dims[1]}×${dims[2]}×${dims[3]}${dims[0] >= 4 && dims[4] > 1 ? `×${dims[4]}` : ''}`],
    ['Voxel', `${fmt(Math.abs(pd[1]), 2)}×${fmt(Math.abs(pd[2]), 2)}×${fmt(Math.abs(pd[3]), 2)} mm`],
    ['Espessura', sc.SliceThickness ? `${sc.SliceThickness} mm` : null],
    ['Campo', sc.MagneticFieldStrength ? `${sc.MagneticFieldStrength} T` : null],
    ['TR/TE', sc.RepetitionTime ? `${fmt(sc.RepetitionTime * 1000, 0)}/${fmt((sc.EchoTime || 0) * 1000, 1)} ms` : null],
    ['kVp', sc.KVP || null],
    ['Aparelho', [sc.Manufacturer, sc.ManufacturersModelName].filter(Boolean).join(' ') || null],
    ['Data', sc.AcquisitionDateTime?.slice(0, 10) || null],
  ].filter(([, v]) => v)
  $('metaList').innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('')
}

/* ---------------- medidas ---------------- */
function renderMeasures() {
  const ol = $('measureList')
  if (!state.measures.length) { ol.innerHTML = '<li class="empty">Nenhuma medida ainda.</li>'; return }
  const dim = (t) => `<span style="color:var(--dim)">${t}</span>`
  ol.innerHTML = state.measures.map((m) => {
    const origem = state.layout > 1 ? ` ${dim(`· painel ${m.panel + 1}`)}` : ''
    if (m.kind === 'angle') return `<li>∠ ${fmt(m.value, 1)}°${origem}</li>`
    const cm = m.value > 10 ? ` ${dim(`(${fmt(m.value / 10, 2)} cm)`)}` : ''
    return `<li>⟷ ${fmt(m.value, 1)} mm${cm}${origem}</li>`
  }).join('')
}

/** Apaga as medidas: lista do painel lateral e traços desenhados nos painéis. */
function clearMeasures() {
  state.measures = []
  cancelPendingAngle(true)
  for (const p of state.panels.filter(Boolean)) {
    p.nv.clearAllMeasurements?.()
    p.nv.drawScene()
  }
  renderMeasures()
  log('Medidas apagadas.')
}

/* ---------------- MIP ---------------- */
function populateMipAxes(vol) {
  const labels = axisLabels(vol.hdr.affine)
  $('mipAxis').innerHTML = labels.map((l, i) => `<option value="${i}" ${l.startsWith('Axial') ? 'selected' : ''}>${l}</option>`).join('')
}

/** Copia atributos de exibição que o clone() do NiiVue não leva junto. */
function inheritDisplay(dst, src) {
  dst.colormap = src.colormap || 'gray'
  dst.opacity = src.opacity ?? 1
  dst.cal_min = src.cal_min; dst.cal_max = src.cal_max
  return dst
}

async function applyMip() {
  const vol = state.vol
  if (!vol) { log('Abra uma série antes de aplicar a projeção.'); return }
  if (state.busy) { log('Aguarde a operação em andamento terminar.'); return }
  const axis = Number($('mipAxis').value)
  const mode = $('mipMode').value
  const label = { max: 'MIP', min: 'MinIP', mean: 'Média' }[mode] || 'MIP'
  const mm = Math.max(1, Number($('mipMM').value) || 12)
  const pd = Math.abs(vol.hdr.pixDims[axis + 1]) || 1
  const slabVox = Math.max(1, Math.round(mm / pd))
  const forId = state.activeId // a série pode mudar durante o cálculo
  state.busy = true
  $('btnMip').disabled = true
  log(`Calculando ${label} (${mm} mm ≈ ${slabVox} voxels)…`); progress(0.4)
  await new Promise((r) => setTimeout(r)) // deixa a barra pintar antes do laço pesado
  try {
    const dims = vol.hdr.dims.slice(1, 4)
    // volumes 4D: projeta apenas o primeiro volume temporal
    const nvox = dims[0] * dims[1] * dims[2]
    const src = vol.img.length > nvox ? vol.img.subarray(0, nvox) : vol.img
    const out = slabProject(src, dims, axis, slabVox, mode)
    if (state.activeId !== forId) { progress(0); log('Série trocada — projeção descartada.'); return }
    const mip = inheritDisplay(vol.clone(), vol)
    mip.img = out
    if (mip.hdr.dims[0] >= 4) { mip.hdr.dims[0] = 3; mip.hdr.dims[4] = 1 }
    mip.name = `${label} ${mm}mm — ${vol.name}`
    const nv = state.nv
    while (nv.volumes.length) nv.removeVolume(nv.volumes[0])
    await nv.addVolume(mip)
    $('btnMipOff').hidden = false
    progress(0)
    log(`${label} de ${mm} mm aplicado — “Original” desfaz.`)
  } catch (err) {
    console.error(err); progress(0); log(`${label} falhou: ` + err.message)
  } finally {
    state.busy = false
    $('btnMip').disabled = false
  }
}

async function removeMip() {
  if (!state.vol) return
  const nv = state.nv
  while (nv.volumes.length) nv.removeVolume(nv.volumes[0])
  await nv.addVolume(state.vol)
  $('btnMipOff').hidden = true
  syncWindowInputs()
  log('Volume original restaurado.')
}

/* ---------------- MPR oblíquo ---------------- */
async function applyOblique() {
  const src = state.origVol
  if (!src) { log('Abra uma série antes de reformatar.'); return }
  if (state.busy) { log('Aguarde a operação em andamento terminar.'); return }
  const degLR = Number($('obLR').value) || 0
  const degAP = Number($('obAP').value) || 0
  const degSI = Number($('obSI').value) || 0
  if (!degLR && !degAP && !degSI) { removeOblique(); return }
  const centerMM = state.nv.frac2mm(state.nv.scene.crosshairPos)
  const shown = state.nv.volumes[0]
  const forId = state.activeId // a série pode mudar durante a reamostragem
  state.busy = true
  $('btnOblique').disabled = true
  log(`Reformatando oblíquo (${degLR}°/${degAP}°/${degSI}°)…`)
  try {
    const out = await bakeOblique(src, {
      degLR, degAP, degSI,
      centerMM: [centerMM[0], centerMM[1], centerMM[2]],
      onProgress: (p) => progress(Math.max(0.02, p * 0.98)),
    })
    if (state.activeId !== forId) { progress(0); log('Série trocada — reformatação descartada.'); return }
    const ob = inheritDisplay(src.clone(), shown || src)
    ob.img = out
    if (ob.hdr.dims[0] >= 4) { ob.hdr.dims[0] = 3; ob.hdr.dims[4] = 1 }
    ob.name = `Oblíquo ${degLR}/${degAP}/${degSI}° — ${src.name}`
    const nv = state.nv
    while (nv.volumes.length) nv.removeVolume(nv.volumes[0])
    await nv.addVolume(ob)
    state.vol = ob        // o thick slab passa a operar sobre o oblíquo
    $('btnMipOff').hidden = true
    $('btnObliqueOff').hidden = false
    state.roi?.clear()    // as ROIs valem para a grade em exibição
    progress(0)
    log(`Oblíquo aplicado (L–R ${degLR}° · A–P ${degAP}° · S–I ${degSI}°, em torno do cursor) — “Original” desfaz.`)
  } catch (err) {
    console.error(err); progress(0)
    log('Oblíquo falhou: ' + err.message)
  } finally {
    state.busy = false
    $('btnOblique').disabled = false
  }
}

async function removeOblique() {
  if (!state.origVol) return
  const nv = state.nv
  while (nv.volumes.length) nv.removeVolume(nv.volumes[0])
  await nv.addVolume(state.origVol)
  state.vol = state.origVol
  $('btnMipOff').hidden = true
  $('btnObliqueOff').hidden = true
  state.roi?.clear()
  syncWindowInputs()
  log('Volume original restaurado.')
}

/* ---------------- ROIs ---------------- */
let lastRoiCount = 0
function renderRoiList(rois, selected) {
  const ol = $('roiList')
  if (rois.length > lastRoiCount) flashPanel('panelRoi') // ROI nova: traz a estatística à vista
  lastRoiCount = rois.length
  if (!rois.length) { ol.innerHTML = '<li class="empty">Nenhuma ROI ainda.</li>'; return }
  ol.innerHTML = rois.map((r, i) => {
    const s = r.stats
    const kind = r.kind === 'ellipse' ? 'elipse' : 'laço'
    const area = s.areaMM >= 100 ? `${fmt(s.areaMM / 100, 2)} cm²` : `${fmt(s.areaMM, 1)} mm²`
    return `<li class="${i === selected ? 'sel' : ''}" data-roi="${i}" title="clique para selecionar · Del remove">` +
      `<strong>${i + 1}</strong> ${kind} · média ${fmt(s.mean, 1)} · DP ${fmt(s.sd, 1)}` +
      `<br />mín ${fmt(s.min, 1)} · máx ${fmt(s.max, 1)} · ${area}</li>`
  }).join('')
  ol.querySelectorAll('li[data-roi]').forEach((li) =>
    (li.onclick = () => state.roi.select(Number(li.dataset.roi))))
}

/** Reflete na barra o estado real das ferramentas de ROI (inclui o Esc do roi.js). */
function syncRoiButtons(armed) {
  $('toolRoiEllipse').classList.toggle('armed', armed === 'ellipse')
  $('toolRoiLasso').classList.toggle('armed', armed === 'lasso')
}

function armRoi(kind) {
  if (!state.nv.volumes.length) { log('Abra uma série antes de traçar uma ROI.'); return }
  const armed = state.roi.arm(kind)
  // a ROI só existe no painel principal: leva o foco para ele, senão o usuário
  // desenha num painel de comparação e nada acontece
  const noPainel1 = armed && state.layout > 1 ? ' — no painel 1 (destacado)' : ''
  if (armed && state.focus !== 0) focusPanel(0)
  if (armed === 'ellipse') log(`ROI elíptica: arraste sobre a imagem${noPainel1}. Esc sai.`)
  else if (armed === 'lasso') log(`Laço: arraste o traçado — ou setas + Espaço, Enter fecha${noPainel1}. Esc sai.`)
  else log('Ferramenta de ROI desativada.')
}

/* ---------------- 3D ---------------- */
function applyIllumination() {
  const nv = focusedNv() // o painel 3D visível é o focado
  if (nv.volumes.length) nv.setVolumeRenderIllumination(Number($('illum').value))
}

/* ---------------- entrada de arquivos ---------------- */
// acima deste tamanho, o estudo passa pela triagem com escolha de séries —
// evita alocar centenas de MB de uma vez (falhas de ArrayBuffer em máquinas
// com pouca memória)
const PICKER_MIN_FILES = 100

async function handleFiles(files) {
  if (!files?.length) return
  try {
    progress(0.1)
    const { entries, dicoms } = await splitInput(files, log)
    if (entries.length) {
      await addSeries(entries)
      log(`${entries.length} série(s) NIfTI adicionada(s).`)
      if (!state.activeId) openSeries(entries[0].id)
    }
    if (dicoms.length) await handleDicoms(dicoms)
    else if (!entries.length) throw new Error('nenhuma imagem reconhecida na seleção')
    progress(0)
  } catch (err) {
    console.error(err)
    progress(0)
    log('Não foi possível abrir: ' + err.message)
  }
}

async function handleDicoms(dicoms) {
  // triagem por cabeçalho: agrupa por série lendo só os primeiros KB de cada arquivo
  log(`Lendo cabeçalhos de ${dicoms.length} arquivo(s)…`)
  const groups = await scanDicomSeries(dicoms, (k, n) => {
    progress(0.1 + 0.1 * (k / n)); log(`Lendo cabeçalhos… ${k}/${n}`)
  })
  if (!groups.length) {
    // nada com UID de série — cai no caminho antigo (conversão em bloco)
    const series = await convertDicom(dicoms, log)
    await addSeries(series)
    if (!state.activeId && series.length) openSeries(series[0].id)
    return
  }
  let plan
  if (groups.length === 1 && dicoms.length <= PICKER_MIN_FILES) {
    plan = { selected: groups, direct: false } // estudo pequeno: converte sem perguntar
  } else {
    plan = await showSeriesPicker(groups, dicoms.length)
  }
  if (!plan || !plan.selected.length) { progress(0); log('Abertura cancelada.'); return }

  // processa UMA série por vez: o pico de memória é o de uma série, não o do estudo
  let opened = 0, failed = 0
  for (let i = 0; i < plan.selected.length; i++) {
    const g = plan.selected[i]
    const tag = `Série ${i + 1}/${plan.selected.length} — ${g.desc}`
    progress(0.2 + 0.78 * (i / plan.selected.length))
    try {
      let series
      if (plan.direct && g.supportedDirect) {
        log(`${tag}: lendo DICOM diretamente (${g.count} cortes)…`)
        const { file, sidecar, geometry } = await directSeriesToNifti(g, (k, n) =>
          progress(0.2 + 0.78 * ((i + k / n) / plan.selected.length)))
        const e = makeEntry(file, sidecar, 'dicom')
        e.geometry = geometry
        series = [e]
      } else {
        log(`${tag}: ${plan.direct ? 'sem suporte à leitura direta — ' : ''}convertendo (${g.count} arquivos)…`)
        series = await convertDicom(g.files, log)
      }
      if (Math.abs(g.tilt || 0) > 0.5) {
        log(`${tag}: gantry inclinado ${fmt(g.tilt, 1)}° — o MPR pode sair cisalhado.`)
      }
      await addSeries(series)
      opened += series.length
      if (!state.activeId && series.length) openSeries(series[0].id)
    } catch (err) {
      console.error(err); failed++
      log(`${tag}: falhou (${err.message}) — seguindo para a próxima.`)
    }
  }
  progress(0)
  log(`${opened} série(s) aberta(s)${failed ? ` · ${failed} falha(s)` : ''}.`)
}

/** Diálogo de triagem: escolher séries e modo de abertura. */
function showSeriesPicker(groups, totalFiles) {
  return new Promise((resolve) => {
    const dlg = $('dlgSeries')
    const totalMB = groups.reduce((s, g) => s + g.bytes, 0) / 1048576
    const big = totalFiles > 800 || totalMB > 800
    $('seriesPickInfo').textContent =
      `${groups.length} série(s) · ${totalFiles} arquivo(s) · ${fmt(totalMB, 0)} MB. ` +
      `Abrir menos séries de uma vez poupa memória${big ? ' — estudo grande: selecione só o necessário' : ''}.`
    $('seriesPickList').innerHTML = groups.map((g, i) => `
      <li><label><input type="checkbox" data-g="${i}" ${big ? '' : 'checked'} />
        <span class="pick-desc"><strong>${esc(g.desc)}</strong>
        <span class="mono">${esc(g.sidecar.Modality || '?')} · ${g.count} img · ${fmt(g.bytes / 1048576, 1)} MB${g.supportedDirect ? '' : ' · só conversão'}</span></span>
      </label></li>`).join('')
    let settled = false
    const done = (value) => {
      if (settled) return
      settled = true
      if (dlg.open) dlg.close()
      resolve(value)
    }
    $('btnSeriesAll').onclick = () => dlg.querySelectorAll('input[data-g]').forEach((c) => (c.checked = true))
    $('btnSeriesNone').onclick = () => dlg.querySelectorAll('input[data-g]').forEach((c) => (c.checked = false))
    $('btnSeriesCancel').onclick = () => done(null)
    dlg.oncancel = () => done(null)
    $('btnSeriesOpen').onclick = () => {
      const selected = [...dlg.querySelectorAll('input[data-g]:checked')].map((c) => groups[Number(c.dataset.g)])
      if (!selected.length) { log('Selecione ao menos uma série.'); return }
      const direct = dlg.querySelector('input[name="openMode"]:checked')?.value === 'direct'
      done({ selected, direct })
    }
    dlg.showModal()
  })
}

/* ---------------- ligações ---------------- */
function bind() {
  // o botão do mouse usado no clique define a qual botão a ferramenta se associa:
  // esquerdo → botão esquerdo, direito → botão direito, meio → botão do meio
  document.querySelectorAll('.tool[data-tool]').forEach((b) => {
    b.onclick = () => assignTool('left', b.dataset.tool)
    b.oncontextmenu = (e) => { e.preventDefault(); assignTool('right', b.dataset.tool) }
    b.onauxclick = (e) => { if (e.button === 1) assignTool('middle', b.dataset.tool) }
    b.onmousedown = (e) => { if (e.button === 1) e.preventDefault() } // evita o autoscroll do navegador
  })
  document.querySelectorAll('.tool[data-view]').forEach((b) => (b.onclick = () => setView(b.dataset.view)))

  // diálogo de atalhos/tutorial (?) — os seletores editam os gestos ao vivo
  const tbody = $('gestureRows')
  tbody.innerHTML = GESTURES.map((g) => {
    const opts = Object.entries(ACTIONS)
      .filter(([, a]) => !g.emulOnly || a.emul)
      .map(([k, a]) => `<option value="${k}">${a.label}</option>`).join('')
    return `<tr><td>${g.label}</td><td><select data-gesture="${g.key}">${opts}</select></td></tr>`
  }).join('')
  tbody.querySelectorAll('select[data-gesture]').forEach((s) => {
    s.value = state.mouse[s.dataset.gesture]
    s.onchange = () => assignTool(s.dataset.gesture, s.value)
  })
  $('convencao').onchange = () => setConvencao($('convencao').value)
  $('btnHelp').onclick = () => { applyMouseConfig(); $('dlgHelp').showModal() }
  $('btnHelpClose').onclick = () => $('dlgHelp').close()
  $('btnMouseDefaults').onclick = () => {
    state.mouse = { ...MOUSE_DEFAULTS }
    applyMouseConfig()
    log('Gestos do mouse restaurados ao padrão.')
  }

  document.querySelectorAll('.tool[data-layout]').forEach((b) => (b.onclick = async () => {
    const n = Number(b.dataset.layout)
    if (n > 1 && !state.series.length) { log('Abra ao menos uma série antes de comparar.'); return }
    await setLayout(n)
  }))

  for (const [id, key] of [['btnSyncPosition', 'syncPosition'], ['btnSyncZoom', 'syncZoom']]) {
    $(id).onclick = () => {
      state[key] = !state[key]
      $(id).classList.toggle('active', state[key])
      $(id).setAttribute('aria-pressed', String(state[key]))
      rewireSync()
      const panel = state.panels[state.focus]
      if (state[key] && panel?.nv.volumes.length) {
        focusPanel(state.focus, true)
        panel.nv.drawScene()
      }
      log(`${key === 'syncPosition' ? 'Posição em mm' : 'Zoom e câmera'}: ${state[key] ? 'vinculados' : 'independentes'}.`)
    }
  }

  $('btnDicomDir').onclick = () => $('inDicomDir').click()
  $('btnFiles').onclick = () => $('inFiles').click()
  $('inDicomDir').onchange = (e) => { handleFiles(e.target.files); e.target.value = '' }
  $('inFiles').onchange = (e) => { handleFiles(e.target.files); e.target.value = '' }

  const stage = $('stage')
  ;['dragenter', 'dragover'].forEach((ev) => stage.addEventListener(ev, (e) => {
    e.preventDefault(); $('dropzone').classList.remove('hidden'); $('dropzone').classList.add('hover')
  }))
  // sair do palco (ou da janela) esconde a caixa de novo — senão ela fica
  // permanentemente sobre a imagem depois de um arrasto abandonado
  stage.addEventListener('dragleave', (e) => {
    if (stage.contains(e.relatedTarget)) return
    $('dropzone').classList.remove('hover')
    if (state.activeId) $('dropzone').classList.add('hidden')
  })
  stage.addEventListener('drop', async (e) => {
    e.preventDefault()
    $('dropzone').classList.remove('hover')
    if (state.activeId) $('dropzone').classList.add('hidden')
    handleFiles(await filesFromDrop(e.dataTransfer))
  })

  $('wl').onchange = $('ww').onchange = () => applyWindow(Number($('wl').value), Number($('ww').value))
  $('btnAutoWindow').onclick = autoWindow
  document.querySelectorAll('#ctPresets button').forEach((b) =>
    (b.onclick = () => applyWindow(Number(b.dataset.wl), Number(b.dataset.ww))))
  $('colormap').onchange = () => {
    const v = displayedVol()
    if (v) { v.colormap = $('colormap').value; state.nv.updateGLVolume() }
  }

  $('btnMip').onclick = applyMip
  $('btnMipOff').onclick = removeMip
  $('btnOblique').onclick = applyOblique
  $('btnObliqueOff').onclick = () => { $('obLR').value = $('obAP').value = $('obSI').value = 0; removeOblique() }

  $('toolRoiEllipse').onclick = () => armRoi('ellipse')
  $('toolRoiLasso').onclick = () => armRoi('lasso')
  $('btnClearRois').onclick = () => state.roi.clear()
  $('illum').onchange = applyIllumination
  $('clip').oninput = () => {
    // o NiiVue desliga o corte com profundidade > 2; o extremo direito do
    // controle é justamente "sem corte"
    const d = Number($('clip').value)
    const off = d >= 2
    focusedNv().setClipPlane([off ? 3 : d, 270, 0])
    $('clipVal').textContent = off ? 'desligado' : fmt(d, 2)
  }

  $('btnClearMeasures').onclick = clearMeasures
  $('btnReset').onclick = () => {
    for (const nv of state.panels.filter(Boolean).map((p) => p.nv)) {
      nv.scene.pan2Dxyzmm = [0, 0, 0, 1]
      nv.drawScene()
    }
    autoWindow()
  }
  $('btnShot').onclick = () => {
    focusedNv().saveScene(`lume-${Date.now()}.png`)
    log(state.layout > 1 ? `Captura do painel ${state.focus + 1} salva.` : 'Captura salva.')
  }

  window.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return
    if (/^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName)) return
    // com um diálogo aberto os atalhos não valem (senão trocam ferramentas por trás)
    if (document.querySelector('dialog[open]')) return
    // Esc: cancela o ângulo em andamento e, se não houver, sai da ferramenta de medida
    if (e.key === 'Escape') {
      if (cancelPendingAngle()) return
      if (state.mouse.left === 'angle' || state.mouse.left === 'measurement') assignTool('left', 'browse')
      return
    }
    const k = e.key.toLowerCase()
    const map = { b: 'browse', c: 'crosshair', j: 'windowing', m: 'measurement', a: 'angle', v: 'pan', z: 'zoom' }
    if (map[k]) { assignTool('left', map[k]); return }
    if (k === 'e') { armRoi('ellipse'); return }
    if (k === 'l') { armRoi('lasso'); return }
    // presets de janela pelo teclado: 1–7 aplica o preset de TC, 0 = janela automática
    if (k === '0') { autoWindow(); log('Janela automática.'); return }
    if (/^[1-7]$/.test(k) && !$('ctPresets').hidden) {
      const b = document.querySelectorAll('#ctPresets button')[Number(k) - 1]
      if (b) {
        applyWindow(Number(b.dataset.wl), Number(b.dataset.ww))
        log(`Janela: ${b.textContent.replace(/\s*\d\s*$/, '')} (C ${b.dataset.wl} / L ${b.dataset.ww}).`)
      }
    }
  })
}

/* ---------------- inicialização ---------------- */
await initViewer()
state.roi = createRoiTool({
  nv: state.nv,
  overlay: $('roiOverlay'),
  glCanvas: $('gl'),
  getVol: () => state.nv.volumes[0] || null,
  onChange: renderRoiList,
  onArmChange: syncRoiButtons,
  isMagnet: () => $('roiMagnet').checked,
  log,
})
bind()
buildSliceBars()
try {
  const salva = localStorage.getItem('lume-convencao')
  if (salva && CONVENCOES[salva]) state.convencao = salva
} catch { /* sem storage */ }
$('convencao').value = state.convencao
setConvencao(state.convencao, true)
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('./sw.js').catch(() => {})
}
window.lume = { state, openSeries, compareSeries, setLayout, focusPanel, loadIntoPanel, handleFiles, VERSION } // acesso programático / testes
log(`Lume v${VERSION} — pronto. Abra uma pasta DICOM, NIfTI ou ZIP.`)
