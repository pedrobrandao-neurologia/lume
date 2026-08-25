// dicom-scan.js — triagem de estudos DICOM por cabeçalho e leitura direta.
// Lê apenas os primeiros KB de cada arquivo (sem pixel data) para agrupar por
// SeriesInstanceUID — permitindo escolher quais séries abrir antes de alocar
// memória — e oferece um leitor direto DICOM→NIfTI para séries não comprimidas
// (Little Endian implícito/explícito), que monta o volume corte a corte com o
// mínimo de memória, sem passar pelo conversor WASM.

const TS_IMPLICIT = '1.2.840.10008.1.2'
const TS_EXPLICIT_LE = '1.2.840.10008.1.2.1'

// tags de interesse: s=string · n=número · v=vetor de números · u=uint16 binário
const WANT = {
  '00080060': 's', // Modality
  '00080070': 's', // Manufacturer
  '00081090': 's', // ManufacturersModelName
  '0008103e': 's', // SeriesDescription
  '00180010': 's', // ContrastBolusAgent
  '00180050': 'n', // SliceThickness
  '00180060': 'n', // KVP
  '00180080': 'n', // RepetitionTime (ms)
  '00180081': 'n', // EchoTime (ms)
  '00180082': 'n', // InversionTime (ms)
  '00180087': 'n', // MagneticFieldStrength
  '00181030': 's', // ProtocolName
  '0020000e': 's', // SeriesInstanceUID
  '00200011': 'n', // SeriesNumber
  '00200013': 'n', // InstanceNumber
  '00200032': 'v', // ImagePositionPatient
  '00200037': 'v', // ImageOrientationPatient
  '00280002': 'u', // SamplesPerPixel
  '00280008': 'n', // NumberOfFrames
  '00280010': 'u', // Rows
  '00280011': 'u', // Columns
  '00280030': 'v', // PixelSpacing
  '00280100': 'u', // BitsAllocated
  '00280103': 'u', // PixelRepresentation
  '00281052': 'n', // RescaleIntercept
  '00281053': 'n', // RescaleSlope
}
const LONG_VRS = new Set(['OB', 'OW', 'OF', 'OD', 'OL', 'SQ', 'UT', 'UN', 'UC', 'UR'])
const dec = new TextDecoder('ascii')

