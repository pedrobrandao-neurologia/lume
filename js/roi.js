// roi.js — ROIs sobre o painel principal: elipse e laço (traçado livre),
// com caneta magnética (ajuste à borda de maior gradiente) e desenho pelo
// teclado. A estatística (média, DP, mín, máx, área) amostra o volume em
// exibição no espaço mm da própria fatia, independente do zoom da tela.

const AXIS = [
  { u: 0, v: 1, n: 2 }, // axial:    x (L–R) × y (A–P), normal z
  { u: 0, v: 2, n: 1 }, // coronal:  x (L–R) × z (S–I), normal y
  { u: 1, v: 2, n: 0 }, // sagital:  y (A–P) × z (S–I), normal x
]

export function createRoiTool({ nv, overlay, glCanvas, getVol, onChange, onArmChange, isMagnet, log }) {
  const rois = []            // {kind, acs, planeMM, pts|{c,a,b}, stats}
  let armed = null           // null | 'ellipse' | 'lasso'
  let draw = null            // desenho em curso (mouse)
  let kb = null              // cursor do desenho por teclado {px, pts, acs}
  let selected = -1
  const ctx = overlay.getContext('2d')

  /* ---------- conversões ---------- */
  const dpr = () => overlay.width / (overlay.clientWidth || 1)
  const evPx = (e) => [e.offsetX * dpr(), e.offsetY * dpr()]

  function pxInfo(px) { // canvas px → {frac, mm, acs} ou null
    const frac = nv.canvasPos2frac(px)
    if (!frac || frac[0] < 0) return null
    const idx = nv.tileIndex(px[0], px[1])
    const acs = nv.screenSlices[idx]?.axCorSag
    if (acs === undefined || acs > 2) return null
    const mm = nv.frac2mm(frac)
    return { frac, mm: [mm[0], mm[1], mm[2]], acs }
  }

  // mm → px na tela, no tile do plano acs (mesma projeção do NiiVue)
  function mmToPx(mm, acs) {
    for (const s of nv.screenSlices) {
      if (s.axCorSag !== acs || !s.fovMM?.[0]) continue
      let x = mm[0], y = mm[1]
      if (acs === 1) { x = mm[0]; y = mm[2] }
      else if (acs === 2) { x = mm[1]; y = mm[2] }
      const fx = (x - s.leftTopMM[0]) / s.fovMM[0]
      const fy = (y - s.leftTopMM[1]) / s.fovMM[1]
      const ltwh = s.leftTopWidthHeight.slice()
      let mirror = false
      if (ltwh[2] < 0) { mirror = true; ltwh[0] += ltwh[2]; ltwh[2] = -ltwh[2] }
      return {
        x: ltwh[0] + (mirror ? 1 - fx : fx) * ltwh[2],
        y: ltwh[1] + (1 - fy) * ltwh[3],
        tile: ltwh,
      }
    }
    return null
  }

  function valueAtMM(mm) {
    const vol = getVol()
    if (!vol) return null
    const frac = nv.mm2frac(mm)
    if (frac[0] < 0 || frac[0] > 1 || frac[1] < 0 || frac[1] > 1 || frac[2] < 0 || frac[2] > 1) return null
    const vox = nv.frac2vox(frac)
    return vol.getValue(vox[0], vox[1], vox[2])
  }
  const valueAtPx = (px) => { const i = pxInfo(px); return i ? valueAtMM(i.mm) : null }

  /* ---------- caneta magnética ---------- */
  // desloca o ponto para a borda (maior gradiente) na direção normal ao traço
  function snapMagnet(px, prevPx) {
    const dx = px[0] - prevPx[0], dy = px[1] - prevPx[1]
    const len = Math.hypot(dx, dy) || 1
    const n = [-dy / len, dx / len]
    const R = 7 * Math.max(1, dpr())
    const s = 2 * Math.max(1, dpr())
    let best = px, bestG = -1
    for (let t = -R; t <= R; t += Math.max(1, R / 7)) {
      const q = [px[0] + n[0] * t, px[1] + n[1] * t]
      const a = valueAtPx([q[0] + n[0] * s, q[1] + n[1] * s])
      const b = valueAtPx([q[0] - n[0] * s, q[1] - n[1] * s])
      if (a === null || b === null) continue
      const g = Math.abs(a - b)
      if (g > bestG) { bestG = g; best = q }
    }
    return best
  }

  /* ---------- geometria em coordenadas do plano (mm) ---------- */
  const toUV = (mm, ax) => [mm[AXIS[ax.acs ?? 0].u], mm[AXIS[ax.acs ?? 0].v]]
  function shoelace(pts) {
    let a = 0
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i], q = pts[(i + 1) % pts.length]
      a += p[0] * q[1] - q[0] * p[1]
    }
    return Math.abs(a) / 2
  }
  function insidePoly(pts, u, v) {
    let inside = false
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [xi, yi] = pts[i], [xj, yj] = pts[j]
      if ((yi > v) !== (yj > v) && u < ((xj - xi) * (v - yi)) / (yj - yi) + xi) inside = !inside
    }
    return inside
  }

  /* ---------- estatística ---------- */
  function computeStats(roi) {
    const vol = getVol()
    if (!vol) return null
    const ax = AXIS[roi.acs]
    const pd = vol.pixDimsRAS || vol.hdr.pixDims
    const step = Math.max(0.2, Math.min(Math.abs(pd[ax.u + 1]) || 1, Math.abs(pd[ax.v + 1]) || 1))
    let u0, u1, v0, v1, inside, areaMM
    if (roi.kind === 'ellipse') {
      const { c, a, b } = roi
      u0 = c[0] - a; u1 = c[0] + a; v0 = c[1] - b; v1 = c[1] + b
      inside = (u, v) => ((u - c[0]) / a) ** 2 + ((v - c[1]) / b) ** 2 <= 1
      areaMM = Math.PI * a * b
    } else {
      const us = roi.pts.map((p) => p[0]), vs = roi.pts.map((p) => p[1])
      u0 = Math.min(...us); u1 = Math.max(...us); v0 = Math.min(...vs); v1 = Math.max(...vs)
      inside = (u, v) => insidePoly(roi.pts, u, v)
      areaMM = shoelace(roi.pts)
    }
    let n = 0, sum = 0, sum2 = 0, min = Infinity, max = -Infinity
    const mm = [0, 0, 0]
    mm[ax.n] = roi.planeMM
    for (let v = v0; v <= v1; v += step) {
      for (let u = u0; u <= u1; u += step) {
        if (!inside(u, v)) continue
        mm[ax.u] = u; mm[ax.v] = v
        const val = valueAtMM(mm)
        if (val === null) continue
        n++; sum += val; sum2 += val * val
        if (val < min) min = val
        if (val > max) max = val
      }
    }
    if (!n) return null
    const mean = sum / n
    const sd = Math.sqrt(Math.max(0, sum2 / n - mean * mean))
    return { mean, sd, min, max, n, areaMM }
  }

  /* ---------- ciclo de vida das ROIs ---------- */
  function finishRoi(roi) {
    roi.stats = computeStats(roi)
    if (!roi.stats) { log?.('ROI fora do volume — descartada.'); return }
    rois.push(roi)
    selected = rois.length - 1
    onChange?.(rois, selected)
  }

  function arm(kind) {
    armed = armed === kind ? null : kind
    draw = null; kb = null
    glCanvas.style.cursor = armed ? 'crosshair' : ''
    onArmChange?.(armed) // mantém os botões da barra coerentes com o estado real
    return armed
  }
  const disarm = () => {
    const was = armed
    armed = null; draw = null; kb = null
    glCanvas.style.cursor = ''
    if (was) onArmChange?.(null)
  }

  function removeSelected() {
    if (selected < 0) return
    rois.splice(selected, 1)
    selected = rois.length - 1
    onChange?.(rois, selected)
  }
  const clear = () => { rois.length = 0; selected = -1; onChange?.(rois, selected) }
  const select = (i) => { selected = i; onChange?.(rois, selected) }

  /* ---------- mouse ----------
     Os handlers ficam no próprio canvas (o overlay nunca recebe ponteiro):
     assim a ROI intercepta apenas o botão esquerdo, e roda, botão direito e
     do meio continuam percorrendo cortes, dando zoom e janelando. */
  glCanvas.addEventListener('pointerdown', (e) => {
    if (!armed || e.button !== 0) return
    const info = pxInfo(evPx(e))
    if (!info) return
    e.preventDefault(); e.stopImmediatePropagation() // impede o NiiVue de arrastar junto
    glCanvas.setPointerCapture(e.pointerId)
    const ax = AXIS[info.acs]
    const uv = [info.mm[ax.u], info.mm[ax.v]]
    draw = { kind: armed, acs: info.acs, planeMM: info.mm[ax.n], start: uv, cur: uv, pts: [uv], lastPx: evPx(e) }
  }, true)
  glCanvas.addEventListener('pointermove', (e) => {
    if (!draw) return
    e.preventDefault(); e.stopImmediatePropagation()
    let px = evPx(e)
    if (draw.kind === 'lasso' && isMagnet?.() && Math.hypot(px[0] - draw.lastPx[0], px[1] - draw.lastPx[1]) > 2) {
      px = snapMagnet(px, draw.lastPx)
    }
    const info = pxInfo(px)
    if (!info || info.acs !== draw.acs) return
    const ax = AXIS[draw.acs]
    const uv = [info.mm[ax.u], info.mm[ax.v]]
    draw.cur = uv
    if (draw.kind === 'lasso') {
      const last = draw.pts[draw.pts.length - 1]
      if (Math.hypot(uv[0] - last[0], uv[1] - last[1]) > 0.4) { draw.pts.push(uv); draw.lastPx = px }
    }
  }, true)
  glCanvas.addEventListener('pointerup', (e) => {
    if (!draw || e.button !== 0) return
    e.preventDefault(); e.stopImmediatePropagation()
    const d = draw; draw = null
    if (d.kind === 'ellipse') {
      const a = Math.abs(d.cur[0] - d.start[0]) / 2, b = Math.abs(d.cur[1] - d.start[1]) / 2
      if (a < 0.5 || b < 0.5) return
      finishRoi({ kind: 'ellipse', acs: d.acs, planeMM: d.planeMM, c: [(d.start[0] + d.cur[0]) / 2, (d.start[1] + d.cur[1]) / 2], a, b })
    } else {
      if (d.pts.length < 3 || shoelace(d.pts) < 1) return
      finishRoi({ kind: 'lasso', acs: d.acs, planeMM: d.planeMM, pts: d.pts })
    }
  })

  /* ---------- teclado (desenho de laço ponto a ponto) ---------- */
  window.addEventListener('keydown', (e) => {
    if (!armed) {
      if (e.key === 'Delete' && selected >= 0 && !/^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName)) removeSelected()
      return
    }
    const KEYS = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' ', 'Enter', 'Backspace', 'Escape', 'Delete']
    if (!KEYS.includes(e.key)) return
    e.preventDefault(); e.stopPropagation()
    if (e.key === 'Escape') {
      if (kb || draw) { kb = null; draw = null; log?.('Desenho cancelado.') }
      else disarm()
      onChange?.(rois, selected)
      return
    }
    if (e.key === 'Delete') { removeSelected(); return }
    if (armed !== 'lasso') { log?.('Desenho pelo teclado: use a ferramenta ✎ Laço.'); return }
    if (!kb) {
      // cursor inicial: projeção do crosshair (ou centro do canvas)
      const p = nv.frac2canvasPos(nv.scene.crosshairPos)
      kb = { px: p ? [p[0], p[1]] : [overlay.width / 2, overlay.height / 2], pts: [], acs: null, planeMM: 0 }
    }
    const step = (e.shiftKey ? 10 : 2) * Math.max(1, dpr())
    if (e.key === 'ArrowUp') kb.px[1] -= step
    else if (e.key === 'ArrowDown') kb.px[1] += step
    else if (e.key === 'ArrowLeft') kb.px[0] -= step
    else if (e.key === 'ArrowRight') kb.px[0] += step
    else if (e.key === ' ') {
      let px = kb.px.slice()
      if (isMagnet?.() && kb.pts.length) {
        const prev = mmToPxUV(kb, kb.pts[kb.pts.length - 1])
        if (prev) px = snapMagnet(px, [prev.x, prev.y])
      }
      const info = pxInfo(px)
      if (!info) { log?.('Cursor fora da imagem.'); return }
      if (kb.acs === null) { kb.acs = info.acs; kb.planeMM = info.mm[AXIS[info.acs].n] }
      if (info.acs !== kb.acs) { log?.('Mantenha os pontos no mesmo corte.'); return }
      const ax = AXIS[kb.acs]
      kb.pts.push([info.mm[ax.u], info.mm[ax.v]])
      kb.px = px
    } else if (e.key === 'Backspace') kb.pts.pop()
    else if (e.key === 'Enter') {
      if (kb.pts.length >= 3 && shoelace(kb.pts) >= 1) {
        finishRoi({ kind: 'lasso', acs: kb.acs, planeMM: kb.planeMM, pts: kb.pts })
      } else log?.('São necessários ao menos 3 pontos.')
      kb = null
    }
  }, true)

  function mmToPxUV(roiLike, uv) {
    const ax = AXIS[roiLike.acs ?? 0]
    const mm = [0, 0, 0]
    mm[ax.n] = roiLike.planeMM; mm[ax.u] = uv[0]; mm[ax.v] = uv[1]
    return mmToPx(mm, roiLike.acs ?? 0)
  }

  /* ---------- desenho do overlay ---------- */
  function tracePoly(roiLike, uvPts, close) {
    let tile = null
    ctx.beginPath()
    let first = true
    for (const uv of uvPts) {
      const p = mmToPxUV(roiLike, uv)
      if (!p) return null
      tile = p.tile
      if (first) { ctx.moveTo(p.x, p.y); first = false } else ctx.lineTo(p.x, p.y)
    }
    if (close) ctx.closePath()
    return tile
  }

  function ellipseUVs(c, a, b, n = 48) {
    const pts = []
    for (let i = 0; i < n; i++) {
      const t = (i / n) * Math.PI * 2
      pts.push([c[0] + a * Math.cos(t), c[1] + b * Math.sin(t)])
    }
    return pts
  }

  function visible(roi) {
    const vol = getVol()
    if (!vol) return false
    const mm = nv.frac2mm(nv.scene.crosshairPos)
    const pd = vol.pixDimsRAS || vol.hdr.pixDims
    const ax = AXIS[roi.acs]
    return Math.abs(mm[ax.n] - roi.planeMM) <= Math.max(0.5, Math.abs(pd[ax.n + 1]) || 1) * 0.6
  }

  function render() {
    // acompanha o tamanho e a posição do canvas WebGL do painel esquerdo
    if (overlay.width !== glCanvas.width || overlay.height !== glCanvas.height) {
      overlay.width = glCanvas.width; overlay.height = glCanvas.height
    }
    const st = overlay.style, r = glCanvas.getBoundingClientRect(), pr = overlay.parentElement.getBoundingClientRect()
    const left = `${r.left - pr.left}px`, top = `${r.top - pr.top}px`, w = `${r.width}px`, h = `${r.height}px`
    if (st.left !== left) st.left = left
    if (st.top !== top) st.top = top
    if (st.width !== w) st.width = w
    if (st.height !== h) st.height = h

    ctx.clearRect(0, 0, overlay.width, overlay.height)
    const lw = Math.max(1, dpr())
    rois.forEach((roi, i) => {
      if (!visible(roi)) return
      ctx.save()
      ctx.lineWidth = i === selected ? lw * 2 : lw
      ctx.strokeStyle = i === selected ? '#f2b441' : 'rgba(242,180,65,0.8)'
      const uvs = roi.kind === 'ellipse' ? ellipseUVs(roi.c, roi.a, roi.b) : roi.pts
      const tile = tracePoly(roi, uvs, true)
      if (tile) {
        ctx.stroke()
        const c0 = roi.kind === 'ellipse' ? roi.c : uvs[0]
        const p = mmToPxUV(roi, c0)
        if (p) {
          ctx.fillStyle = '#f2b441'
          ctx.font = `${11 * dpr()}px monospace`
          ctx.fillText(`${i + 1}`, p.x + 4 * dpr(), p.y - 4 * dpr())
        }
      }
      ctx.restore()
    })
    // desenho em curso (mouse)
    if (draw) {
      ctx.save()
      ctx.lineWidth = lw
      ctx.setLineDash([4 * lw, 3 * lw])
      ctx.strokeStyle = '#4fb3bf'
      if (draw.kind === 'ellipse') {
        const c = [(draw.start[0] + draw.cur[0]) / 2, (draw.start[1] + draw.cur[1]) / 2]
        const a = Math.abs(draw.cur[0] - draw.start[0]) / 2 || 0.1
        const b = Math.abs(draw.cur[1] - draw.start[1]) / 2 || 0.1
        if (tracePoly(draw, ellipseUVs(c, a, b), true)) ctx.stroke()
      } else if (tracePoly(draw, draw.pts, false)) ctx.stroke()
      ctx.restore()
    }
    // desenho em curso (teclado)
    if (kb) {
      ctx.save()
      ctx.lineWidth = lw
      ctx.strokeStyle = '#4fb3bf'
      if (kb.pts.length && kb.acs !== null) {
        ctx.setLineDash([4 * lw, 3 * lw])
        const tile = tracePoly(kb, kb.pts, false)
        if (tile) {
          const last = mmToPxUV(kb, kb.pts[kb.pts.length - 1])
          if (last) { ctx.lineTo(kb.px[0], kb.px[1]) }
          ctx.stroke()
        }
      }
      ctx.setLineDash([])
      const s = 7 * lw
      ctx.beginPath()
      ctx.moveTo(kb.px[0] - s, kb.px[1]); ctx.lineTo(kb.px[0] + s, kb.px[1])
      ctx.moveTo(kb.px[0], kb.px[1] - s); ctx.lineTo(kb.px[0], kb.px[1] + s)
      ctx.stroke()
      ctx.restore()
    }
    requestAnimationFrame(render)
  }
  requestAnimationFrame(render)

  return { arm, disarm, clear, select, removeSelected, get armed() { return armed }, get rois() { return rois }, get selected() { return selected } }
}
