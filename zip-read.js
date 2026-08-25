// zip-read.js — lê um .zip no navegador sem dependências.
// Suporta métodos 0 (store) e 8 (deflate) via DecompressionStream('deflate-raw').
// Retorna File[] com _webkitRelativePath preservando subpastas (formato que o
// wrapper do dcm2niix já entende — mesmo padrão usado no MorfoStudio).

async function inflateRaw(u8) {
  const ds = new DecompressionStream('deflate-raw')
  const stream = new Blob([u8]).stream().pipeThrough(ds)
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/** @param {File|Blob} zipFile @returns {Promise<File[]>} */
export async function readZip(zipFile) {
  const buf = new Uint8Array(await zipFile.arrayBuffer())
  const v = new DataView(buf.buffer)
  // EOCD (assinatura 0x06054b50) — procurada do fim para o início
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65536); i--) {
    if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('ZIP inválido (EOCD não encontrado)')
  const count = v.getUint16(eocd + 10, true)
  let off = v.getUint32(eocd + 16, true) // início do diretório central
  const dec = new TextDecoder()
  const out = []
  for (let n = 0; n < count; n++) {
    if (v.getUint32(off, true) !== 0x02014b50) break
    const method = v.getUint16(off + 10, true)
    const csize = v.getUint32(off + 20, true)
    const nameLen = v.getUint16(off + 28, true)
    const extraLen = v.getUint16(off + 30, true)
    const commLen = v.getUint16(off + 32, true)
    const lho = v.getUint32(off + 42, true) // offset do local header
    const name = dec.decode(buf.subarray(off + 46, off + 46 + nameLen))
    off += 46 + nameLen + extraLen + commLen
    if (name.endsWith('/') || /(^|\/)(__MACOSX|\.DS_Store)/.test(name)) continue
    // local header: tamanhos de nome/extra podem diferir do diretório central
    const lNameLen = v.getUint16(lho + 26, true)
    const lExtraLen = v.getUint16(lho + 28, true)
    const dataStart = lho + 30 + lNameLen + lExtraLen
    const raw = buf.subarray(dataStart, dataStart + csize)
    let data
    if (method === 0) data = raw
    else if (method === 8) data = await inflateRaw(raw)
    else continue // método não suportado — pula em vez de falhar o lote
    const base = name.split('/').pop()
    const f = new File([data], base, { type: 'application/octet-stream' })
    f._webkitRelativePath = name
    out.push(f)
  }
  if (!out.length) throw new Error('ZIP sem arquivos legíveis')
  return out
}
