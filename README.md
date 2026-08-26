# Lume

**Visualizador DICOM/NIfTI que roda inteiramente no navegador.** Pensado para clínicos e radiologistas que precisam de uma leitura rápida — abrir a pasta do CD, o `.zip` que chegou por e-mail ou o NIfTI da pesquisa — **sem PACS, sem instalação e sem que nenhuma imagem saia do computador**.

> ⚠️ **Lume não é dispositivo médico certificado** (sem registro Anvisa, FDA ou marcação CE). Destina-se a uso educacional, de pesquisa e de conferência rápida. Decisões diagnósticas exigem visualizador aprovado para uso clínico.

---

## Visão geral

O Lume reproduz, dentro de uma página web estática, o essencial de uma workstation de radiologia:

- **Tudo local.** Os arquivos são lidos pelo próprio navegador; nenhum byte é enviado a servidor algum. A conversão DICOM→NIfTI acontece num Web Worker com o **dcm2niix compilado para WebAssembly** [1], e a renderização usa **WebGL2** via a biblioteca **NiiVue** [10].
- **Sem build, sem backend.** HTML, CSS e módulos ES puros. Qualquer servidor estático (ou o GitHub Pages) serve o app; depois da primeira visita ele funciona **offline** (PWA com service worker).
- **Fluxo de workstation.** Séries na faixa lateral, até 4 painéis sincronizados em milímetros, janelamento por presets e teclado, medidas, ROIs com estatística, thick slab (MIP/MinIP/média), MPR oblíquo e reconstrução volumétrica 3D.

---

## Funcionalidades em detalhe

### 1. Entrada de dados

| Recurso | Como funciona |
|---|---|
| Pasta DICOM | Botão **Abrir pasta DICOM** (ou arrastar a pasta para a tela). Todas as séries do estudo são convertidas e listadas. |
| Arquivos avulsos | `.dcm`, `.nii`, `.nii.gz`, `.mgz`, `.nrrd` e `.zip` (expandido localmente, sem dependências, via `DecompressionStream`). |
| Arrastar e soltar | Aceita pastas inteiras (coleta recursiva) e múltiplos arquivos. |
| Conversão | dcm2niix (WASM) em Web Worker, com sidecar JSON preservando os metadados de aquisição [1,9]. Séries ordenadas por número. |

### 2. Faixa de séries (negatoscópio)

- Miniaturas **quadradas**, geradas em streaming (lê-se apenas o cabeçalho NIfTI e o corte central — a memória não cresce com o número de séries), com barra de rolagem quando o estudo tem muitas séries.
- **Selo de ponderação/sequência** sobreposto à miniatura — T1, T2, FLAIR, DWI, ADC, SWI, T2\*, Angio, STIR, DP, Perfusão, ASL, BOLD, TC ("+C" quando há contraste) — inferido dos metadados do sidecar (descrição, protocolo, nome da sequência) e, na falta de texto reconhecível, dos tempos TR/TE/TI. *Heurística informativa, não diagnóstica.*
- Legenda sobreposta com descrição, modalidade e matriz/voxel.
- Cliques: **clique** abre no painel focado · **Ctrl+clique** abre em painel novo · **clique direito** manda para o painel de comparação.

### 3. Painéis de comparação (1–4) com localização tridimensional

- Botões **▣ ◫ ☰3 ⊞** abrem 1, 2, 3 ou 4 painéis (2×2).
- **Cursor, scroll de cortes, pan/zoom e câmera 3D sincronizados em coordenadas mm** entre todos os painéis — a orientação do corte, de propósito, **não** é sincronizada: cada painel pode exibir **série e plano próprios** (ex.: coluna em axial, sagital e coronal simultaneamente; ou exame atual × anterior). Clicar numa lesão em qualquer painel a localiza em todos.
- **Painel focado** (contorno âmbar): clique num painel para focá-lo; a miniatura clicada e os botões MPR/Ax/Cor/Sag/3D valem para ele. Painéis recém-abertos recebem a série ativa em sagital/coronal/axial (hanging básico com um clique).
- **Barra de cortes por painel**: barra de rolagem vertical própria na borda direita de cada painel, com indicador *corte/total*, ligada ao eixo do plano exibido.
- A janela (brilho/contraste) é independente por painel.
- O painel 1 é o **principal**: ROIs, janela por teclado, thick slab, MPR oblíquo e metadados operam sobre ele.

### 4. Gestos do mouse (customizáveis) e tutorial

Padrão estilo workstation — todos os gestos podem ser trocados no diálogo aberto pelo botão **?** (a escolha fica salva no navegador):

