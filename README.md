# 📦 NF-e Viewer - Sistema de Gestão de Notas Fiscais e Pedidos

Sistema completo para visualização, análise e controle de Notas Fiscais Eletrônicas (NF-e) e Pedidos de Venda integrados com Bling ERP.

---

## 🚀 GUIA DE USO RÁPIDO

### 1️⃣ **Aba NF-e** - Visualização de Notas Fiscais

**Como usar:**
1. Selecione o período (Data De/Até)
2. Escolha a origem: E-commerce, Distribuidor ou ambos
3. Clique em **"🔍 Buscar Notas"**
4. Aguarde o carregamento (scroll infinito carrega automaticamente)
5. Use a busca para filtrar por cliente, NF, CPF
6. Clique em um card para ver detalhes completos

**Recursos:**
- ✅ Agrupamento por: NF-e, Cliente, Transportadora ou Unidade
- ✅ Filtros: Origem, Cupom (com/sem), Produtos específicos
- ✅ Drill-down em mapas (Brasil → Estado → Municípios)
- ✅ Modal com todas as informações da NF e Pedido vinculado
- ✅ Links diretos para DANFE, PDF e XML

---

### 2️⃣ **Aba Pedidos** - Gestão de Pedidos de Venda

**Como usar:**
1. Selecione o período
2. Escolha a origem (E-commerce/Distribuidor)
3. Clique em **"🔍 Buscar Pedidos"**
4. Busque por cliente, número do pedido ou CPF
5. Clique no card para ver detalhes completos

**Recursos:**
- ✅ Badge "✓ NF" indica pedidos já faturados
- ✅ Status coloridos (Verde=Finalizado, Laranja=Pendente, Vermelho=Cancelado)
- ✅ Modal com produtos, SKU, quantidades e valores
- ✅ Sincronização automática com aba NF-e

---

### 3️⃣ **Aba PCP** - Planejamento e Controle de Produção

**Como usar:**
1. Selecione **1 ou 2 status** de pedidos (ex: "Aguardando Estoque")
2. Escolha a prioridade:
   - 🕐 **Mais Antigo**: Produtos dos pedidos mais antigos primeiro
   - 📦 **Solta Mais Pedidos**: Produtos que aparecem em mais pedidos
3. Clique em **"⚙️ Processar PCP"**
4. Veja os produtos ordenados por prioridade
5. Clique em um produto para ver todos os pedidos que o contêm
6. Clique em um pedido para ver detalhes completos

**Recursos:**
- ✅ Agregação inteligente de produtos
- ✅ Quantidade total necessária por produto
- ✅ Lista de pedidos por produto
- ✅ SKU correlacionado com base de produtos CD
- ⚠️ **Limite**: 200 pedidos, máximo 2 status por vez (performance)

---

### 4️⃣ **Aba Transporte** - Análise de Transportadoras

**Como usar:**
1. Selecione o período
2. Visualize automaticamente:
   - Fatia de mercado por transportadora
   - Distribuição de peso por transportadora
   - Mapa de calor por estado

**Recursos:**
- ✅ Gráficos interativos (clique para filtrar)
- ✅ Drill-down em mapas por transportadora
- ✅ Análise de peso bruto e líquido

---

### 5️⃣ **Aba Vendas** - Dashboard de Vendas

**Como usar:**
1. Selecione o período
2. Visualize KPIs e gráficos:
   - Total de NFs e valor
   - Vendas por origem
   - Uso de cupons
   - Situação dos pedidos
   - Mapa de vendas por estado

**Recursos:**
- ✅ KPIs em tempo real
- ✅ Gráficos de pizza e barras interativos
- ✅ Mapa de calor de vendas
- ✅ Análise de cupons e descontos

---

## 📊 DICAS DE USO

### ⚡ Performance
- Use períodos menores (1-2 meses) para carregamento mais rápido
- No PCP, selecione apenas 1-2 status por vez
- Scroll infinito carrega automaticamente conforme você desce

