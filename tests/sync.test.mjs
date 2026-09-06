import { test } from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'

// Execute the application functions without starting WebGL or the DOM bootstrap.
const source = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8')
function fn(name) {
  const start = source.search(new RegExp(`(?:async )?function ${name}\\(`))
  const end = source.indexOf('\n}', start) + 2
  assert.ok(start >= 0 && end > start, name)
  return source.slice(start, end)
}
function setup() {
  const state = { panels: [], layout: 2, focus: 0, syncPosition: true, syncZoom: true, series: [] }
  const ctx = vm.createContext({ state, console, Array, Number, VIEW_AXIS: { axial: 2, coronal: 1, sagittal: 0, mpr: 2 },
    log() {}, progress() {}, markActiveThumbs() {}, applyPanelView() {},
  })
  vm.runInContext(['rewireSync', 'positionForLoad', 'restorePosition', 'propagateCrosshair', 'stepSlice', 'loadIntoPanel'].map(fn).join('\n'), ctx)
  return { state, ctx }
}
function panel(origin = 0, spacing = 1, dim = 100) {
  const nv = {
    volumes: [{ dimsRAS: [3, dim, dim, dim] }], scene: { crosshairPos: [0.5, 0.5, 0.5] },
    frac2mm: (f) => f.map((x) => origin + (x * dim - 0.5) * spacing),
    mm2frac: (mm) => mm.map((x) => ((x - origin) / spacing + 0.5) / dim),
    broadcastTo(others, opts) { this.otherNV = others; this.syncOpts = opts },
    drawScene() {}, createOnLocationChange() {}, updateGLVolume() {},
    removeVolume(v) { this.volumes.splice(this.volumes.indexOf(v), 1) },
    addVolume(v) { this.volumes.push(v) },
  }
  return { nv, view: 'axial', loadSeq: 0, loading: false, id: 'old' }
}
const close = (a, b) => a.forEach((x, i) => assert.ok(Math.abs(x - b[i]) < 1e-6, `${a} != ${b}`))

test('same physical position across different origins, spacing and dimensions', () => {
  const { state, ctx } = setup()
  const a = panel(), b = panel(-20, 2, 60)
  state.panels = [a, b]
  a.nv.scene.crosshairPos = [0.1, 0.3, 0.8]
  ctx.propagateCrosshair(a)
  close(b.nv.frac2mm(b.nv.scene.crosshairPos), a.nv.frac2mm(a.nv.scene.crosshairPos))
  assert.notDeepEqual(b.nv.scene.crosshairPos, a.nv.scene.crosshairPos)
})
test('disabled position link leaves comparison untouched', () => {
  const { state, ctx } = setup()
  const a = panel(), b = panel()
  state.panels = [a, b]; state.syncPosition = false
  a.nv.scene.crosshairPos = [0.2, 0.3, 0.4]
  ctx.propagateCrosshair(a)
  close(b.nv.scene.crosshairPos, [0.5, 0.5, 0.5])
})
test('out-of-coverage positions are not clamped to a false correspondence', () => {
  const { state, ctx } = setup()
  const a = panel(), b = panel(200)
  state.panels = [a, b]
  ctx.propagateCrosshair(a)
  assert.ok(b.nv.scene.crosshairPos[0] < 0)
  close(b.nv.frac2mm(b.nv.scene.crosshairPos), a.nv.frac2mm(a.nv.scene.crosshairPos))
})
test('rewiring excludes hidden, empty and loading viewers and keeps contrast independent', () => {
  const { state, ctx } = setup()
  state.panels = [panel(), panel(), panel()]
  ctx.rewireSync()
  assert.equal(state.panels[0].nv.otherNV.length, 1)
  assert.equal(state.panels[2].nv.otherNV.length, 0)
  assert.equal(state.panels[0].nv.syncOpts.cal_min, undefined)
  state.panels[1].loading = true
  ctx.rewireSync()
  assert.equal(state.panels[0].nv.otherNV.length, 0)
  state.panels[1].loading = false; state.panels[1].nv.volumes = []
  ctx.rewireSync()
  assert.equal(state.panels[0].nv.otherNV.length, 0)
})
test('MPR stepping uses selected tile axis and stops at voxel centers', () => {
  const { state, ctx } = setup(); const a = panel()
  state.panels = [a]; a.view = 'mpr'
  ctx.stepSlice(a, 1, 0)
  close(a.nv.scene.crosshairPos, [0.51, 0.5, 0.5])
  ctx.stepSlice(a, 1000, 1)
  close(a.nv.scene.crosshairPos, [0.51, 0.995, 0.5])
})
test('series replacement preserves focused physical location or own location when unlinked', () => {
  const { state, ctx } = setup(); const a = panel(), b = panel(-20, 2, 60)
  state.panels = [a, b]; state.focus = 1
  const mm = ctx.positionForLoad(a)
  close(mm, b.nv.frac2mm(b.nv.scene.crosshairPos))
  ctx.restorePosition(a, mm)
  close(a.nv.frac2mm(a.nv.scene.crosshairPos), mm)
  state.syncPosition = false
  close(ctx.positionForLoad(b), b.nv.frac2mm(b.nv.scene.crosshairPos))
})
test('latest comparison selection wins even when an earlier load finishes last', async () => {
  const { state, ctx } = setup(); state.panels = [panel(), panel()]
  state.series = ['slow', 'fast'].map((id) => ({ id, file: { name: id }, sidecar: {} }))
  let resolveSlow
  ctx.volumeFor = (entry) => entry.id === 'slow' ? new Promise((r) => { resolveSlow = r }) : Promise.resolve({ name: 'fast' })
  const slow = ctx.loadIntoPanel(1, 'slow')
  await ctx.loadIntoPanel(1, 'fast')
  resolveSlow({ name: 'slow' }); await slow
  assert.equal(state.panels[1].id, 'fast')
  assert.equal(state.panels[1].nv.volumes[0].name, 'fast')
})
test('closing a panel cancels a pending volume load', async () => {
  const { state, ctx } = setup(); state.panels = [panel(), panel()]
  state.series = [{ id: 'slow', file: { name: 'slow' }, sidecar: {} }]
  let resolve
  ctx.volumeFor = () => new Promise((r) => { resolve = r })
  const pending = ctx.loadIntoPanel(1, 'slow')
  state.layout = 1; state.panels[1].loadSeq++; state.panels[1].nv.volumes = []
  resolve({ name: 'slow' }); await pending
  assert.equal(state.panels[1].nv.volumes.length, 0)
})

