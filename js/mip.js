// mip.js — projeção de intensidade máxima em bloco deslizante (slab MIP).
// Substitui cada voxel pelo máximo dentro de uma janela centrada ao longo de um
// eixo do volume. Implementado com fila monotônica: O(n) por linha, roda em
// menos de um segundo em volumes típicos de RM/TC.

/**
 * @param {TypedArray} src  dados do volume (ordem NIfTI: x mais rápido)
 * @param {number[]} dims   [nx, ny, nz]
 * @param {0|1|2} axis      eixo do slab em coordenadas de voxel
 * @param {number} slabVox  espessura da janela em voxels (>= 1)
 * @returns {TypedArray}    novo array com o MIP
 */
export function slabMip(src, dims, axis, slabVox) {
  const [nx, ny, nz] = dims
  const out = new src.constructor(src.length)
  const stride = [1, nx, nx * ny][axis]
  const len = dims[axis]
  let w = Math.max(1, Math.round(slabVox))
  if (w % 2 === 0) w += 1 // janela ímpar → slab exatamente centrado no voxel
  const half = Math.min(len - 1, w >> 1) // slab maior que o eixo = MIP da linha inteira
  // percorre todas as linhas perpendiculares ao eixo
  const oA = [1, 2, 0][axis], oB = [2, 0, 1][axis]
  const strideA = [1, nx, nx * ny][oA], strideB = [1, nx, nx * ny][oB]
  const lenA = dims[oA], lenB = dims[oB]
  const qIdx = new Int32Array(len)
  for (let b = 0; b < lenB; b++) {
    for (let a = 0; a < lenA; a++) {
      const base = a * strideA + b * strideB
      let head = 0, tail = 0 // fila monotônica decrescente de índices
      for (let i = 0; i < len + half; i++) {
        if (i < len) {
          const val = src[base + i * stride]
          while (tail > head && src[base + qIdx[tail - 1] * stride] <= val) tail--
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
