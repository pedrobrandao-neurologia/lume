// oblique.js — MPR oblíquo por reamostragem trilinear.
// Gira o volume em torno de um centro (em mm, tipicamente o cursor) por
// rotações nos eixos anatômicos RAS (L–R, A–P, S–I) e reamostra na grade
// original. O NIfTI resultante mantém a mesma afim: os cortes ortogonais do
// visualizador passam a ser planos oblíquos do volume original.

/* ---------- álgebra 4×4 mínima (linha-maior, number[16]) ---------- */
function matMul(a, b) {
  const o = new Array(16).fill(0)
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      for (let k = 0; k < 4; k++) o[r * 4 + c] += a[r * 4 + k] * b[k * 4 + c]
    }
  }
  return o
}

function matInv(m) {
  // inversão de transformação afim: [R t; 0 1]⁻¹ = [R⁻¹ −R⁻¹t; 0 1]
  const r = [m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]]
  const det = r[0] * (r[4] * r[8] - r[5] * r[7]) - r[1] * (r[3] * r[8] - r[5] * r[6]) + r[2] * (r[3] * r[7] - r[4] * r[6])
  if (!det) throw new Error('afim singular')
  const i = [
    (r[4] * r[8] - r[5] * r[7]) / det, (r[2] * r[7] - r[1] * r[8]) / det, (r[1] * r[5] - r[2] * r[4]) / det,
    (r[5] * r[6] - r[3] * r[8]) / det, (r[0] * r[8] - r[2] * r[6]) / det, (r[2] * r[3] - r[0] * r[5]) / det,
    (r[3] * r[7] - r[4] * r[6]) / det, (r[1] * r[6] - r[0] * r[7]) / det, (r[0] * r[4] - r[1] * r[3]) / det,
  ]
  const t = [m[3], m[7], m[11]]
  return [
    i[0], i[1], i[2], -(i[0] * t[0] + i[1] * t[1] + i[2] * t[2]),
    i[3], i[4], i[5], -(i[3] * t[0] + i[4] * t[1] + i[5] * t[2]),
    i[6], i[7], i[8], -(i[6] * t[0] + i[7] * t[1] + i[8] * t[2]),
    0, 0, 0, 1,
  ]
}

const deg2rad = (d) => (d * Math.PI) / 180
function rotX(d) { const c = Math.cos(deg2rad(d)), s = Math.sin(deg2rad(d)); return [1, 0, 0, 0, 0, c, -s, 0, 0, s, c, 0, 0, 0, 0, 1] }
function rotY(d) { const c = Math.cos(deg2rad(d)), s = Math.sin(deg2rad(d)); return [c, 0, s, 0, 0, 1, 0, 0, -s, 0, c, 0, 0, 0, 0, 1] }
function rotZ(d) { const c = Math.cos(deg2rad(d)), s = Math.sin(deg2rad(d)); return [c, -s, 0, 0, s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }
const trans = (t) => [1, 0, 0, t[0], 0, 1, 0, t[1], 0, 0, 1, t[2], 0, 0, 0, 1]

/**
 * Reamostra o volume girado.
 * @param {object} vol       NVImage (usa hdr.affine, hdr.dims e img; 4D usa o 1º volume)
 * @param {object} opts      {degLR, degAP, degSI, centerMM:[x,y,z], onProgress(0..1)}
 * @returns {Promise<TypedArray>} novo array (nx·ny·nz) na grade original
 */
export async function bakeOblique(vol, { degLR = 0, degAP = 0, degSI = 0, centerMM = [0, 0, 0], onProgress } = {}) {
  const dims = vol.hdr.dims
  const nx = dims[1], ny = dims[2], nz = dims[3]
  const nvox = nx * ny * nz
  const src = vol.img.length > nvox ? vol.img.subarray(0, nvox) : vol.img
  const out = new src.constructor(nvox)
  const isFloat = src instanceof Float32Array || src instanceof Float64Array

  // afim voxel→mm (hdr.affine é number[4][4], linha-maior)
  const A = vol.hdr.affine.flat()
  const Ainv = matInv(A)
  // rotação inversa em torno do centro: v_src = A⁻¹ · T(C) · Rᵀ · T(−C) · A · v_out
  const R = matMul(rotX(degLR), matMul(rotY(degAP), rotZ(degSI)))
  const Rt = [R[0], R[4], R[8], 0, R[1], R[5], R[9], 0, R[2], R[6], R[10], 0, 0, 0, 0, 1]
  const M = matMul(Ainv, matMul(trans(centerMM), matMul(Rt, matMul(trans([-centerMM[0], -centerMM[1], -centerMM[2]]), A))))

  // fundo: mínimo bruto aproximado (amostragem em passos largos)
  let fill = Infinity
  for (let i = 0; i < src.length; i += 97) if (src[i] < fill) fill = src[i]
  if (!isFinite(fill)) fill = 0

  const di = [M[0], M[4], M[8]] // incremento de v_src por passo em i
  let o = 0
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      // v_src no início da linha (i = 0)
      let sx = M[1] * j + M[2] * k + M[3]
      let sy = M[5] * j + M[6] * k + M[7]
      let sz = M[9] * j + M[10] * k + M[11]
      for (let i = 0; i < nx; i++, o++, sx += di[0], sy += di[1], sz += di[2]) {
        const x0 = Math.floor(sx), y0 = Math.floor(sy), z0 = Math.floor(sz)
        if (x0 < 0 || y0 < 0 || z0 < 0 || x0 >= nx - 1 || y0 >= ny - 1 || z0 >= nz - 1) {
          // borda: vizinho mais próximo se ainda dentro, senão fundo
          const xr = Math.round(sx), yr = Math.round(sy), zr = Math.round(sz)
          out[o] = xr >= 0 && yr >= 0 && zr >= 0 && xr < nx && yr < ny && zr < nz
            ? src[xr + nx * (yr + ny * zr)] : fill
          continue
        }
        const fx = sx - x0, fy = sy - y0, fz = sz - z0
        const b = x0 + nx * (y0 + ny * z0)
        const nxy = nx * ny
        const c00 = src[b] + fx * (src[b + 1] - src[b])
        const c10 = src[b + nx] + fx * (src[b + nx + 1] - src[b + nx])
        const c01 = src[b + nxy] + fx * (src[b + nxy + 1] - src[b + nxy])
        const c11 = src[b + nxy + nx] + fx * (src[b + nxy + nx + 1] - src[b + nxy + nx])
        const c0 = c00 + fy * (c10 - c00)
        const c1 = c01 + fy * (c11 - c01)
        const val = c0 + fz * (c1 - c0)
        out[o] = isFloat ? val : Math.round(val)
      }
    }
    if ((k & 7) === 7) {
      onProgress?.((k + 1) / nz)
      await new Promise((r) => setTimeout(r)) // cede o laço p/ a interface respirar
    }
  }
  onProgress?.(1)
  return out
}
