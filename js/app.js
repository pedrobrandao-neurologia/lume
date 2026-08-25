// app.js — Lume: visualizador DICOM/NIfTI 100% no navegador.
// Leitor DICOM e conversão reaproveitados do MorfoStudio/SegmentaRM
// (dcm2niix WASM); renderização com NiiVue (WebGL2).

import { Niivue, NVImage, DRAG_MODE } from '../vendor/niivue.min.js'
import { ingest, filesFromDrop } from './ingest.js'
import { makeThumb } from './thumbs.js'
import { slabProject, axisLabels } from './mip.js'
import { createRoiTool } from './roi.js'
import { bakeOblique } from './oblique.js'

const $ = (id) => document.getElementById(id)
const VERSION = '0.5.0'

const state = {
  nv: null,            // visualizador do painel principal (nº 1) — ROI, janela, slab, oblíquo
  panels: [],          // {nv, canvas, id: seriesId, view} — painéis de comparação (índice 0 = principal)
  layout: 1,           // nº de painéis visíveis (1–4)
  focus: 0,            // painel focado: recebe as trocas de corte e as séries clicadas
  series: [],          // SeriesEntry[]
  activeId: null,
  vol: null,           // NVImage base em exibição (original ou oblíquo)
  origVol: null,       // NVImage original da série ativa (p/ desfazer o oblíquo)
  mipVol: null,        // NVImage derivado (thick slab), quando ativo
  roi: null,           // controlador de ROIs
  cache: new Map(),    // id → NVImage (limitado, para trocar de série sem reconverter)
  measures: [],
  // ferramenta associada a cada botão do mouse, como numa workstation
  mouse: { left: 'crosshair', right: 'windowing', middle: 'pan' },
}

/* ---------------- utilidades de interface ---------------- */
function log(msg) { $('statusMsg').textContent = msg }
function progress(p) {
  const bar = $('progress')
  bar.hidden = !(p > 0 && p < 1)
  $('progressFill').style.width = `${Math.round(p * 100)}%`
}
const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const fmt = (n, d = 1) => Number(n).toLocaleString('pt-BR', { maximumFractionDigits: d })

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

  nv.onLocationChange = (d) => { $('statusLoc').textContent = d?.string || '' }
  nv.onIntensityChange = () => syncWindowInputs()
  $('gl').addEventListener('pointerdown', (e) => { state.lastButton = e.button })
  nv.onDragRelease = (p) => {
    // registra a medida se o botão solto estava com a ferramenta de medição
    const btn = { 0: 'left', 1: 'middle', 2: 'right' }[state.lastButton]
    if (btn && state.mouse[btn] === 'measurement' && p?.mmLength > 0.5) {
      state.measures.push(p.mmLength)
      renderMeasures()
    }
  }
  state.nv = nv
  await ensurePanel(0) // registra o visualizador como painel principal
}

/* ---------------- comparação em 1–4 painéis sincronizados ---------------- */
// Cada painel tem série e orientação próprias (ex.: coluna em axial, sagital e
// coronal ao mesmo tempo); o cursor/scroll é sincronizado em mm entre todos,
// o que localiza a mesma lesão tridimensionalmente em todos os painéis.
const PANEL_CANVAS = ['gl', 'gl2', 'gl3', 'gl4']
const DEFAULT_VIEWS = ['mpr', 'sagittal', 'coronal', 'axial'] // padrão ao abrir cada painel

async function ensurePanel(i) {
  if (state.panels[i]) return state.panels[i]
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
  const panel = { nv, canvas, id: null, view: DEFAULT_VIEWS[i] }
  state.panels[i] = panel
  canvas.addEventListener('pointerdown', () => focusPanel(i))
  applyMouseConfig()
  rewireSync()
  return panel
}