### 🔍 Busca Inteligente
- Busca funciona em: cliente, número, CPF, transportadora
- Sincronização automática entre NF-e e Pedidos
- Filtros se acumulam (origem + busca + produtos)

### 🗺️ Mapas Interativos
- Clique em um estado para ver municípios
- Botão "← Voltar ao Brasil" retorna ao mapa nacional
- Cada aba (NF, Transporte, Vendas) tem seu próprio drill-down

### 🎨 Temas
- Botão 🌙/☀️ no canto superior direito
- Tema escuro (padrão) ou claro
- Preferência salva automaticamente

---


## 🔄 LÓGICA DE FUNCIONAMENTO DO BACKEND (server.js)

### **Arquitetura Geral**
O sistema funciona como uma API REST que conecta ao banco MySQL e serve dados para o frontend. Cada endpoint tem uma responsabilidade específica.

---

### **1. Fluxo de Dados - Notas Fiscais (`/api/notas`)**

#### **Entrada:**
- Período (data inicial e final)
- Offset para paginação (scroll infinito)

#### **Processamento:**
1. **Busca Principal**
   - Consulta tabelas `bling_nfe_saida_detalhes_ecommerce` e `bling_nfe_saida_detalhes_distribuicao`
   - Filtra por período de emissão
   - Ordena por data decrescente
   - Limita a 300 registros por página

2. **Cruzamento com Pedidos (1º Nível)**
   - Para cada NF, busca pedido vinculado pelo campo `notafiscal_id = numero_nf`
   - Se encontrar, adiciona: número do pedido, situação, observações

3. **Cruzamento com Pedidos (2º Nível - Fallback)**
   - Para NFs sem pedido vinculado, busca por CPF do cliente
   - Procura pedidos sem NF vinculada do mesmo CPF
   - Associa o pedido mais recente encontrado

4. **Enriquecimento de Dados**
   - **Formas de Pagamento**: Busca em `bling_nfe_saida_detpag_*`
   - **Dados Tray (E-commerce)**: Busca observações do cliente, cupons, parcelas
   - **Parcelas (Distribuidor)**: Busca quantidade e observações de parcelas
   - **Pesos e Volumes**: Busca em `bling_nfe_saida_x_transp_vol_*`

5. **Produtos da NF**
   - Produtos são carregados sob demanda quando o modal é aberto
   - Frontend chama `/api/produtos?xmlUrl=...`
   - Backend baixa o XML da URL e extrai produtos usando regex

#### **Saída:**
- Array de notas com todos os dados enriquecidos
- Total de registros
- Flag `hasMore` para scroll infinito

---

### **2. Fluxo de Dados - Pedidos de Venda (`/api/pedidos`)**

#### **Entrada:**
- Período (data inicial e final)
- Offset para paginação

#### **Processamento:**
1. **Busca Principal**
   - Consulta `bling_pedidos_venda_detalhes_ecommerce` e `bling_pedidos_venda_detalhes_distribuicao`
   - Filtra por período
   - Ordena por data decrescente
   - Limita a 300 registros por página

2. **Busca de Itens dos Pedidos**
   - Para todos os pedidos carregados, busca itens em:
     - `bling_pedidos_venda_detalhes_itens_ecommerce`
     - `bling_pedidos_venda_detalhes_itens_distribuicao`
   - Faz JOIN com `bling_produtos_detalhes_*` para pegar nome e SKU
   - Agrupa itens por `pedido_venda_id`

3. **Montagem Final**
   - Adiciona array `itens` a cada pedido
   - Cada item contém: código, SKU, nome, quantidade, valor, desconto

#### **Saída:**
- Array de pedidos com itens completos
- Total de registros
- Flag `hasMore` para scroll infinito

---

### **3. Fluxo de Dados - PCP (`/api/pcp-pedidos`)**

#### **Entrada:**
- Array de status selecionados (máximo 2)