| Gesto | Ação padrão |
|---|---|
| Esquerdo + arrastar | Percorrer cortes |
| Meio + arrastar | Janela (brilho/contraste) |
| Direito + arrastar | Zoom |
| Botão "voltar" (4º) + arrastar | Mover (pan) |
| Botão "avançar" (5º) + arrastar | Janela |
| Ctrl + esquerdo + arrastar | Janela |
| Shift + esquerdo + arrastar | Mover (pan) |
| Alt + esquerdo + arrastar | Zoom |
| Clique simples (esquerdo) | Posiciona o cursor (localização sincronizada) |
| Roda vertical | Percorre cortes do painel **sob o mouse** |
| Ctrl + roda | Zoom |
| Roda horizontal | Série anterior/seguinte no painel sob o mouse |

- Ações de **medir distância/ângulo** dependem do motor de imagem e ficam disponíveis nos botões esquerdo/meio/direito e Ctrl/Shift+esquerdo; percorrer cortes, janela, zoom e pan são emulados pelo app em qualquer gesto (inclusive botões 4/5 e Alt).
- No painel **3D**, o arrasto esquerdo gira o volume.
- O **tutorial em português** (botão **?**) documenta todos os gestos e atalhos — e é também a tela de customização: cada linha da tabela tem um seletor que troca a ação ao vivo.

### 5. Orientação clínica e lateralidade

| Recurso | Como funciona |
|---|---|
| Convenção de exibição | **Radiológica por padrão** (padrão de PACS): a esquerda do paciente aparece **à direita da tela** em axial e coronal — axial visto pelos pés, coronal visto de frente. O sagital é visto pelo lado esquerdo do paciente (nariz à esquerda), idêntico nas duas convenções. |
| Convenção neurológica | Disponível no seletor da barra (FSL/SPM: esquerda do paciente à esquerda da tela). O selo do rodapé fica **vermelho** nesse modo — uma inversão silenciosa é erro de lateralidade em potencial. A escolha fica salva no navegador. |
| Marcadores | Letras nas **quatro bordas** de cada painel (R, L, A, P, S, I) em âmbar, mais um **selo permanente** no rodapé do palco mostrando qual lado da tela corresponde a qual lado do paciente. |
| Fonte da verdade | A orientação vem **sempre da matriz afim** do volume (DICOM LPS → NIfTI RAS), nunca do nome da série nem da ordem dos arquivos. Os cortes são ordenados pela projeção do `ImagePositionPatient` sobre a normal do plano, não por `InstanceNumber`. |
| Plano detectado | O painel Série mostra o plano (axial/coronal/sagital), o grau de obliquidade quando houver, e os códigos de eixo da afim (ex.: `RAS`). Aquisições oblíquas são exibidas no plano de aquisição, com as letras da direção anatômica dominante. |
| Gantry tilt | Detectado por `GantryDetectorTilt (0018,1120)`; a barra de status avisa quando ≠ 0, pois o MPR pode sair cisalhado. |

Validado com um volume assimétrico sintético percorrendo **as 48 combinações possíveis de orientação** (6 permutações de eixos × 8 de sinais): em todas, a marca colocada na direita do paciente é lida no lado anatômico correto e exibida no lado certo da tela.

### 6. Janelamento

- Arraste com o gesto configurado para *Janela*; campos numéricos Centro/Largura (WL/WW).
- **Presets de TC** com atalhos de teclado: `1` cérebro · `2` subdural · `3` AVC · `4` osso · `5` pulmão · `6` mediastino · `7` abdome · `0` janela automática (percentis robustos). Valores em unidades Hounsfield calibradas (`scl_slope/inter` do NIfTI) [4].
- Mapas de cor e reset de vista.

### 7. Medidas e ROIs quantitativas

- **Distância** (mm/cm) e **ângulo** direto sobre a imagem, com lista no painel lateral.
- **ROI elíptica** (`E`): arraste no painel principal; média, desvio-padrão, mínimo, máximo, N de amostras e **área** (πab).
- **ROI de traçado livre / laço** (`L`): arraste com o mouse **ou desenhe pelo teclado** — setas movem o cursor (Shift acelera), Espaço marca ponto, Backspace desfaz, Enter fecha, Esc cancela, Del remove a selecionada. Área pelo método do shoelace.
- **Caneta magnética** (opcional): cada ponto do traço é atraído para a borda de maior gradiente na direção normal ao traço — o mesmo princípio dos "intelligent scissors"/livewire [8].
- A estatística amostra o volume em exibição **no espaço mm do corte** (independe do zoom da tela); em TC os valores saem em HU. As ROIs ficam ancoradas à fatia em que foram traçadas (somem ao rolar e reaparecem ao voltar).

### 8. Reconstruções