// religa a sincronização bidirecional (cursor em mm, pan/zoom, câmera 3D)
// entre todos os painéis visíveis; a orientação de corte NÃO é sincronizada.
function rewireSync() {
  const active = state.panels.slice(0, state.layout).filter(Boolean)
  for (const p of active) {
    const others = active.filter((q) => q !== p).map((q) => q.nv)
    p.nv.broadcastTo(others, { '2d': true, '3d': true })
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

async function setLayout(n) {
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
  for (let i = 0; i < n; i++) {
    const isNew = !state.panels[i]
    const panel = await ensurePanel(i)
    // painel recém-aberto: recebe a série ativa na orientação padrão (sag/cor/ax)
    if (isNew && i > 0 && state.activeId && !panel.id) {
      applyPanelView(panel)
      await loadIntoPanel(i, state.activeId)
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

function focusPanel(i) {
  if (i >= state.layout || !state.panels[i]) return
  state.focus = i
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
  log(`Painel ${i + 1}: abrindo ${entry.file.name}…`); progress(0.3)
  try {
    let vol = await volumeFor(entry)
    // NVImage já exibido em outro painel: clona para não compartilhar entre contextos GL
    if (state.panels.some((p) => p && p.nv.volumes.includes(vol))) vol = vol.clone()
    const nv = panel.nv
    while (nv.volumes.length) nv.removeVolume(nv.volumes[0])
    await nv.addVolume(vol)
    panel.id = id
    const v = nv.volumes[0]
    if (entry.sidecar.Modality === 'CT') { v.cal_min = 0; v.cal_max = 80 }
    else { v.cal_min = v.robust_min ?? v.global_min; v.cal_max = v.robust_max ?? v.global_max }
    nv.updateGLVolume()
    applyPanelView(panel)
    markActiveThumbs()
    progress(0)
    log(`Painel ${i + 1}: ${entry.file.name} (${panel.view}) — cursor sincronizado em mm.`)
  } catch (err) {
    console.error(err); progress(0)
    log('Falha ao abrir no painel: ' + err.message)
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

const TOOL_MODES = {
  crosshair: DRAG_MODE.crosshair,
  windowing: DRAG_MODE.windowing,
  measurement: DRAG_MODE.measurement,
  angle: DRAG_MODE.angle,
  pan: DRAG_MODE.pan,
}
const MOUSE_LABEL = { left: 'E', right: 'D', middle: 'M' } // esquerdo · direito · meio

/** Associa uma ferramenta a um botão do mouse (left/right/middle). */
function assignTool(button, tool) {
  if (!(tool in TOOL_MODES) || !(button in MOUSE_LABEL)) return
  state.mouse[button] = tool
  applyMouseConfig()
  const names = { left: 'esquerdo', right: 'direito', middle: 'do meio' }
  const btnEl = document.querySelector(`.tool[data-tool="${tool}"]`)
  log(`${btnEl ? btnEl.textContent.replace(/\s*[EDM·\s]+$/, '') : tool} no botão ${names[button]} do mouse.`)
}

function applyMouseConfig() {
  for (const nv of state.panels.filter(Boolean).map((p) => p.nv)) {
    nv.opts.dragModePrimary = TOOL_MODES[state.mouse.left]
    nv.opts.dragMode = TOOL_MODES[state.mouse.right]
    nv.opts.mouseEventConfig = {
      leftButton: { primary: TOOL_MODES[state.mouse.left] },
      rightButton: TOOL_MODES[state.mouse.right],
      centerButton: TOOL_MODES[state.mouse.middle],
    }
  }
  document.querySelectorAll('.tool[data-tool]').forEach((b) => {
    const letters = Object.keys(state.mouse)
      .filter((k) => state.mouse[k] === b.dataset.tool)
      .map((k) => MOUSE_LABEL[k])
    let chip = b.querySelector('.mb')
    if (!chip) { chip = document.createElement('span'); chip.className = 'mb'; b.appendChild(chip) }
    chip.textContent = letters.join('·')
    chip.hidden = !letters.length
    b.classList.toggle('active', letters.length > 0)
  })
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
function displayedVol() { return state.nv.volumes[0] || null }

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
  state.nv.updateGLVolume()
  syncWindowInputs()
}

function autoWindow() {
  const v = displayedVol()
  if (!v) return
  v.cal_min = v.robust_min ?? v.global_min
  v.cal_max = v.robust_max ?? v.global_max
  state.nv.updateGLVolume()
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
    // clique: abre no painel focado (principal ou de comparação); clique direito: manda para comparação
    item.onclick = () => (state.focus > 0 ? loadIntoPanel(state.focus, e.id) : openSeries(e.id))
    item.oncontextmenu = (ev) => { ev.preventDefault(); compareSeries(e.id) }
    item.title = `${sc.SeriesDescription || e.file.name} — clique: abrir no painel focado · clique direito: comparar`
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

async function openSeries(id) {
  const entry = state.series.find((s) => s.id === id)
  if (!entry) return
  log(`Abrindo ${entry.file.name}…`); progress(0.3)
  try {
    let vol = await volumeFor(entry)
    // NVImage já exibido noutro painel: clona para não compartilhar entre contextos GL
    if (state.panels.some((p, k) => k > 0 && p && p.nv.volumes.includes(vol))) vol = vol.clone()
    const nv = state.nv
    while (nv.volumes.length) nv.removeVolume(nv.volumes[0])
    await nv.addVolume(vol)
    state.vol = vol
    state.origVol = vol
    state.mipVol = null
    state.activeId = id
    if (state.panels[0]) state.panels[0].id = id
    $('btnMipOff').hidden = true
    $('btnObliqueOff').hidden = true
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
    console.error(err)
    progress(0)
    log('Falha ao abrir a série: ' + err.message)
  }
}

function renderMeta(entry, vol) {
  const sc = entry.sidecar
  const dims = vol.hdr.dims, pd = vol.hdr.pixDims
  const rows = [
    ['Descrição', sc.SeriesDescription || entry.file.name],
    ['Modalidade', sc.Modality || '—'],
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
  ol.innerHTML = state.measures.map((mm) => `<li>${fmt(mm, 1)} mm${mm > 10 ? ` <span style="color:var(--dim)">(${fmt(mm / 10, 2)} cm)</span>` : ''}</li>`).join('')
}

/* ---------------- MIP ---------------- */
function populateMipAxes(vol) {
  const labels = axisLabels(vol.hdr.affine)
  $('mipAxis').innerHTML = labels.map((l, i) => `<option value="${i}" ${l.startsWith('Axial') ? 'selected' : ''}>${l}</option>`).join('')
}

async function applyMip() {
  const vol = state.vol
  if (!vol) return
  const axis = Number($('mipAxis').value)
  const mode = $('mipMode').value
  const label = { max: 'MIP', min: 'MinIP', mean: 'Média' }[mode] || 'MIP'
  const mm = Math.max(1, Number($('mipMM').value) || 12)
  const pd = Math.abs(vol.hdr.pixDims[axis + 1]) || 1
  const slabVox = Math.max(1, Math.round(mm / pd))
  log(`Calculando ${label} (${mm} mm ≈ ${slabVox} voxels)…`); progress(0.4)
  await new Promise((r) => setTimeout(r)) // deixa a barra pintar antes do laço pesado
  try {
    const dims = vol.hdr.dims.slice(1, 4)
    // volumes 4D: projeta apenas o primeiro volume temporal
    const nvox = dims[0] * dims[1] * dims[2]
    const src = vol.img.length > nvox ? vol.img.subarray(0, nvox) : vol.img
    const out = slabProject(src, dims, axis, slabVox, mode)
    const mip = vol.clone()
    mip.zeroImage()
    mip.img = out
    if (mip.hdr.dims[0] >= 4) { mip.hdr.dims[0] = 3; mip.hdr.dims[4] = 1 }
    mip.name = `${label} ${mm}mm — ${vol.name}`
    mip.cal_min = vol.cal_min; mip.cal_max = vol.cal_max
    const nv = state.nv
    while (nv.volumes.length) nv.removeVolume(nv.volumes[0])
    await nv.addVolume(mip)
    state.mipVol = mip
    $('btnMipOff').hidden = false
    progress(0)
    log(`${label} de ${mm} mm aplicado — “Original” desfaz.`)
  } catch (err) {
    console.error(err); progress(0); log(`${label} falhou: ` + err.message)
  }
}

async function removeMip() {
  if (!state.vol) return
  const nv = state.nv
  while (nv.volumes.length) nv.removeVolume(nv.volumes[0])
  await nv.addVolume(state.vol)
  state.mipVol = null
  $('btnMipOff').hidden = true
  syncWindowInputs()
  log('Volume original restaurado.')
}

/* ---------------- MPR oblíquo ---------------- */
async function applyOblique() {
  const src = state.origVol
  if (!src) return
  const degLR = Number($('obLR').value) || 0
  const degAP = Number($('obAP').value) || 0
  const degSI = Number($('obSI').value) || 0
  if (!degLR && !degAP && !degSI) { removeOblique(); return }
  const centerMM = state.nv.frac2mm(state.nv.scene.crosshairPos)
  log(`Reformatando oblíquo (${degLR}°/${degAP}°/${degSI}°)…`)
  try {
    const out = await bakeOblique(src, {
      degLR, degAP, degSI,
      centerMM: [centerMM[0], centerMM[1], centerMM[2]],
      onProgress: (p) => progress(Math.max(0.02, p * 0.98)),
    })
    const ob = src.clone()
    ob.zeroImage()
    ob.img = out
    if (ob.hdr.dims[0] >= 4) { ob.hdr.dims[0] = 3; ob.hdr.dims[4] = 1 }
    ob.name = `Oblíquo ${degLR}/${degAP}/${degSI}° — ${src.name}`
    ob.cal_min = state.nv.volumes[0]?.cal_min ?? src.cal_min
    ob.cal_max = state.nv.volumes[0]?.cal_max ?? src.cal_max
    const nv = state.nv
    while (nv.volumes.length) nv.removeVolume(nv.volumes[0])
    await nv.addVolume(ob)
    state.vol = ob        // o thick slab passa a operar sobre o oblíquo
    state.mipVol = null
    $('btnMipOff').hidden = true
    $('btnObliqueOff').hidden = false
    state.roi?.clear()    // as ROIs valem para a grade em exibição
    progress(0)
    log(`Oblíquo aplicado (L–R ${degLR}° · A–P ${degAP}° · S–I ${degSI}°, em torno do cursor) — “Original” desfaz.`)
  } catch (err) {
    console.error(err); progress(0)
    log('Oblíquo falhou: ' + err.message)
  }
}

async function removeOblique() {
  if (!state.origVol) return
  const nv = state.nv
  while (nv.volumes.length) nv.removeVolume(nv.volumes[0])
  await nv.addVolume(state.origVol)
  state.vol = state.origVol
  state.mipVol = null
  $('btnMipOff').hidden = true
  $('btnObliqueOff').hidden = true
  state.roi?.clear()
  syncWindowInputs()
  log('Volume original restaurado.')
}

/* ---------------- ROIs ---------------- */
function renderRoiList(rois, selected) {
  const ol = $('roiList')
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

function armRoi(kind) {
  const armed = state.roi.arm(kind)
  $('toolRoiEllipse').classList.toggle('armed', armed === 'ellipse')
  $('toolRoiLasso').classList.toggle('armed', armed === 'lasso')
  if (armed === 'ellipse') log('ROI elíptica: arraste no painel esquerdo. Esc sai.')
  else if (armed === 'lasso') log('Laço: arraste o traçado — ou use as setas + Espaço (Enter fecha). Esc sai.')
}

/* ---------------- 3D ---------------- */
function applyIllumination() {
  if (state.nv.volumes.length) state.nv.setVolumeRenderIllumination(Number($('illum').value))
}

/* ---------------- entrada de arquivos ---------------- */
async function handleFiles(files) {
  if (!files?.length) return
  try {
    progress(0.15)
    const entries = await ingest(files, log)
    await addSeries(entries)
    progress(0)
    log(`${entries.length} série(s) adicionada(s).`)
    if (!state.activeId) openSeries(entries[0].id)
  } catch (err) {
    console.error(err)
    progress(0)
    log('Não foi possível abrir: ' + err.message)
  }
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

  document.querySelectorAll('.tool[data-layout]').forEach((b) => (b.onclick = async () => {
    const n = Number(b.dataset.layout)
    if (n > 1 && !state.series.length) { log('Abra ao menos uma série antes de comparar.'); return }
    await setLayout(n)
  }))

  $('btnDicomDir').onclick = () => $('inDicomDir').click()
  $('btnFiles').onclick = () => $('inFiles').click()
  $('inDicomDir').onchange = (e) => { handleFiles(e.target.files); e.target.value = '' }
  $('inFiles').onchange = (e) => { handleFiles(e.target.files); e.target.value = '' }

  const stage = $('stage')
  ;['dragenter', 'dragover'].forEach((ev) => stage.addEventListener(ev, (e) => {
    e.preventDefault(); $('dropzone').classList.remove('hidden'); $('dropzone').classList.add('hover')
  }))
  stage.addEventListener('dragleave', () => $('dropzone').classList.remove('hover'))
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
    const d = Number($('clip').value)
    state.nv.setClipPlane([d > 1 ? 2 : d, 270, 0])
  }

  $('btnClearMeasures').onclick = () => { state.measures = []; renderMeasures() }
  $('btnReset').onclick = () => {
    for (const nv of state.panels.filter(Boolean).map((p) => p.nv)) {
      nv.scene.pan2Dxyzmm = [0, 0, 0, 1]
      nv.drawScene()
    }
    autoWindow()
  }
  $('btnShot').onclick = () => state.nv.saveScene(`lume-${Date.now()}.png`)

  window.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return
    if (/^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName)) return
    const k = e.key.toLowerCase()
    const map = { c: 'crosshair', j: 'windowing', m: 'measurement', a: 'angle', v: 'pan' }
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
  isMagnet: () => $('roiMagnet').checked,
  log,
})
bind()
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('./sw.js').catch(() => {})
}
window.lume = { state, openSeries, compareSeries, setLayout, focusPanel, loadIntoPanel, handleFiles, VERSION } // acesso programático / testes
log(`Lume v${VERSION} — pronto. Abra uma pasta DICOM, NIfTI ou ZIP.`)