function u16(b, p) { return b[p] | (b[p + 1] << 8) }
function u32(b, p) { return (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0 }
const key = (g, e) => (g.toString(16).padStart(4, '0') + e.toString(16).padStart(4, '0'))

function readValue(kind, vr, buf, pos, len) {
  if (kind === 'u' && (vr === 'US' || len === 2)) return u16(buf, pos)
  const s = dec.decode(buf.subarray(pos, pos + Math.min(len, 256))).replace(/\0+$/, '').trim()
  if (kind === 's') return s
  if (kind === 'n' || kind === 'u') return parseFloat(s)
  if (kind === 'v') return s.split('\\').map(parseFloat)
  return s
}

// pula sequência de comprimento indefinido procurando o delimitador (FFFE,E0DD)
function skipUndefined(buf, pos) {
  for (let p = pos; p + 8 <= buf.length; p++) {
    if (buf[p] === 0xfe && buf[p + 1] === 0xff && buf[p + 2] === 0xdd && buf[p + 3] === 0xe0) return p + 8
  }
  return -1 // não coube no buffer
}

/**
 * Analisa o cabeçalho de um arquivo, lendo só o necessário do disco.
 * @returns {{tags:object, ts:string, explicit:boolean, pixelOffset:number, pixelLength:number}|null}
 */
export async function parseDicomHeader(file, { needPixel = false } = {}) {
  let cap = 128 * 1024
  for (;;) {
    const buf = new Uint8Array(await file.slice(0, Math.min(cap, file.size)).arrayBuffer())
    const r = tryParse(buf, needPixel)
    if (r === 'again') {
      if (cap >= file.size || cap >= 8 * 1024 * 1024) {
        if (needPixel) return null
        const r2 = tryParse(buf, false, true)
        return r2 && r2 !== 'again' ? r2 : null
      }
      cap *= 4
      continue
    }
    return r
  }
}

function tryParse(buf, needPixel, lenient = false) {
  let pos = 0
  let explicit = true
  let ts = TS_EXPLICIT_LE
  const tags = {}
  if (buf.length > 132 && dec.decode(buf.subarray(128, 132)) === 'DICM') {
    pos = 132
    // grupo meta (0002): sempre explicit little endian
    while (pos + 8 <= buf.length) {
      const g = u16(buf, pos), e = u16(buf, pos + 2)
      if (g !== 0x0002) break
      const vr = dec.decode(buf.subarray(pos + 4, pos + 6))
      let len, dataPos
      if (LONG_VRS.has(vr)) { len = u32(buf, pos + 8); dataPos = pos + 12 } else { len = u16(buf, pos + 6); dataPos = pos + 8 }
      if (g === 0x0002 && e === 0x0010) ts = dec.decode(buf.subarray(dataPos, dataPos + len)).replace(/\0+$/, '').trim()
      pos = dataPos + len
    }
    explicit = ts !== TS_IMPLICIT
  } else {
    // sem preâmbulo: detecta explicit pelo VR plausível no primeiro elemento
    if (buf.length < 8) return null
    const c1 = buf[4], c2 = buf[5]
    explicit = c1 >= 65 && c1 <= 90 && c2 >= 65 && c2 <= 90
    ts = explicit ? TS_EXPLICIT_LE : TS_IMPLICIT
  }
  const bigEndian = ts === '1.2.840.10008.1.2.2'
  if (bigEndian) return { tags, ts, explicit, pixelOffset: -1, pixelLength: 0 }

  let sane = 0
  while (pos + 8 <= buf.length) {
    const g = u16(buf, pos), e = u16(buf, pos + 2)
    if (g === 0xfffe) { // delimitadores soltos
      pos += 8 + (u32(buf, pos + 4) === 0xffffffff ? 0 : u32(buf, pos + 4))
      continue
    }
    if (g > 0x7fe0 || (sane === 0 && g > 0x0008 && g !== 0x7fe0)) return lenient ? { tags, ts, explicit, pixelOffset: -1, pixelLength: 0 } : (sane ? { tags, ts, explicit, pixelOffset: -1, pixelLength: 0 } : null)
    sane++
    let vr = '', len, dataPos
    if (explicit) {
      vr = dec.decode(buf.subarray(pos + 4, pos + 6))
      if (LONG_VRS.has(vr)) { len = u32(buf, pos + 8); dataPos = pos + 12 } else { len = u16(buf, pos + 6); dataPos = pos + 8 }
    } else {
      len = u32(buf, pos + 4); dataPos = pos + 8
    }
    if (g === 0x7fe0 && e === 0x0010) {
      return { tags, ts, explicit, pixelOffset: len === 0xffffffff ? -1 : dataPos, pixelLength: len === 0xffffffff ? 0 : len }
    }
    if (len === 0xffffffff) { // SQ/UN indefinido
      const next = skipUndefined(buf, dataPos)
      if (next < 0) return 'again'
      pos = next
      continue
    }
    if (vr === 'SQ') { pos = dataPos + len; continue }
    const k = key(g, e)
    if (WANT[k] && dataPos + len <= buf.length) tags[k] = readValue(WANT[k], vr, buf, dataPos, len)
    pos = dataPos + len
    // triagem: com os grupos 0008–0028 lidos já temos tudo — para cedo
    if (!needPixel && g > 0x0028) return { tags, ts, explicit, pixelOffset: -1, pixelLength: 0 }
  }
  if (pos + 8 > buf.length && buf.length < 8 * 1024 * 1024) return 'again'
  return { tags, ts, explicit, pixelOffset: -1, pixelLength: 0 }
}

/** Sidecar no formato do dcm2niix (tempos em segundos) a partir das tags. */
function sidecarFrom(t) {
  return {
    Modality: t['00080060'],
    Manufacturer: t['00080070'],
    ManufacturersModelName: t['00081090'],
    SeriesDescription: t['0008103e'],
    ProtocolName: t['00181030'],
    SeriesNumber: t['00200011'],
    ContrastBolusAgent: t['00180010'],
    SliceThickness: t['00180050'],
    KVP: t['00180060'],
    MagneticFieldStrength: t['00180087'],
    RepetitionTime: t['00180080'] ? t['00180080'] / 1000 : undefined,
    EchoTime: t['00180081'] ? t['00180081'] / 1000 : undefined,
    InversionTime: t['00180082'] ? t['00180082'] / 1000 : undefined,
  }
}

/**
 * Agrupa arquivos DICOM por série lendo apenas cabeçalhos (memória mínima).
 * @returns {Promise<Array<{uid, desc, sidecar, files, items, bytes, count, supportedDirect}>>}
 */
export async function scanDicomSeries(files, onProgress) {
  const groups = new Map()
  let done = 0
  const queue = [...files]
  async function worker() {
    for (;;) {
      const file = queue.shift()
      if (!file) return
      let h = null
      try { h = await parseDicomHeader(file) } catch { /* ilegível → ignora */ }
      done++
      if (done % 50 === 0) onProgress?.(done, files.length)
      if (!h) continue
      const t = h.tags
      const uid = t['0020000e'] || '(sem UID de série)'
      let g = groups.get(uid)
      if (!g) {
        g = {
          uid,
          desc: t['0008103e'] || t['00181030'] || '(sem descrição)',
          sidecar: sidecarFrom(t),
          files: [], items: [], bytes: 0, count: 0,
          ts: h.ts,
          supportedDirect:
            (h.ts === TS_IMPLICIT || h.ts === TS_EXPLICIT_LE) &&
            (t['00280002'] ?? 1) === 1 &&
            !(t['00280008'] > 1) &&
            (t['00280100'] === 8 || t['00280100'] === 16) &&
            Array.isArray(t['00200037']) && Array.isArray(t['00200032']),
        }
        groups.set(uid, g)
      }
      g.files.push(file)
      g.items.push({ file, tags: t })
      g.bytes += file.size
      g.count++
    }
  }
  await Promise.all(Array.from({ length: 12 }, worker))
  const out = [...groups.values()].filter((g) => g.count > 0)
  out.sort((a, b) => (a.sidecar.SeriesNumber ?? 999) - (b.sidecar.SeriesNumber ?? 999))
  return out
}

/* ---------------- leitura direta DICOM → NIfTI ---------------- */
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

/**
 * Monta um NIfTI em memória lendo os cortes DICOM um a um (sem conversor).
 * Suporta Little Endian implícito/explícito, corte único por arquivo, 8/16 bits.
 * @returns {Promise<{file: File, sidecar: object}>}
 */
export async function directSeriesToNifti(group, onProgress) {
  const first = group.items[0].tags
  const nx = first['00280011'], ny = first['00280010']
  const bits = first['00280100']
  const signed = first['00280103'] === 1
  const bpp = bits / 8
  if (!group.supportedDirect || !nx || !ny) throw new Error('série não suportada para leitura direta')

  // ordena os cortes pela projeção da posição sobre a normal do plano
  const iop = first['00200037']
  const rowDir = iop.slice(0, 3), colDir = iop.slice(3, 6)
  const normal = cross(rowDir, colDir)
  const slices = group.items
    .filter((it) => Array.isArray(it.tags['00200032']))
    .map((it) => ({ ...it, proj: dot(it.tags['00200032'], normal) }))
    .sort((a, b) => a.proj - b.proj)
  const nz = slices.length
  if (nz < 1) throw new Error('nenhum corte com posição espacial')

  const ps = first['00280030'] || [1, 1] // [entre linhas (dir. coluna), entre colunas (dir. linha)]
  const dzs = []
  for (let i = 1; i < nz; i++) dzs.push(slices[i].proj - slices[i - 1].proj)
  dzs.sort((a, b) => a - b)
  const dz = nz > 1 ? Math.abs(dzs[dzs.length >> 1]) || 1 : (first['00180050'] || 1)

  const Arr = bits === 8 ? Uint8Array : signed ? Int16Array : Uint16Array
  const out = new Arr(nx * ny * nz)
  const need = nx * ny * bpp
  for (let k = 0; k < nz; k++) {
    const it = slices[k]
    let off = it.pixelOffset
    if (off === undefined) {
      const h = await parseDicomHeader(it.file, { needPixel: true })
      if (!h || h.pixelOffset < 0 || h.pixelLength < need) throw new Error(`pixel data ausente em ${it.file.name}`)
      off = h.pixelOffset
      const r = h.tags['00280010'], c = h.tags['00280011']
      if ((r && r !== ny) || (c && c !== nx)) throw new Error('matriz varia dentro da série')
    }
    const bytes = await it.file.slice(off, off + need).arrayBuffer()
    out.set(new Arr(bytes), k * nx * ny)
    if ((k & 15) === 0) onProgress?.(k + 1, nz)
  }

  // afim LPS→RAS: colunas i (linha da imagem), j (coluna) e k (normal); nega x,y
  const ipp0 = slices[0].tags['00200032']
  const kDir = nz > 1
    ? slices[nz - 1].tags['00200032'].map((v, i2) => (v - ipp0[i2]) / (nz - 1))
    : normal.map((v) => v * dz)
  const ci = rowDir.map((v) => v * ps[1])
  const cj = colDir.map((v) => v * ps[0])
  const sgn = [-1, -1, 1]
  const srow = [0, 1, 2].map((r) => [sgn[r] * ci[r], sgn[r] * cj[r], sgn[r] * kDir[r], sgn[r] * ipp0[r]])

  const hdr = new ArrayBuffer(352)
  const v = new DataView(hdr)
  v.setInt32(0, 348, true)
  v.setInt16(40, 3, true)
  v.setInt16(42, nx, true); v.setInt16(44, ny, true); v.setInt16(46, nz, true)
  for (let i = 4; i <= 7; i++) v.setInt16(40 + i * 2, 1, true)
  v.setInt16(70, bits === 8 ? 2 : signed ? 4 : 512, true) // datatype
  v.setInt16(72, bits, true)
  v.setFloat32(76, 1, true)
  v.setFloat32(80, ps[1], true); v.setFloat32(84, ps[0], true); v.setFloat32(88, dz, true)
  v.setFloat32(108, 352, true) // vox_offset
  v.setFloat32(112, first['00281053'] ?? 1, true) // scl_slope
  v.setFloat32(116, first['00281052'] ?? 0, true) // scl_inter
  v.setInt16(254, 1, true) // sform_code
  for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) v.setFloat32(280 + (r * 4 + c) * 4, srow[r][c], true)
  new Uint8Array(hdr, 344, 4).set([0x6e, 0x2b, 0x31, 0]) // "n+1"

  const name = `${(group.desc || 'serie').replace(/[^\w\-]+/g, '_').slice(0, 60) || 'serie'}.nii`
  return { file: new File([hdr, out.buffer], name), sidecar: group.sidecar }
}