- **Thick slab** com três modos — **MIP** (máximo: vasos, nódulos) [5,6], **MinIP** (mínimo: enfisema, vias aéreas e biliares) e **média** (redução de ruído) [7] — em bloco deslizante ao longo de eixo com rótulo anatômico, espessura em mm, O(n) por linha (fila monotônica / soma deslizante), desfazível.
- **MPR oblíquo**: rotações L–R, A–P e S–I (−90° a +90°) **em torno do cursor atual**, por reamostragem trilinear na grade original — os cortes ortogonais do visualizador viram planos oblíquos do exame [7]. O thick slab pode ser aplicado sobre o resultado; "Original" desfaz. Processamento em blocos com barra de progresso.
- **3D volume rendering** (WebGL2) com sombreamento por gradiente e plano de corte.

### 9. PWA e privacidade

- Instalável; funciona offline após a primeira visita (pré-cache versionado por service worker).
- **Nenhum dado sai do computador**: sem telemetria, sem upload, sem cookies de terceiros. A única persistência local é a configuração de gestos do mouse (`localStorage`).

---

## Atalhos de teclado

| Tecla | Ação |
|---|---|
| `C` `J` `M` `A` `V` | Cursor · Janela · Medir · Ângulo · Mover no botão esquerdo |
| `1`–`7` | Presets de janela de TC |
| `0` | Janela automática |
| `E` / `L` | ROI elíptica / Laço |
| Setas · Espaço · Enter · Backspace · Esc | Desenho do laço pelo teclado |
| `Del` | Remove a ROI selecionada |

---

## Como rodar

É um site estático — qualquer servidor serve (módulos ES não rodam via `file://`):

```bash
npx serve .        # ou: python3 -m http.server
```

Publicação no GitHub Pages funciona sem ajustes (Settings → Pages → branch `main`, raiz).

---

## Arquitetura

```
index.html / styles.css      casca da workstation (vanilla, sem build)
js/app.js                    estado, painéis 1–4 sincronizados, gestos do mouse,
                             barras de corte, janelamento, séries, 3D, tutorial
js/ingest.js                 DICOM→NIfTI (dcm2niix WASM) · NIfTI direto · ZIP
js/zip-read.js               leitor ZIP com DecompressionStream, sem dependências
js/thumbs.js                 miniaturas lendo só cabeçalho + corte central (streaming)
js/orient.js                 orientação clínica (LPS/RAS, plano, convenção de exibição)
js/mip.js                    thick slab MIP/MinIP/média (fila monotônica / soma deslizante)
js/roi.js                    ROIs (elipse, laço com caneta magnética, teclado) + estatística
js/oblique.js                MPR oblíquo (reamostragem trilinear em torno do cursor)
vendor/niivue.min.js         NiiVue 0.69 (renderização WebGL2, sync entre instâncias)
vendor/dcm2niix/             dcm2niix compilado para WASM (Web Worker)
sw.js / manifest.webmanifest PWA (pré-cache versionado)
```

Decisões de projeto:

- **Um NiiVue por painel**, sincronizados em mm via `broadcastTo` — é o que permite orientações independentes com localização compartilhada.
- **Volume como moeda única**: tudo (slab, oblíquo, ROI, comparação) opera sobre NIfTI em memória; o oblíquo preserva a matriz afim original para que as demais ferramentas continuem válidas sobre o resultado.
- **Gestos em duas camadas**: ações que o motor suporta usam a configuração nativa do NiiVue (incl. Ctrl/Shift+esquerdo); as demais (percorrer cortes, zoom por arrasto, botões 4/5, Alt) são interceptadas em fase de captura e emuladas pelo app.

