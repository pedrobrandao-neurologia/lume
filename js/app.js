// app.js — Lume: visualizador DICOM/NIfTI 100% no navegador.
// Leitor DICOM e conversão reaproveitados do MorfoStudio/SegmentaRM
// (dcm2niix WASM); renderização com NiiVue (WebGL2).

import { Niivue, NVImage, DRAG_MODE } from '../vendor/niivue.min.js'
import { ingest, filesFromDrop } from './ingest.js'
import { makeThumb } from './thumbs.js'
import { slabMip, axisLabels } from './mip.js'

const $ = (id) => document.getElementById(id)
const VERSION = '0.1.0'

const state = {
  nv: null,
  series: [],          // SeriesEntry[]
  activeId: null,
  vol: null,           // NVImage original da série ativa
  mipVol: null,        // NVImage derivado (slab MIP), quando ativo
  cache: new Map(),    // id → NVImage (limitado, para trocar de série sem reconverter)
  measures: [],
  tool: 'crosshair',
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
  nv.opts.dragMode = DRAG_MODE.windowing // botão direito: janela, como numa workstation
  nv.opts.yoke3Dto2DZoom = true

  nv.onLocationChange = (d) => { $('statusLoc').textContent = d?.string || '' }
  nv.onIntensityChange = () => syncWindowInputs()
  $('gl').addEventListener('pointerdown', (e) => { state.lastButton = e.button })
  nv.onDragRelease = (p) => {
    if (state.tool === 'measurement' && state.lastButton === 0 && p?.mmLength > 0.5) {
      state.measures.push(p.mmLength)
      renderMeasures()
    }
  }
  state.nv = nv
}

function setTool(tool) {
  state.tool = tool
  const nv = state.nv
  const modes = {
    crosshair: DRAG_MODE.crosshair,
    windowing: DRAG_MODE.windowing,
    measurement: DRAG_MODE.measurement,
    angle: DRAG_MODE.angle,
    pan: DRAG_MODE.pan,
  }
  nv.opts.dragModePrimary = modes[tool] ?? DRAG_MODE.crosshair
  document.querySelectorAll('.tool[data-tool]').forEach((b) =>
    b.classList.toggle('active', b.dataset.tool === tool))
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
    item.innerHTML = `<figure style="margin:0"><div class="ph"></div>
      <figcaption><strong title="${title}">${title}</strong>
      <span>${mod ? `<span class="badge">${mod}</span>` : ''}<span class="dims mono"></span></span>
      </figcaption></figure>`
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
  document.querySelectorAll('.tool[data-tool]').forEach((b) => (b.onclick = () => setTool(b.dataset.tool)))
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
    if (map[k] && !e.metaKey && !e.ctrlKey && !/^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName)) setTool(map[k])
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
