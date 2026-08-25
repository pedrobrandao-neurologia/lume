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
const VERSION = '0.4.0'

const state = {
  nv: null,
  nv2: null,           // segundo visualizador (comparação lado a lado)
  compare: false,
  rightId: null,       // série exibida no painel direito
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
  applyMouseConfig()
}

/* ---------------- comparação lado a lado ---------------- */
async function ensureCompareViewer() {
  if (state.nv2) return state.nv2
  const nv2 = new Niivue({
    backColor: [0, 0, 0, 1],
    crosshairColor: [0.31, 0.7, 0.75, 0.9], // teal: distingue o painel de comparação
    show3Dcrosshair: true,
    dragAndDropEnabled: false,
    multiplanarForceRender: false,
  })
  await nv2.attachToCanvas($('gl2'))
  nv2.setSliceType(nv2.sliceTypeMultiplanar)
  nv2.opts.yoke3Dto2DZoom = true
  state.nv2 = nv2
  applyMouseConfig()
  // sincronização bidirecional em mm: cursor, scroll de cortes, pan/zoom e câmera 3D
  state.nv.broadcastTo(nv2, { '2d': true, '3d': true })
  nv2.broadcastTo(state.nv, { '2d': true, '3d': true })
  return nv2
}

async function setCompare(on) {
  if (on === state.compare) return
  state.compare = on
  $('btnCompare').classList.toggle('active', on)
  $('stage').classList.toggle('split', on)
  $('gl2').hidden = !on
  if (on) await ensureCompareViewer()
  // o ResizeObserver do NiiVue reage à mudança de layout; força um quadro por garantia
  requestAnimationFrame(() => {
    try { state.nv.drawScene(); state.nv2?.drawScene() } catch { /* canvas ainda sem tamanho */ }
  })
  markActiveThumbs()
  if (!on) log('Comparação encerrada.')
}

async function compareSeries(id) {
  const entry = state.series.find((s) => s.id === id)
  if (!entry) return
  if (!state.compare) await setCompare(true)
  log(`Comparando com ${entry.file.name}…`); progress(0.3)
  try {
    let vol = await volumeFor(entry)
    // mesma série nos dois painéis: clona para não compartilhar o NVImage entre contextos GL
    if (state.nv.volumes.includes(vol)) vol = vol.clone()
    const nv2 = state.nv2
    while (nv2.volumes.length) nv2.removeVolume(nv2.volumes[0])
    await nv2.addVolume(vol)
    state.rightId = id
    const v = nv2.volumes[0]
    if (entry.sidecar.Modality === 'CT') { v.cal_min = 0; v.cal_max = 80 }
    else { v.cal_min = v.robust_min ?? v.global_min; v.cal_max = v.robust_max ?? v.global_max }
    nv2.updateGLVolume()
    markActiveThumbs()
    progress(0)
    log(`Comparando: ${entry.file.name} à direita — cursor e scroll sincronizados em mm.`)
  } catch (err) {
    console.error(err); progress(0)
    log('Falha na comparação: ' + err.message)
  }
}

function markActiveThumbs() {
  document.querySelectorAll('.thumb').forEach((t) => {
    t.classList.toggle('active', t.id === `th-${state.activeId}`)
    t.classList.toggle('active-cmp', state.compare && t.id === `th-${state.rightId}`)
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
  for (const nv of [state.nv, state.nv2].filter(Boolean)) {
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
  for (const nv of [state.nv, state.nv2].filter(Boolean)) {
    const t = {
      mpr: nv.sliceTypeMultiplanar, axial: nv.sliceTypeAxial,
      coronal: nv.sliceTypeCoronal, sagittal: nv.sliceTypeSagittal, render: nv.sliceTypeRender,
    }[view]
    nv.setSliceType(t)
  }
  $('panel3d').hidden = view !== 'render'
  if (view === 'render') applyIllumination()
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
    item.onclick = () => openSeries(e.id)
    item.oncontextmenu = (ev) => { ev.preventDefault(); compareSeries(e.id) }
    item.title = `${sc.SeriesDescription || e.file.name} — clique: abrir · clique direito: comparar lado a lado`
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
    for (const k of state.cache.keys()) {
      if (state.cache.size <= 4) break
      if (k !== entry.id && k !== state.activeId && k !== state.rightId) state.cache.delete(k)
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
    // mesma série nos dois painéis: clona para não compartilhar o NVImage entre contextos GL
    if (state.nv2?.volumes.includes(vol)) vol = vol.clone()
    const nv = state.nv
    while (nv.volumes.length) nv.removeVolume(nv.volumes[0])
    await nv.addVolume(vol)
    state.vol = vol
    state.origVol = vol
    state.mipVol = null
    state.activeId = id
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

  $('btnCompare').onclick = async () => {
    if (!state.series.length) { log('Abra ao menos uma série antes de comparar.'); return }
    if (state.compare) { setCompare(false); return }
    await setCompare(true)
    if (!state.rightId) {
      // sugere a próxima série do estudo (ou repete a ativa, se for a única)
      const other = state.series.find((s) => s.id !== state.activeId) || state.series[0]
      await compareSeries(other.id)
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
    for (const nv of [state.nv, state.nv2].filter(Boolean)) {
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
window.lume = { state, openSeries, compareSeries, setCompare, handleFiles, VERSION } // acesso programático / testes
log(`Lume v${VERSION} — pronto. Abra uma pasta DICOM, NIfTI ou ZIP.`)
