// orient.js — geometria de orientação clínica.
// A orientação NUNCA é inferida do nome da série nem da ordem dos arquivos:
// só do sistema de coordenadas do paciente. DICOM usa LPS (+x esquerda do
// paciente, +y posterior, +z superior); NIfTI usa RAS (nega x e y).

/* ---------------- eixos e rótulos ---------------- */
const AX = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]
const LBL_LPS = ['L', 'R', 'P', 'A', 'S', 'I'] // direção +x, -x, +y, -y, +z, -z em LPS
const LBL_RAS = ['R', 'L', 'A', 'P', 'S', 'I'] // idem em RAS

export const OPOSTO = { L: 'R', R: 'L', A: 'P', P: 'A', S: 'I', I: 'S' }

export const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
]
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

/** Rótulo anatômico do eixo mais próximo do vetor (LPS por padrão). */
export function nearestLabel(v, ras = false) {
  const lbl = ras ? LBL_RAS : LBL_LPS
  let best = 0, bestDot = -Infinity
  for (let i = 0; i < AX.length; i++) {
    const d = dot(AX[i], v)
    if (d > bestDot) { bestDot = d; best = i }
  }
  return lbl[best]
}

const PLANE_OF = { S: 'axial', I: 'axial', A: 'coronal', P: 'coronal', L: 'sagital', R: 'sagital' }

/**
 * Geometria a partir de ImageOrientationPatient (0020,0037) — 6 cossenos
 * diretores em LPS: 3 da direção da linha, 3 da direção da coluna.
 * @returns {{row, col, normal, plane, oblique}} rótulos dominantes e o plano
 */
export function geometryFromIOP(iop) {
  if (!Array.isArray(iop) || iop.length < 6 || iop.some((n) => !Number.isFinite(n))) return null
  const row = iop.slice(0, 3), col = iop.slice(3, 6)
  const nrm = cross(row, col)
  const normal = nearestLabel(nrm)
  // obliquidade: quanto a normal se afasta do eixo canônico mais próximo
  const mag = Math.hypot(...nrm) || 1
  const maxComp = Math.max(...nrm.map((c) => Math.abs(c))) / mag
  return {
    row: nearestLabel(row),
    col: nearestLabel(col),
    normal,
    plane: PLANE_OF[normal],
    obliqueDeg: Math.acos(Math.min(1, maxComp)) * (180 / Math.PI),
  }
}

/**
 * Códigos de eixo de uma afim NIfTI (RAS), equivalente ao aff2axcodes do
 * nibabel: para onde apontam +i, +j, +k em coordenadas do paciente.
 * @param {number[][]|number[]} affine 4x4 (linha-maior)
 * @returns {[string,string,string]} ex.: ['R','A','S']
 */
export function axCodesFromAffine(affine) {
  const m = Array.isArray(affine[0]) ? affine : [0, 1, 2, 3].map((r) => affine.slice(r * 4, r * 4 + 4))
  return [0, 1, 2].map((c) => nearestLabel([m[0][c], m[1][c], m[2][c]], true))
}

/** Descrição curta do plano de um NIfTI, a partir da afim (não do nome). */
export function planeFromAffine(affine) {
  const codes = axCodesFromAffine(affine)
  return { codes, plane: PLANE_OF[codes[2]] || '—' }
}

/* ---------------- convenção de exibição ---------------- */
// Radiológica (padrão de PACS): esquerda do paciente à DIREITA da tela em
// axial e coronal; sagital idêntico nas duas convenções.
// Neurológica: esquerda do paciente à esquerda da tela (FSL, SPM).
export const CONVENCOES = {
  radiologica: {
    label: 'Radiológica',
    hint: 'padrão PACS — esquerda do paciente à direita da tela',
    isRadiologicalConvention: true,
  },
  neurologica: {
    label: 'Neurológica',
    hint: 'pesquisa (FSL/SPM) — esquerda do paciente à esquerda da tela',
    isRadiologicalConvention: false,
  },
}

/** Bordas esperadas da tela em cada plano, para conferência e legenda. */
export function bordasDaTela(plane, radiologica) {
  if (plane === 'axial') return radiologica ? ['R', 'L', 'A', 'P'] : ['L', 'R', 'A', 'P']
  if (plane === 'coronal') return radiologica ? ['R', 'L', 'S', 'I'] : ['L', 'R', 'S', 'I']
  return ['A', 'P', 'S', 'I'] // sagital: igual nas duas convenções (nariz à esquerda)
}
