# Lume

**Visualizador DICOM/NIfTI que roda inteiramente no navegador.** Pensado para clínicos e radiologistas que precisam de uma leitura rápida — abrir a pasta do CD, o `.zip` que chegou por e-mail ou o NIfTI da pesquisa — **sem PACS, sem instalação e sem que nenhuma imagem saia do computador**.

> ⚠️ **Lume não é dispositivo médico certificado.** Uso educacional, de pesquisa e de conferência rápida. Decisões diagnósticas exigem visualizador aprovado para uso clínico.

## O que já faz (v0.1)

| Área | Recursos |
|---|---|
| **Entrada** | Pasta DICOM (todas as séries), arquivos avulsos, `.nii`/`.nii.gz` e `.zip` — por botão ou arrastar-e-soltar. Conversão local com **dcm2niix (WASM)** em Web Worker. |
| **Workstation** | Faixa lateral com miniatura, descrição, modalidade e matriz de **cada série** do estudo; clique para trocar. |
| **Janelamento** | Arraste (botão direito sempre; esquerdo com a ferramenta *Janela*), campos WL/WW, presets de TC (cérebro, subdural, AVC, osso, pulmão, mediastino, abdome), janela automática por percentis. |
| **Medidas** | Distância (mm/cm, listadas no painel) e ângulo, direto sobre a imagem. |
| **Cortes** | Multiplanar (MPR), axial, coronal, sagital, com localizador cruzado. |
| **MIP** | Projeção de intensidade máxima em bloco deslizante (espessura em mm, eixo com rótulo anatômico), calculada em O(n) — desfazível. |
| **3D** | Reconstrução volumétrica (WebGL2) com sombreamento por gradiente, modo acúmulo e plano de corte. |
| **PWA** | Instalável, funciona offline após a primeira visita (service worker com pré-cache). |

Atalhos: `C` cursor · `J` janela · `M` medir · `A` ângulo · `V` mover.

## Como rodar

É um site estático — qualquer servidor serve (módulos ES não rodam via `file://`):

```bash
npx serve .        # ou: python3 -m http.server
```

Publicação no GitHub Pages funciona sem ajustes (Settings → Pages → branch `main`, raiz).

## Arquitetura

```
index.html / styles.css      casca da workstation (vanilla, sem build)
js/app.js                    estado, ferramentas, faixa de séries, 3D
js/ingest.js                 DICOM→NIfTI (dcm2niix WASM) · NIfTI direto · ZIP
js/zip-read.js               leitor ZIP com DecompressionStream, sem dependências
js/thumbs.js                 miniaturas lendo só cabeçalho + corte central (streaming)
js/mip.js                    slab MIP (fila monotônica) + rótulo anatômico dos eixos
vendor/niivue.min.js         NiiVue 0.69 (renderização WebGL2)
vendor/dcm2niix/             dcm2niix compilado para WASM
sw.js / manifest.webmanifest PWA
```

O caminho de ingestão (dcm2niix WASM + NiiVue) é reaproveitado do
[MorfoStudio](https://github.com/pedrobrandao-neurologia/MorfoStudio) e do
[SegmentaRM](https://github.com/pedrobrandao-neurologia/SegmentaRM), do mesmo autor.

### Limite conhecido da v0.1

A conversão para volume atende muito bem **TC e RM seccionais** (o alvo principal). Modalidades intrinsecamente 2D ou dinâmicas — CR/DX, mamografia, US, XA — não são o foco desta versão; o roteiro prevê um segundo caminho de leitura por série (Cornerstone3D) para elas.

## Roteiro

- [ ] Comparação lado a lado (2 séries sincronizadas) e linhas de referência
- [ ] ROI elíptica com média/DP/área (UH em TC)
- [ ] MinIP e média de slab; espessura de slab ao vivo no MPR
- [ ] Persistência das medidas sobre a imagem + exportação CSV
- [ ] Tag browser DICOM completo (a partir do sidecar e dos cabeçalhos)
- [ ] Caminho 2D (Cornerstone3D) para CR/MG/US/XA e multiframe
- [ ] Sobreposição de segmentações (NIfTI/DICOM SEG) — ponte com o MorfoStudio

## Créditos e licenças

- [NiiVue](https://github.com/niivue/niivue) — BSD-2-Clause
- [dcm2niix](https://github.com/rordenlab/dcm2niix) — ver `licenses/LICENSE-dcm2niix.txt`
- Fontes: Archivo, Source Sans 3, JetBrains Mono (OFL)

Código do Lume sob licença MIT (`LICENSE`).