test('bundled NiiVue preserves mm across oblique anisotropic NIfTI affines', async () => {
  const { NVImage } = await import('../vendor/niivue.min.js')
  async function image(angle, spacing, origin) {
    const dim = 16, buffer = new ArrayBuffer(352 + dim ** 3)
    const h = new DataView(buffer)
    h.setInt32(0, 348, true)
    ;[3, dim, dim, dim, 1, 1, 1, 1].forEach((v, i) => h.setInt16(40 + i * 2, v, true))
    h.setInt16(70, 2, true); h.setInt16(72, 8, true)
    ;[1, ...spacing, 1, 1, 1, 1].forEach((v, i) => h.setFloat32(76 + i * 4, v, true))
    h.setFloat32(108, 352, true); h.setFloat32(112, 1, true)
    h.setUint8(123, 2); h.setInt16(254, 1, true)
    const c = Math.cos(angle), s = Math.sin(angle)
    const affine = [[c * spacing[0], -s * spacing[1], 0, origin[0]], [s * spacing[0], c * spacing[1], 0, origin[1]], [0, 0, spacing[2], origin[2]]]
    affine.flat().forEach((v, i) => h.setFloat32(280 + i * 4, v, true))
    new Uint8Array(buffer, 344, 4).set([110, 43, 49, 0])
    new Uint8Array(buffer, 352).forEach((_, i, data) => { data[i] = i % 251 })
    return NVImage.new(buffer, 'synthetic.nii')
  }
  const volumes = await Promise.all([image(0, [1, 1, 1], [-8, -8, -8]), image(0.35, [0.7, 1.2, 3], [-5, -6, -12])])
  const { state, ctx } = setup()
  state.panels = volumes.map((v) => {
    const p = panel(); p.nv.volumes = [v]
    p.nv.frac2mm = (f) => v.convertFrac2MM(f)
    p.nv.mm2frac = (mm) => v.convertMM2Frac(mm)
    return p
  })
  const [a, b] = state.panels
  a.nv.scene.crosshairPos = [0.3, 0.6, 0.7]
  ctx.propagateCrosshair(a)
  close(Array.from(b.nv.frac2mm(b.nv.scene.crosshairPos)).slice(0, 3), Array.from(a.nv.frac2mm(a.nv.scene.crosshairPos)).slice(0, 3))
})

test('MPR browse gesture dispatches sagittal drag to the RAS x axis', () => {
  const { state, ctx } = setup(); const a = panel()
  const handlers = {}
  a.view = 'mpr'; state.panels = [a]; state.mouse = { left: 'browse' }
  a.canvas = {
    width: 400, clientWidth: 400,
    addEventListener(name, handler) { handlers[name] = handler },
    setPointerCapture() {}, getBoundingClientRect: () => ({ left: 0, top: 0 }),
  }
  a.nv.tileIndex = () => 0
  a.nv.screenSlices = [{ axCorSag: 2 }]
  ctx.ACTIONS = { browse: { native: false, emul: true } }
  vm.runInContext([fn('gestureOf'), fn('installPanelGestures')].join('\n'), ctx)
  ctx.installPanelGestures(a, 0)
  const event = { button: 0, pointerId: 1, clientX: 100, clientY: 100, preventDefault() {}, stopImmediatePropagation() {} }
  handlers.pointerdown(event)
  handlers.pointermove({ ...event, clientY: 90 })
  close(a.nv.scene.crosshairPos, [0.52, 0.5, 0.5])
})

test('zoom can be unlinked while physical position remains linked', () => {
  const { state, ctx } = setup(); state.panels = [panel(), panel()]
  state.syncZoom = false; ctx.rewireSync()
  const options = state.panels[0].nv.syncOpts
  assert.equal(options.crosshair, true)
  assert.equal(options.zoomPan, false)
  assert.equal(options['3d'], false)
})