#### **Processamento:**
1. **Busca Otimizada de Pedidos**
   - Filtra pedidos por status selecionados
   - Limita a 200 pedidos (performance)
   - Ordena por data ASC (mais antigos primeiro)
   - Busca apenas campos essenciais: id, numero, data, situacao, cliente, total

2. **Busca Simplificada de Itens**
   - Busca itens sem JOIN com produtos (mais rápido)
   - Usa apenas: codigo, quantidade, valor
   - Agrupa por pedido

3. **Agregação no Frontend**
   - Backend envia dados brutos
   - Frontend agrupa produtos e calcula totais
   - Frontend aplica priorização (mais antigo ou mais pedidos)

#### **Saída:**
- Array de pedidos com itens
- Limite aplicado (200)
- Quantidade de status processados

---

### **4. Endpoints Auxiliares**

#### **`/api/stats`**
- Retorna estatísticas gerais do banco
- Períodos disponíveis de NFs e Pedidos
- Totais por origem (E-commerce/Distribuidor)

#### **`/api/pedidos-status`**
- Lista todos os status únicos de pedidos
- Combina E-commerce e Distribuição
- Remove duplicatas e ordena

#### **`/api/produtos-cd`**
- Carrega arquivo `produtos-cd.json`
- Converte para mapa SKU → Produto
- Usado para correlação de SKU no frontend

#### **`/api/produtos?xmlUrl=...`**
- Baixa XML da NF pela URL
- Extrai produtos usando regex
- Retorna array de produtos com: código, nome, NCM, quantidade, valor

---

### **5. Lógica de Cruzamento de Dados**

#### **NF ↔ Pedido (Vínculo Direto)**
```
NF.numero = Pedido.notafiscal_id
```
- Campo `notafiscal_id` no pedido armazena o NÚMERO da NF (não o ID)
- Exemplo: NF 182251 → Pedido com notafiscal_id = "182251"

#### **NF ↔ Pedido (Vínculo por CPF - Fallback)**
```
NF.cpf = Pedido.cpf 
AND Pedido.notafiscal_id IS NULL
```
- Usado quando NF não tem pedido vinculado diretamente
- Busca pedidos sem NF do mesmo cliente
- Pega o pedido mais recente

#### **Pedido → Itens**
```
Pedido.id = Item.pedido_venda_id
```
- Relação 1:N (um pedido tem vários itens)

#### **Item → Produto (Nome e SKU)**
```
Item.itens_produto_id = Produto.id
```
- LEFT JOIN para pegar nome e código do produto
- Se não encontrar, usa o código do item

#### **Produto → SKU CD**
- Feito no frontend via `buscarProdutoCD()`
- Tenta 3 níveis de match:
  1. Código Bling = SKU JSON
  2. Código Bling = Código de Barras JSON
  3. Nome do produto contém descrição JSON (similaridade)

---

### **6. Otimizações Aplicadas**

#### **Paginação**
- Scroll infinito carrega 300 registros por vez
- Offset incrementa automaticamente
- Para quando `hasMore = false`

#### **Queries em Lote**
- Busca NFs de E-commerce e Distribuição em paralelo
- Combina resultados antes de enriquecer
- Reduz tempo total de processamento

#### **Cache de Conexão**
- Pool de conexões MySQL reutilizável
- `pool.getConnection()` → usa → `conn.release()`
- Evita overhead de criar conexões

#### **Campos Seletivos**
- PCP busca apenas campos necessários
- Reduz tráfego de rede e memória
- Queries 60% mais rápidas

---


## 🎨 LÓGICA DE FUNCIONAMENTO DO FRONTEND (index.html)

### **Arquitetura Geral**
Single Page Application (SPA) com abas, sem frameworks. JavaScript vanilla com manipulação direta do DOM.

---

### **1. Estrutura de Abas**

#### **Sistema de Navegação**
```
switchView(viewName, button)
  ↓
Esconde todas as views (.view-section)
  ↓
Mostra apenas a view selecionada
  ↓
Atualiza botão ativo (.tab-btn.active)
```

