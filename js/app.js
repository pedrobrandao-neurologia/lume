// app.js — Lume: visualizador DICOM/NIfTI 100% no navegador.
// Leitor DICOM e conversão reaproveitados do MorfoStudio/SegmentaRM
// (dcm2niix WASM); renderização com NiiVue (WebGL2).

import { Niivue, NVImage, DRAG_MODE } from '../vendor/niivue.min.js'
import { ingest, filesFromDrop } from './ingest.js'
import { makeThumb } from './thumbs.js'
import { slabMip, axisLabels } from './mip.js'

const $ = (id) => document.getElementById(id)
const VERSION = '0.2.0'

const state = {
  nv: null,
  series: [],          // SeriesEntry[]
  activeId: null,
  vol: null,           // NVImage original da série ativa
  mipVol: null,        // NVImage derivado (slab MIP), quando ativo
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
  const nv = state.nv
  nv.opts.dragModePrimary = TOOL_MODES[state.mouse.left]
  nv.opts.dragMode = TOOL_MODES[state.mouse.right]
  nv.opts.mouseEventConfig = {
    leftButton: { primary: TOOL_MODES[state.mouse.left] },
    rightButton: TOOL_MODES[state.mouse.right],
    centerButton: TOOL_MODES[state.mouse.middle],
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
  const nv = state.nv
  const t = {
    mpr: nv.sliceTypeMultiplanar, axial: nv.sliceTypeAxial,
    coronal: nv.sliceTypeCoronal, sagittal: nv.sliceTypeSagittal, render: nv.sliceTypeRender,
  }[view]
  nv.setSliceType(t)
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
    $('seriesList').appendChild(item)
    makeThumb(e.file).then(({ canvas, hdr }) => {
      item.querySelector('.ph').replaceWith(canvas)
      item.querySelector('.dims').textContent =
        ` ${hdr.nx}×${hdr.ny}×${hdr.nz} · ${fmt(hdr.dx)}×${fmt(hdr.dy)} mm`
    }).catch(() => { /* miniatura é opcional */ })
  }
  $('stripCount').textContent = state.series.length
}

async function openSeries(id) {
  const entry = state.series.find((s) => s.id === id)
  if (!entry) return
  log(`Abrindo ${entry.file.name}…`); progress(0.3)
  try {
    let vol = state.cache.get(id)
    if (!vol) {
      vol = await NVImage.loadFromFile({ file: entry.file, name: entry.file.name })
      state.cache.set(id, vol)
      // limita o cache a 3 volumes para conter a memória
      for (const k of state.cache.keys()) {
        if (state.cache.size <= 3) break
        if (k !== id) state.cache.delete(k)
      }
    }
    const nv = state.nv
    while (nv.volumes.length) nv.removeVolume(nv.volumes[0])
    await nv.addVolume(vol)
    state.vol = vol
    state.mipVol = null
    state.activeId = id
    $('btnMipOff').hidden = true
    $('dropzone').classList.add('hidden')
    document.querySelectorAll('.thumb').forEach((t) => t.classList.toggle('active', t.id === `th-${id}`))

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
  const mm = Math.max(1, Number($('mipMM').value) || 12)
  const pd = Math.abs(vol.hdr.pixDims[axis + 1]) || 1
  const slabVox = Math.max(1, Math.round(mm / pd))
  log(`Calculando MIP (${mm} mm ≈ ${slabVox} voxels)…`); progress(0.4)
  await new Promise((r) => setTimeout(r)) // deixa a barra pintar antes do laço pesado
  try {
    const dims = vol.hdr.dims.slice(1, 4)
    // volumes 4D: projeta apenas o primeiro volume temporal
    const nvox = dims[0] * dims[1] * dims[2]
    const src = vol.img.length > nvox ? vol.img.subarray(0, nvox) : vol.img
    const out = slabMip(src, dims, axis, slabVox)
    const mip = vol.clone()
    mip.zeroImage()
    mip.img = out
    if (mip.hdr.dims[0] >= 4) { mip.hdr.dims[0] = 3; mip.hdr.dims[4] = 1 }
    mip.name = `MIP ${mm}mm — ${vol.name}`
    mip.cal_min = vol.cal_min; mip.cal_max = vol.cal_max
    const nv = state.nv
    while (nv.volumes.length) nv.removeVolume(nv.volumes[0])
    await nv.addVolume(mip)
    state.mipVol = mip
    $('btnMipOff').hidden = false
    progress(0)
    log(`MIP de ${mm} mm aplicado — “Voltar ao original” desfaz.`)
  } catch (err) {
    console.error(err); progress(0); log('MIP falhou: ' + err.message)
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
  $('illum').onchange = applyIllumination
  $('clip').oninput = () => {
    const d = Number($('clip').value)
    state.nv.setClipPlane([d > 1 ? 2 : d, 270, 0])
  }

  $('btnClearMeasures').onclick = () => { state.measures = []; renderMeasures() }
  $('btnReset').onclick = () => {
    const nv = state.nv
    nv.scene.pan2Dxyzmm = [0, 0, 0, 1]
    autoWindow()
    nv.drawScene()
  }
  $('btnShot').onclick = () => state.nv.saveScene(`lume-${Date.now()}.png`)

  window.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase()
    const map = { c: 'crosshair', j: 'windowing', m: 'measurement', a: 'angle', v: 'pan' }
    if (map[k] && !e.metaKey && !e.ctrlKey && !/^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName)) assignTool('left', map[k])
  })
}

/* ---------------- inicialização ---------------- */
await initViewer()
bind()
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('./sw.js').catch(() => {})
}
window.lume = { state, openSeries, handleFiles, VERSION } // acesso programático / testes
log(`Lume v${VERSION} — pronto. Abra uma pasta DICOM, NIfTI ou ZIP.`)
