// thumbs.js — miniatura de um NIfTI (.nii / .nii.gz) sem carregar o volume inteiro.
// Descomprime em streaming, guarda apenas o cabeçalho e o corte axial central e
// interrompe a leitura assim que o corte termina — mantém a memória baixa mesmo
// com estudos de muitas séries.

const DT_BYTES = { 2: 1, 4: 2, 8: 4, 16: 4, 64: 8, 256: 1, 512: 2, 768: 4 }

function parseHeader(h) {
  let v = new DataView(h.buffer, h.byteOffset)
  let le = v.getInt32(0, true) === 348
  if (!le && v.getInt32(0, false) !== 348) throw new Error('não é NIfTI-1')
  const g = (fn, o) => v[fn](o, le)
  const dim = []
  for (let i = 0; i <= 7; i++) dim.push(g('getInt16', 40 + i * 2))
  const pix = []
  for (let i = 0; i <= 7; i++) pix.push(g('getFloat32', 76 + i * 4))
  return {
    le,
    nx: dim[1], ny: dim[2], nz: Math.max(1, dim[3]),
    dx: Math.abs(pix[1]) || 1, dy: Math.abs(pix[2]) || 1,
    datatype: g('getInt16', 70),
    voxOffset: g('getFloat32', 108),
    sclSlope: g('getFloat32', 112) || 1,
    sclInter: g('getFloat32', 116),
  }
}

function readValue(view, o, dt, le) {
  switch (dt) {
    case 2: return view.getUint8(o)
    case 4: return view.getInt16(o, le)
    case 8: return view.getInt32(o, le)
    case 16: return view.getFloat32(o, le)
    case 64: return view.getFloat64(o, le)
    case 256: return view.getInt8(o)
    case 512: return view.getUint16(o, le)
    case 768: return view.getUint32(o, le)
    default: return 0
  }
}

/** Lê somente [start, end) do arquivo, descomprimindo se preciso, e para cedo. */
async function readRange(file, start, end, gz) {
  let stream = file.stream()
  if (gz) stream = stream.pipeThrough(new DecompressionStream('gzip'))
  const reader = stream.getReader()
  const out = new Uint8Array(end - start)
  let pos = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      const a = Math.max(start, pos), b = Math.min(end, pos + value.length)
      if (b > a) out.set(value.subarray(a - pos, b - pos), a - start)
      pos += value.length
      if (pos >= end) break
    }
  } finally { reader.cancel().catch(() => {}) }
  if (pos < end) throw new Error('arquivo termina antes do corte')
  return out
}

/** @returns {Promise<{canvas: HTMLCanvasElement, hdr: object}>} */
export async function makeThumb(file, size = 168) {
  const gz = /\.gz$/i.test(file.name)
  const hdrBytes = await readRange(file, 0, 352, gz)
  const hdr = parseHeader(hdrBytes)
  const bpp = DT_BYTES[hdr.datatype]
  if (!bpp) throw new Error('datatype não suportado: ' + hdr.datatype)
  const { nx, ny, nz } = hdr
  const zmid = nz >> 1
  const sliceStart = Math.round(hdr.voxOffset) + nx * ny * zmid * bpp
  const bytes = await readRange(file, sliceStart, sliceStart + nx * ny * bpp, gz)
  const view = new DataView(bytes.buffer)
  const vals = new Float32Array(nx * ny)
  for (let i = 0; i < nx * ny; i++) vals[i] = readValue(view, i * bpp, hdr.datatype, hdr.le)

  // janela robusta (percentis 2–98) para a miniatura
  const sorted = Float32Array.from(vals).sort()
  const lo = sorted[Math.floor(sorted.length * 0.02)]
  const hi = sorted[Math.floor(sorted.length * 0.98)] || lo + 1
  const rng = hi - lo || 1

  const c = document.createElement('canvas')
  c.width = nx; c.height = ny
  const ctx = c.getContext('2d')
  const im = ctx.createImageData(nx, ny)
  for (let y = 0; y < ny; y++) {
    for (let x = 0; x < nx; x++) {
      // NIfTI: y cresce para anterior→posterior; espelha para exibição "de baixo para cima"
      const g = Math.max(0, Math.min(255, Math.round(((vals[x + nx * y] - lo) / rng) * 255)))
      const o = (x + nx * (ny - 1 - y)) * 4
      im.data[o] = im.data[o + 1] = im.data[o + 2] = g
      im.data[o + 3] = 255
    }
  }
  ctx.putImageData(im, 0, 0)

  // reescala respeitando o tamanho físico do voxel
  const wmm = nx * hdr.dx, hmm = ny * hdr.dy
  const scale = size / Math.max(wmm, hmm)
  const out = document.createElement('canvas')
  out.width = size; out.height = size
  const octx = out.getContext('2d')
  octx.imageSmoothingQuality = 'high'
  const dw = wmm * scale, dh = hmm * scale
  octx.drawImage(c, (size - dw) / 2, (size - dh) / 2, dw, dh)
  return { canvas: out, hdr }
}