O caminho de ingestão (dcm2niix WASM + NiiVue) é reaproveitado do
[MorfoStudio](https://github.com/pedrobrandao-neurologia/MorfoStudio) e do
[SegmentaRM](https://github.com/pedrobrandao-neurologia/SegmentaRM), do mesmo autor.

---

## Histórico de versões

| Versão | Destaques |
|---|---|
| 0.1 | Núcleo: ingestão DICOM/NIfTI/ZIP, MPR, janelamento, medidas, MIP, 3D, PWA |
| 0.2 | Miniaturas quadradas com selo de sequência; ferramentas por botão do mouse |
| 0.3 | Comparação sincronizada; thick slab MinIP/média; presets de janela por teclado |
| 0.4 | ROI elíptica e laço com caneta magnética (mouse e teclado); MPR oblíquo |
| 0.5 | Comparação em 1–4 painéis, cada um com série e corte próprios |
| 0.6 | Barra de cortes por painel; gestos de mouse estilo workstation customizáveis; tutorial (?) |
| 0.7 | Triagem de estudos DICOM: seleção de séries, leitura direta e conversão por série |
| 0.8 | Correção da ferramenta de ângulo e de uma série de bugs de experiência de uso |
| 0.9 | Orientação clínica: convenção radiológica (PACS) por padrão, marcadores R/L e detecção pela afim |

## Limitações conhecidas

- A conversão para volume atende muito bem **TC e RM seccionais** (o alvo principal). Modalidades intrinsecamente 2D ou dinâmicas — CR/DX, mamografia, US, XA — não são o foco; o roteiro prevê um caminho de leitura por série (Cornerstone3D/OHIF [11]) para elas.
- O selo de sequência é heurístico; confirme sempre pelos metadados.
- Medir e ângulo dependem do motor de imagem e ficam restritos aos botões esquerdo/meio/direito e Ctrl/Shift+esquerdo.
- Os ângulos do MPR oblíquo são absolutos em relação ao volume original (não acumulam).

## Roteiro

- [ ] Linhas de referência entre painéis e definição visual do plano oblíquo (arrastar sobre a imagem)
- [ ] Persistência das medidas/ROIs sobre a imagem + exportação CSV
- [ ] Curved MPR (linha central para coluna e vasos)
- [ ] Tag browser DICOM completo (a partir do sidecar e dos cabeçalhos)
- [ ] Caminho 2D (Cornerstone3D) para CR/MG/US/XA e multiframe
- [ ] Sobreposição de segmentações (NIfTI/DICOM SEG) — ponte com o MorfoStudio
- [ ] Exportação de reconstruções como DICOM Secondary Capture

## Créditos e licenças

- [NiiVue](https://github.com/niivue/niivue) — BSD-2-Clause [10]
- [dcm2niix](https://github.com/rordenlab/dcm2niix) — ver `LICENSE-dcm2niix.txt` [1]
- Esquema padrão de gestos do mouse inspirado nas convenções de visualizadores DICOM de mercado (ex.: RadiAnt/Medixant [12])
- Fontes: Archivo, Source Sans 3, JetBrains Mono (OFL)

Código do Lume sob licença MIT (`LICENSE`).

---

## Referências bibliográficas

1. Li X, Morgan PS, Ashburner J, Smith J, Rorden C. The first step for neuroimaging data analysis: DICOM to NIfTI conversion. *J Neurosci Methods*. 2016;264:47–56. doi:10.1016/j.jneumeth.2016.03.001
2. Cox RW, Ashburner J, Breman H, et al. A (sort of) new image data format standard: NIfTI-1. Apresentado no 10th Annual Meeting of the Organization for Human Brain Mapping; 2004; Budapeste, Hungria. Especificação: <https://nifti.nimh.nih.gov/nifti-1>
3. National Electrical Manufacturers Association (NEMA). *Digital Imaging and Communications in Medicine (DICOM) Standard* (PS3/ISO 12052). Rosslyn, VA: NEMA. <https://www.dicomstandard.org>
4. Hounsfield GN. Computerized transverse axial scanning (tomography): Part 1. Description of system. *Br J Radiol*. 1973;46(552):1016–1022. doi:10.1259/0007-1285-46-552-1016
5. Napel S, Marks MP, Rubin GD, et al. CT angiography with spiral CT and maximum intensity projection. *Radiology*. 1992;185(2):607–610. doi:10.1148/radiology.185.2.1410382
6. Prokop M, Shin HO, Schanz A, Schaefer-Prokop CM. Use of maximum intensity projections in CT angiography: a basic review. *RadioGraphics*. 1997;17(2):433–451. doi:10.1148/radiographics.17.2.9084083
7. Dalrymple NC, Prasad SR, Freckleton MW, Chintapalli KN. Introduction to the language of three-dimensional imaging with multidetector CT. *RadioGraphics*. 2005;25(5):1409–1428. doi:10.1148/rg.255055044
8. Mortensen EN, Barrett WA. Interactive segmentation with intelligent scissors. *Graphical Models and Image Processing*. 1998;60(5):349–384. doi:10.1006/gmip.1998.0480
9. Gorgolewski KJ, Auer T, Calhoun VD, et al. The brain imaging data structure, a format for organizing and describing outputs of neuroimaging experiments. *Sci Data*. 2016;3:160044. doi:10.1038/sdata.2016.44
10. NiiVue — biblioteca de visualização de neuroimagem em WebGL2 [software]. Rorden Lab e colaboradores. <https://github.com/niivue/niivue>
11. Ziegler E, Urban T, Brown D, et al. Open Health Imaging Foundation Viewer: an extensible open-source framework for building web-based imaging applications to support cancer research. *JCO Clin Cancer Inform*. 2020;4:336–345. doi:10.1200/CCI.19.00131
12. Medixant. RadiAnt DICOM Viewer [software]. <https://www.radiantviewer.com>