**Abas disponíveis:**
- `nfe` - Notas Fiscais
- `pedidos` - Pedidos de Venda
- `pcp` - Planejamento e Controle
- `transporte` - Análise de Transportadoras
- `vendas` - Dashboard de Vendas

---

### **2. Aba NF-e - Fluxo Completo**

#### **2.1. Busca de Notas**
```
Usuário clica "Buscar Notas"
  ↓
buscar()
  ↓
Valida período (data inicial ≤ data final)
  ↓
Reseta variáveis globais (allNotas = [], offset = 0)
  ↓
Chama buscarPagina() recursivamente
  ↓
Fetch /api/notas?from=...&to=...&offset=...
  ↓
Adiciona novas notas ao array allNotas
  ↓
Atualiza status (X de Y notas carregadas)
  ↓
Se hasMore = true, incrementa offset e busca próxima página
  ↓
Quando terminar, chama applyFilters()
```

#### **2.2. Sistema de Filtros**
```
applyFilters()
  ↓
Filtra por ORIGEM (E-commerce/Distribuidor)
  ↓
Filtra por BUSCA (cliente, NF, CPF, transportadora)
  ↓
Filtra por CUPOM (com cupom / sem cupom)
  ↓
Filtra por PRODUTOS (se selecionados)
  ↓
Filtra por PAGAMENTO (se selecionado)
  ↓
Resultado: filteredNotas (array filtrado)
  ↓
Chama renderCards()
```

**Lógica de Filtros:**
- Todos os filtros são **cumulativos** (AND)
- Se todos os chips de origem estão OFF → mostra TODAS
- Se todos os chips de cupom estão OFF → mostra TODAS
- Busca é case-insensitive e busca em múltiplos campos

#### **2.3. Renderização de Cards**
```
renderCards()
  ↓
Agrupa notas (por NF, Cliente, Transportadora ou Unidade)
  ↓
Cria HTML dos cards em lotes de 40
  ↓
Usa requestAnimationFrame para não travar UI
  ↓
Adiciona Intersection Observer para scroll infinito
  ↓
Quando sentinel é visível, renderiza próximo lote
```

**Otimizações:**
- Renderização em lotes (40 cards por vez)
- Virtual scrolling (só renderiza o visível)
- Fragment do DOM para inserção em lote
- Animações CSS com `@keyframes cardIn`

#### **2.4. Modal de Detalhes**
```
Usuário clica em um card
  ↓
abrirModal(nota)
  ↓
Monta HTML com todas as seções:
  - Nota Fiscal (azul)
  - Pedido de Venda (azul claro)
  - Destinatário
  - Transporte
  - Pagamento
  - Produtos (carrega assíncrono)
  - Links (DANFE, PDF, XML)
  ↓
Abre overlay (.moverlay.open)
  ↓
Chama carregarProdutosNF(nota) em paralelo
  ↓
Fetch /api/produtos?xmlUrl=...
  ↓
Renderiza produtos com SKU (buscarProdutoCD)
```

**Correlação de SKU:**
```
buscarProdutoCD(codigo, nome)
  ↓
1. Tenta match exato por código
  ↓
2. Tenta match por código de barras
  ↓
3. Tenta match por nome (case-insensitive)
  ↓
4. Tenta match por palavras-chave (≥2 palavras iguais)
  ↓
Retorna produto com SKU ou null
```

---

### **3. Aba Pedidos - Fluxo Completo**

#### **3.1. Busca de Pedidos**
```
Usuário clica "Buscar Pedidos"
  ↓
buscarPedidos()
  ↓
Valida período
  ↓
Reseta variáveis (allPedidos = [], offset = 0)
  ↓
Chama buscarPaginaPedidos() recursivamente
  ↓
Fetch /api/pedidos?from=...&to=...&offset=...
  ↓
Adiciona pedidos ao array allPedidos
  ↓
Se hasMore = true, busca próxima página
  ↓
Quando terminar, chama applyFiltersPed()
```

