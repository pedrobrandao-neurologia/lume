// ingest.js — entrada de dados, tudo no navegador.
// DICOM → NIfTI com o dcm2niix (WASM) em Web Worker, preservando TODAS as
// séries do estudo (cada NIfTI + sidecar JSON vira uma série na faixa lateral).
// Caminho reaproveitado do MorfoStudio/SegmentaRM.

import { Dcm2niix } from '../vendor/dcm2niix/index.jpeg.js'
import { readZip } from './zip-read.js'

const NIFTI_RE = /\.(nii|nii\.gz|mgz|mgh|nrrd)$/i
const SKIP_RE = /\.(json|txt|csv|pdf|html|bvec|bval|exe|dll|xml|DS_Store)$/i

/** @typedef {{ id:string, file:File, sidecar:object, kind:'dicom'|'nifti' }} SeriesEntry */

let counter = 0
const sid = () => 'se' + ++counter

/** Converte uma lista de arquivos DICOM. @returns {Promise<SeriesEntry[]>} */
export async function convertDicom(files, log = () => {}) {
  const list = Array.from(files).filter((f) => !NIFTI_RE.test(f.name) && !SKIP_RE.test(f.name))
  if (!list.length) throw new Error('nenhum arquivo DICOM na seleção')
  log(`Convertendo ${list.length} arquivos com dcm2niix…`)
  const d = new Dcm2niix()
  await d.init()
  let converted
  try {
    // -z y: gzip · -ba n: mantém metadados no sidecar (nada sai do navegador)
    // -f: nome legível por série
    converted = await d.input(list).z('y').ba('n').f('%s_%p_%d').run()
  } finally {
    d.worker.terminate()
  }
  const niis = converted.filter((f) => /\.nii(\.gz)?$/i.test(f.name))
  if (!niis.length) throw new Error('dcm2niix não produziu NIfTI (séries não-imagem ou formato não suportado)')
  const series = []
  for (const f of niis) {
    const jname = f.name.replace(/\.nii(\.gz)?$/i, '.json')
    const j = converted.find((x) => x.name === jname)
    let sidecar = {}
    if (j) { try { sidecar = JSON.parse(await j.text()) } catch { /* sidecar ausente é tolerado */ } }
    series.push({ id: sid(), file: f, sidecar, kind: 'dicom' })
  }
  // ordena por número de série quando disponível
  series.sort((a, b) => (a.sidecar.SeriesNumber ?? 999) - (b.sidecar.SeriesNumber ?? 999))
  return series
}

/** Cria uma entrada de série a partir de um NIfTI já em memória. */
export function makeEntry(file, sidecar = {}, kind = 'nifti') {
  return { id: sid(), file, sidecar, kind }
}

/**
 * Separa a seleção (input/drop) sem converter nada: expande ZIPs e devolve as
 * entradas NIfTI prontas + a lista de possíveis DICOM (a decisão de quando e
 * como convertê-los fica com o chamador — é isso que permite a triagem por
 * série e o controle de memória).
 */
export async function splitInput(files, log = () => {}) {
  let all = Array.from(files)
  const zips = all.filter((f) => /\.zip$/i.test(f.name))
  all = all.filter((f) => !/\.zip$/i.test(f.name))
  for (const z of zips) {
    log(`Descompactando ${z.name}…`)
    all.push(...await readZip(z))
  }
  const entries = all.filter((f) => NIFTI_RE.test(f.name)).map((f) => makeEntry(f))
  const dicoms = all.filter((f) => !NIFTI_RE.test(f.name) && !SKIP_RE.test(f.name))
  return { entries, dicoms }
}

/** Roteia qualquer seleção (input, drop): NIfTI direto, ZIP expandido, resto → DICOM. */
export async function ingest(files, log = () => {}) {
  const { entries, dicoms } = await splitInput(files, log)
  const out = [...entries]
  if (dicoms.length) out.push(...await convertDicom(dicoms, log))
  if (!out.length) throw new Error('nenhuma imagem reconhecida na seleção')
  return out
}

/** Coleta recursiva de um DataTransfer (drop de pastas). */
export async function filesFromDrop(dataTransfer) {
  const items = Array.from(dataTransfer.items || [])
  const entries = items.map((i) => i.webkitGetAsEntry && i.webkitGetAsEntry()).filter(Boolean)
  if (!entries.length) return Array.from(dataTransfer.files)
  const files = []
  async function walk(entry, path) {
    if (entry.isFile) {
      const f = await new Promise((res, rej) => entry.file(res, rej))
      f._webkitRelativePath = path + f.name
      files.push(f)
    } else if (entry.isDirectory) {
      const reader = entry.createReader()
      for (;;) {
        const batch = await new Promise((res, rej) => reader.readEntries(res, rej))
        if (!batch.length) break
        for (const e of batch) await walk(e, path + entry.name + '/')
      }
    }
  }
  for (const e of entries) await walk(e, '')
  return files
}
