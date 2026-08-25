// mip.js — projeção em bloco deslizante (thick slab): MIP, MinIP ou média.
// Substitui cada voxel pelo máximo/mínimo/média dentro de uma janela centrada
// ao longo de um eixo do volume. Máx/mín com fila monotônica e média com soma
// deslizante: O(n) por linha, roda em menos de um segundo em volumes típicos.

/**
 * @param {TypedArray} src  dados do volume (ordem NIfTI: x mais rápido)
 * @param {number[]} dims   [nx, ny, nz]
 * @param {0|1|2} axis      eixo do slab em coordenadas de voxel
 * @param {number} slabVox  espessura da janela em voxels (>= 1)
 * @param {'max'|'min'|'mean'} mode  MIP, MinIP ou média de slab
 * @returns {TypedArray}    novo array com a projeção
 */
export function slabProject(src, dims, axis, slabVox, mode = 'max') {
  const [nx, ny, nz] = dims
  const out = new src.constructor(src.length)
  const stride = [1, nx, nx * ny][axis]
  const len = dims[axis]
  let w = Math.max(1, Math.round(slabVox))
  if (w % 2 === 0) w += 1 // janela ímpar → slab exatamente centrado no voxel
  const half = Math.min(len - 1, w >> 1) // slab maior que o eixo = projeção da linha inteira
  // percorre todas as linhas perpendiculares ao eixo
  const oA = [1, 2, 0][axis], oB = [2, 0, 1][axis]
  const strideA = [1, nx, nx * ny][oA], strideB = [1, nx, nx * ny][oB]
  const lenA = dims[oA], lenB = dims[oB]

  if (mode === 'mean') {
    const isFloat = src instanceof Float32Array || src instanceof Float64Array
    for (let b = 0; b < lenB; b++) {
      for (let a = 0; a < lenA; a++) {
        const base = a * strideA + b * strideB
        let sum = 0, count = 0
        for (let i = 0; i <= Math.min(half, len - 1); i++) { sum += src[base + i * stride]; count++ }
        for (let c = 0; c < len; c++) {
          out[base + c * stride] = isFloat ? sum / count : Math.round(sum / count)
          const add = c + half + 1, rem = c - half
          if (add < len) { sum += src[base + add * stride]; count++ }
          if (rem >= 0) { sum -= src[base + rem * stride]; count-- }
        }
      }
    }
    return out
  }

  // fila monotônica: decrescente para o máximo (MIP), crescente para o mínimo (MinIP)
  const evict = mode === 'min'
    ? (q, v) => q >= v
    : (q, v) => q <= v
  const qIdx = new Int32Array(len)
  for (let b = 0; b < lenB; b++) {
    for (let a = 0; a < lenA; a++) {
      const base = a * strideA + b * strideB
      let head = 0, tail = 0
      for (let i = 0; i < len + half; i++) {
        if (i < len) {
          const val = src[base + i * stride]
          while (tail > head && evict(src[base + qIdx[tail - 1] * stride], val)) tail--
          qIdx[tail++] = i
        }
        const center = i - half
        if (center >= 0 && center < len) {
          while (qIdx[head] < center - half) head++
          out[base + center * stride] = src[base + qIdx[head] * stride]
        }
      }
    }
  }
  return out
}

/**
 * Rótulo anatômico aproximado de cada eixo de voxel, a partir da matriz afim
 * (linha dominante de cada coluna): 0=Sagital(L-R), 1=Coronal(P-A), 2=Axial(I-S).
 * @param {number[][]} affine 4x4 voxel→mm
 */
export function axisLabels(affine) {
  const names = ['Sagital (L–R)', 'Coronal (A–P)', 'Axial (S–I)']
  return [0, 1, 2].map((col) => {
    let best = 0, bv = 0
    for (let row = 0; row < 3; row++) {
      const v = Math.abs(affine[row][col])
      if (v > bv) { bv = v; best = row }
    }
    return names[best]
  })
}