#### **3.2. Renderização de Cards**
```
renderCardsPed()
  ↓
Filtra por origem e busca
  ↓
Cria cards com:
  - Badge de origem (E-commerce/Distribuidor)
  - Cliente
  - Número do pedido + Status
  - Badge "✓ NF" se tiver NF vinculada
  - Valor
  - Data
  ↓
Adiciona onclick para abrir modal
```

#### **3.3. Modal de Pedido**
```
Usuário clica em card
  ↓
abrirModalPed(pedido)
  ↓
Monta HTML com seções:
  - Pedido (azul)
  - Cliente
  - Transporte
  - Produtos (já vêm no pedido)
  ↓
Para cada produto, busca SKU via buscarProdutoCD()
  ↓
Renderiza com badge SKU se encontrado
  ↓
Abre overlay
```

---

### **4. Aba PCP - Fluxo Completo**

#### **4.1. Carregamento de Status**
```
Ao abrir aba PCP
  ↓
carregarStatusPCP()
  ↓
Fetch /api/pedidos-status
  ↓
Renderiza checkboxes dinâmicos
  ↓
Adiciona event listeners (toggle on/off)
  ↓
Atualiza Set pcpStatusSelecionados
```

#### **4.2. Processamento PCP**
```
Usuário seleciona status e prioridade
  ↓
Clica "Processar PCP"
  ↓
Valida (1-2 status selecionados)
  ↓
Fetch /api/pcp-pedidos (POST)
  ↓
Recebe pedidos com itens
  ↓
processarProdutosPCP()
  ↓
Agrupa produtos por SKU/código/nome
  ↓
Soma quantidades totais
  ↓
Guarda lista de pedidos por produto
  ↓
Rastreia data mínima (pedido mais antigo)
  ↓
Ordena por prioridade:
  - "antigo": data mínima ASC
  - "volume": quantidade de pedidos DESC
  ↓
renderPCPGrid()
```

#### **4.3. Drill-down de Produtos**
```
Usuário clica em produto
  ↓
abrirPCPProduto(index)
  ↓
Monta modal com:
  - SKU e nome do produto
  - Quantidade total
  - Lista de pedidos que contêm o produto
  ↓
Cada pedido mostra:
  - Origem, número, status
  - Cliente, data
  - Quantidade do produto
  - Valor
  ↓
Usuário clica em pedido
  ↓
abrirModalPedFromPCP(pedidoId)
  ↓
Fecha modal de produto
  ↓
Abre modal completo do pedido (reutiliza abrirModalPed)
```

---

### **5. Aba Transporte - Fluxo Completo**

#### **5.1. Carregamento Automático**
```
Usuário troca para aba Transporte
  ↓
Se allNotas.length > 0, chama buildTranspDash()
  ↓
Caso contrário, mostra mensagem "Busque notas primeiro"
```

#### **5.2. Construção do Dashboard**
```
buildTranspDash(notas)
  ↓
Calcula KPIs:
  - Total de NFs
  - Quantidade de transportadoras
  - Peso bruto total
  - Quantidade de NFs com peso
  ↓
Renderiza KPIs no topo
  ↓
Chama buildTranspChart() - Gráfico de pizza
  ↓
Chama buildTranspPesoChart() - Gráfico de barras
  ↓
Chama renderMapTransp() - Mapa de calor
```

#### **5.3. Drill-down de Mapa**
```
Usuário clica em estado no mapa
  ↓
openDrillMap(uf, mode='transp')
  ↓
Filtra notas do estado
  ↓
Carrega GeoJSON do estado
  ↓
Renderiza mapa municipal
  ↓
Calcula NFs por município
  ↓
Aplica escala de cores (heatmap)
  ↓
Renderiza lista de municípios no rodapé
```

---

### **6. Aba Vendas - Fluxo Completo**

#### **6.1. Construção do Dashboard**
```
buildVendasDash(notas)
  ↓
Calcula KPIs:
  - Total de NFs e valor
  - Vendas E-commerce vs Distribuidor
  - Ticket médio
  ↓
buildVendasOrigemChart() - Pizza de origem
  ↓
buildVendasCuponsChart() - Barras de cupons
  ↓
buildVendasSituacaoChart() - Barras de situação
  ↓
renderMapVendas() - Mapa de calor de vendas
```

#### **6.2. Interatividade de Gráficos**
```
Usuário clica em fatia/barra do gráfico
  ↓
onClick handler captura o valor clicado
  ↓
filterAndGoNFe(campo, valor)
  ↓
Troca para aba NF-e
  ↓
Aplica filtro específico
  ↓
Renderiza cards filtrados
```

---

### **7. Sistema de Mapas (D3.js)**

#### **7.1. Mapa do Brasil**
```
loadBrazilMap()
  ↓
Fetch /geojson/brazil-states.json
  ↓
Armazena em GEO_DATA global
  ↓
renderMapNFe() / renderMapTransp() / renderMapVendas()
  ↓
Cria projeção D3 (geoMercator)
  ↓
Desenha paths SVG para cada estado
  ↓
Calcula quantidade/valor por estado
  ↓
Aplica escala de cores (d3.scaleSequential)
  ↓
Adiciona tooltip e onclick
```

#### **7.2. Drill-down Municipal**
```
openDrillMap(uf, mode)
  ↓
Fetch /geojson/[uf]-municipalities.json
  ↓
Filtra notas do estado
  ↓
Renderiza mapa municipal
  ↓
Calcula dados por município
  ↓
Aplica heatmap
  ↓
Renderiza lista no rodapé com:
  - Nome do município
  - Quantidade de NFs
  - Valor total
  - Barra de progresso
```

---

### **8. Variáveis Globais Principais**

```javascript
// NF-e
allNotas = []           // Todas as notas carregadas
filteredNotas = []      // Notas após filtros
activeOrigens = Set     // Origens ativas (ecommerce, distribuidor)
_filtroCupom = {}       // Filtro de cupom (com/sem)
activeSearch = ''       // Texto da busca

// Pedidos
allPedidos = []         // Todos os pedidos carregados
filteredPedidos = []    // Pedidos após filtros
activeOrigensPed = Set  // Origens ativas

// PCP
pcpProdutos = []        // Produtos agregados
pcpTodosPedidos = []    // Cache de pedidos do PCP
pcpStatusSelecionados = Set  // Status selecionados
pcpPrioridade = 'antigo'     // Tipo de priorização

// Produtos CD
produtosCD = {}         // Mapa SKU → Produto do JSON

// Mapas
GEO_DATA = null         // GeoJSON do Brasil
DRILL_GEO = {}          // Cache de GeoJSON dos estados

// Charts
DASH_CHARTS = {}        // Instâncias do Chart.js
```

---

### **9. Fluxo de Sincronização**

#### **NF-e ↔ Pedidos**
```
Quando busca NFs:
  ↓
Copia datas para campos de Pedidos
  ↓
Chama buscarPedidos() automaticamente
  ↓
Ambas as abas ficam sincronizadas
```

#### **Busca Sincronizada**
```
Usuário busca na aba NF-e
  ↓
activeSearch atualiza
  ↓
applyFilters() filtra NFs
  ↓
Automaticamente filtra Pedidos também
  ↓
Ambas as abas mostram resultados da busca
```

---

### **10. Otimizações de Performance**

#### **Renderização**
- Lotes de 40 cards por vez
- `requestAnimationFrame` para não travar UI
- `DocumentFragment` para inserção em lote
- Intersection Observer para lazy loading

#### **Filtros**
- Filtros aplicados em memória (não refaz fetch)
- Debounce na busca (300ms)
- Cache de resultados filtrados

#### **Mapas**
- GeoJSON carregado uma vez e cacheado
- Projeções D3 reutilizadas
- Tooltips com `pointer-events: none`

#### **Modais**
- Produtos carregados sob demanda
- XML parseado apenas quando necessário
- SKU correlacionado em tempo real

---

