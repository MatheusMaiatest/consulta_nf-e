require('dotenv').config();
const express      = require('express');
const mysql        = require('mysql2/promise');
const path         = require('path');
const fs           = require('fs');
const helmet       = require('helmet');
const cors         = require('cors');
const rateLimit    = require('express-rate-limit');
const crypto       = require('crypto');

// ── Validação de variáveis de ambiente obrigatórias ──────────
const REQUIRED_ENV = ['DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASS', 'DB_NAME', 'API_KEY', 'ALLOWED_ORIGIN'];
const missingEnv = REQUIRED_ENV.filter(k => !process.env[k]);
if (missingEnv.length > 0) {
  console.error('[STARTUP] Variáveis de ambiente obrigatórias não definidas:', missingEnv.join(', '));
  process.exit(1);
}

const app  = express();
const PORT = process.env.PORT || 3001;
const PAGE = 600;

// Diretório de cache de estoque
const ESTOQUE_DIR = path.join(__dirname, 'estoque-cache');
if (!fs.existsSync(ESTOQUE_DIR)) fs.mkdirSync(ESTOQUE_DIR);

const pool = mysql.createPool({
  host:            process.env.DB_HOST,
  port:            parseInt(process.env.DB_PORT) || 3306,
  user:            process.env.DB_USER,
  password:        process.env.DB_PASS,
  database:        process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit:    10,
  connectTimeout:     10000
});

// Tabela SPED/NF-e: código tpag → descrição
const TPAG = {
  '01':'Dinheiro','02':'Cheque','03':'Cartão de Crédito','04':'Cartão de Débito',
  '05':'Crédito Loja','10':'Vale Alimentação','11':'Vale Refeição','12':'Vale Presente',
  '13':'Vale Combustível','15':'Boleto Bancário','17':'Pagamento Instantâneo (PIX)',
  '18':'Transferência Bancária','19':'Programa de Fidelidade','20':'Sem Pagamento',
  '21':'Outros','90':'Sem Pagamento','99':'Outros'
};
function nomeTpag(cod) {
  return TPAG[String(cod).padStart(2,'0')] || TPAG[String(cod)] || 'Outro ('+cod+')';
}

// ── Segurança: Helmet + CORS + Rate Limiting ─────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:    ["'self'"],
      scriptSrc:     ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc:      ["'self'", "'unsafe-inline'"],
      imgSrc:        ["'self'", "data:", "https:"],
      connectSrc:    ["'self'", "https://cdn.jsdelivr.net", "https://raw.githubusercontent.com"],
      fontSrc:       ["'self'", "https:"],
      objectSrc:     ["'none'"],
      frameSrc:      ["'none'"],
    }
  }
}));

const allowedOrigin = process.env.ALLOWED_ORIGIN || 'http://localhost:3001';
app.use(cors({ origin: allowedOrigin, methods: ['GET', 'POST'] }));

// Rate limit global: 200 req / 15 min por IP
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas requisições. Tente novamente em alguns minutos.' }
});
app.use(globalLimiter);

// Rate limit restrito para importação de estoque
const importLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas requisições. Tente novamente em alguns minutos.' }
});


// ── Middleware: API Key ───────────────────────────────────────
function requireApiKey(req, res, next) {
  const key = req.headers['x-api-key'];
  const expected = process.env.API_KEY;
  if (!key || key.length !== expected.length) {
    return res.status(401).json({ error: 'Não autorizado.' });
  }
  try {
    const match = crypto.timingSafeEqual(Buffer.from(key), Buffer.from(expected));
    if (!match) return res.status(401).json({ error: 'Não autorizado.' });
  } catch {
    return res.status(401).json({ error: 'Não autorizado.' });
  }
  next();
}

app.use(express.json({ limit: '10mb' }));

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// Aplicar API Key em todas as rotas /api/*
app.use('/api', requireApiKey);

// ── /api/produtos-cd ──────────────────────────────────────
app.get('/api/produtos-cd', (req, res) => {
  try {
    const fs = require('fs');
    const produtosJson = JSON.parse(fs.readFileSync(path.join(__dirname, 'produtos-cd.json'), 'utf8'));
    
    // Criar mapa SKU -> Produto para busca rápida
    const mapaProdutos = {};
    produtosJson.forEach(p => {
      mapaProdutos[String(p.SKU)] = {
        sku: p.SKU,
        descricao: p['DESCRIÇÃO '] || p.DESCRIÇÃO || '',
        codigoBarras: p['CÓD. DE BARRAS'] || p.CODIGO_BARRAS || '',
        situacao: p['SITUAÇÃO'] || p.SITUACAO || '',
        linha: p.LINHA || ''
      };
    });
    
    res.json(mapaProdutos);
  } catch (err) {
    console.error('Erro ao ler produtos-cd.json:', err);
    res.json({});
  }
});

// ── /api/estoque-import ──────────────────────────────────
// Recebe: { origem: 'ecommerce'|'distribuidor', nomeArquivo: string, dados: [{codigo,ean,produto,unidade,quantidade}] }
app.post('/api/estoque-import', importLimiter, (req, res) => {
  try {
    const { origem, nomeArquivo, dados } = req.body;
    if (!origem || !nomeArquivo || !Array.isArray(dados)) {
      return res.json({ error: 'Campos obrigatorios: origem, nomeArquivo, dados.' });
    }
    if (origem !== 'ecommerce' && origem !== 'distribuidor') {
      return res.json({ error: 'origem deve ser ecommerce ou distribuidor.' });
    }
    if (dados.length > 100000) {
      return res.status(400).json({ error: 'Limite máximo de 100.000 itens por importação.' });
    }

    // Monta mapa codigo → saldo
    const mapaEstoque = {};
    dados.forEach(item => {
      const cod = String(item.codigo || '').trim();
      const qtd = parseFloat(String(item.quantidade || '0').replace(',', '.')) || 0;
      if (cod) mapaEstoque[cod] = { codigo: cod, ean: item.ean || '', produto: item.produto || '', unidade: item.unidade || 'Un', saldo: qtd };
    });

    const payload = {
      origem,
      nomeArquivo,
      importadoEm: new Date().toISOString(),
      totalItens: Object.keys(mapaEstoque).length,
      estoque: mapaEstoque
    };

    // Salva como estoque-cache/<origem>.json (sempre sobrescreve — último importado)
    const filePath = path.join(ESTOQUE_DIR, `${origem}.json`);
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');

    console.log(`Estoque ${origem} importado: ${payload.totalItens} itens de "${nomeArquivo}"`);
    res.json({ ok: true, origem, nomeArquivo, totalItens: payload.totalItens });
  } catch (err) {
    console.error('[server]', err);
    res.status(500).json({ error: 'Erro interno do servidor.' });
  }
});

// ── /api/estoque-cache ────────────────────────────────────
// Retorna metadados dos caches salvos (sem os dados completos)
app.get('/api/estoque-cache', (req, res) => {
  try {
    const result = {};
    ['ecommerce', 'distribuidor'].forEach(origem => {
      const filePath = path.join(ESTOQUE_DIR, `${origem}.json`);
      if (fs.existsSync(filePath)) {
        const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        result[origem] = { nomeArquivo: raw.nomeArquivo, importadoEm: raw.importadoEm, totalItens: raw.totalItens };
      } else {
        result[origem] = null;
      }
    });
    res.json(result);
  } catch (err) {
    console.error('[server]', err);
    res.status(500).json({ error: 'Erro interno do servidor.' });
  }
});

// ── /api/estoque-dados ────────────────────────────────────
// Retorna o mapa completo de estoque para uso no frontend
app.get('/api/estoque-dados', (req, res) => {
  try {
    const { origem } = req.query;
    if (!origem) return res.json({ error: 'origem obrigatorio.' });
    const ORIGENS_VALIDAS = ['ecommerce', 'distribuidor'];
    if (!ORIGENS_VALIDAS.includes(origem)) return res.status(400).json({ error: 'origem inválida.' });
    const filePath = path.join(ESTOQUE_DIR, `${origem}.json`);
    if (!fs.existsSync(filePath)) return res.json({ estoque: {}, nomeArquivo: null });
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    res.json({ estoque: raw.estoque, nomeArquivo: raw.nomeArquivo, importadoEm: raw.importadoEm });
  } catch (err) {
    console.error('[server]', err);
    res.status(500).json({ error: 'Erro interno do servidor.' });
  }
});

// ── /api/pedidos-status ───────────────────────────────────
app.get('/api/pedidos-status', async (req, res) => {
  try {
    const conn = await pool.getConnection();
    const [statusEco] = await conn.execute(
      'SELECT DISTINCT situacao_nome FROM `bling_pedidos_venda_detalhes_ecommerce` WHERE situacao_nome IS NOT NULL AND situacao_nome != "" ORDER BY situacao_nome'
    );
    const [statusDist] = await conn.execute(
      'SELECT DISTINCT situacao_nome FROM `bling_pedidos_venda_detalhes_distribuicao` WHERE situacao_nome IS NOT NULL AND situacao_nome != "" ORDER BY situacao_nome'
    );
    conn.release();
    res.json({
      ecommerce:    statusEco.map(r => r.situacao_nome),
      distribuidor: statusDist.map(r => r.situacao_nome)
    });
  } catch (err) {
    console.error('[server]', err);
    res.status(500).json({ error: 'Erro interno do servidor.' });
  }
});

// ── /api/pcp-pedidos ──────────────────────────────────────
app.post('/api/pcp-pedidos', async (req, res) => {
  const { status, from, to } = req.body;
  if (!status || !Array.isArray(status) || status.length === 0) {
    return res.json({ error: 'Status obrigatório (array).' });
  }
  if (status.length > 50) {
    return res.status(400).json({ error: 'Máximo de 50 status por consulta.' });
  }
  if (!from || !to) {
    return res.json({ error: 'Período obrigatório (from e to).' });
  }

  const d1 = from + ' 00:00:00';
  const d2 = to   + ' 23:59:59';

  // Timeout proporcional ao número de status
  req.setTimeout(60000);

  try {
    const conn = await pool.getConnection();

    const phStatus = status.map(() => '?').join(',');

    console.log('PCP: Buscando pedidos | status:', status, '| período:', from, '→', to);

    const [pedidosE] = await conn.execute(
      `SELECT id, numero, data, situacao_nome AS situacao, contato_nome AS cliente, total AS valor
       FROM \`bling_pedidos_venda_detalhes_ecommerce\`
       WHERE situacao_nome IN (${phStatus})
         AND data BETWEEN ? AND ?
       ORDER BY data ASC`,
      [...status, d1, d2]
    ).catch(err => { console.error('Erro E:', err); return [[]]; });

    const [pedidosD] = await conn.execute(
      `SELECT id, numero, data, situacao_nome AS situacao, contato_nome AS cliente, total AS valor
       FROM \`bling_pedidos_venda_detalhes_distribuicao\`
       WHERE situacao_nome IN (${phStatus})
         AND data BETWEEN ? AND ?
       ORDER BY data ASC`,
      [...status, d1, d2]
    ).catch(err => { console.error('Erro D:', err); return [[]]; });

    const setE = new Set(pedidosE.map(r => r.id));
    let pedidos = [...pedidosE, ...pedidosD].map(r => ({
      id: r.id,
      origem: setE.has(r.id) ? 'ecommerce' : 'distribuidor',
      numero: r.numero,
      data: r.data ? new Date(r.data).toISOString() : null,
      situacao: r.situacao,
      cliente: r.cliente,
      valor: r.valor || null,
      itens: []
    }));

    console.log('PCP: Encontrados', pedidos.length, 'pedidos');
    
    // Buscar itens dos pedidos
    if (pedidos.length > 0) {
      const ids = pedidos.map(p => p.id);
      const phIds = ids.map(() => '?').join(',');

      // Ecommerce: JOIN com produtos para pegar nome + id do produto pai
      const [itensE] = await conn.execute(
        `SELECT i.pedido_venda_id, i.itens_codigo, i.itens_produto_id,
                i.itens_quantidade, i.itens_valor,
                p.nome AS itens_descricao, p.id AS produto_id
         FROM \`bling_pedidos_venda_detalhes_itens_ecommerce\` i
         LEFT JOIN \`bling_produtos_detalhes_ecommerce\` p ON p.id = i.itens_produto_id
         WHERE i.pedido_venda_id IN (${phIds})`,
        ids
      ).catch(err => { console.error('Erro itens E:', err); return [[]]; });

      // Distribuição: tem itens_descricao + JOIN para pegar id do produto pai
      const [itensD] = await conn.execute(
        `SELECT i.pedido_venda_id, i.itens_codigo, i.itens_produto_id,
                i.itens_descricao, i.itens_quantidade, i.itens_valor,
                p.id AS produto_id
         FROM \`bling_pedidos_venda_detalhes_itens_distribuicao\` i
         LEFT JOIN \`bling_produtos_detalhes_distribuicao\` p ON p.id = i.itens_produto_id
         WHERE i.pedido_venda_id IN (${phIds})`,
        ids
      ).catch(err => { console.error('Erro itens D:', err); return [[]]; });

      console.log('PCP: Encontrados', itensE.length + itensD.length, 'itens brutos');

      // ── Explosão de kits ──────────────────────────────────────────────────
      // Coletar todos os produto_id para verificar quais são kits
      const todosProdutoIds = [...new Set(
        [...itensE, ...itensD]
          .map(i => i.produto_id)
          .filter(Boolean)
      )];

      let kitMap = {}; // produto_id → [ { componentes_produto_id, componentes_quantidade } ]

      if (todosProdutoIds.length > 0) {
        const phProd = todosProdutoIds.map(() => '?').join(',');

        // Buscar componentes ecommerce
        const [compE] = await conn.execute(
          `SELECT ec.produto_pai_id, ec.componentes_produto_id, ec.componentes_quantidade,
                  p.codigo AS comp_codigo, p.nome AS comp_nome
           FROM \`bling_produtos_estruturas_componentes_ecommerce\` ec
           JOIN \`bling_produtos_detalhes_ecommerce\` p ON p.id = ec.componentes_produto_id
           WHERE ec.produto_pai_id IN (${phProd})`,
          todosProdutoIds
        ).catch(err => { console.error('Erro comp E:', err); return [[]]; });

        // Buscar componentes distribuição
        const [compD] = await conn.execute(
          `SELECT dc.produto_pai_id, dc.componentes_produto_id, dc.componentes_quantidade,
                  p.codigo AS comp_codigo, p.nome AS comp_nome
           FROM \`bling_produtos_estruturas_componentes_distribuicao\` dc
           JOIN \`bling_produtos_detalhes_distribuicao\` p ON p.id = dc.componentes_produto_id
           WHERE dc.produto_pai_id IN (${phProd})`,
          todosProdutoIds
        ).catch(err => { console.error('Erro comp D:', err); return [[]]; });

        [...compE, ...compD].forEach(c => {
          if (!kitMap[c.produto_pai_id]) kitMap[c.produto_pai_id] = [];
          kitMap[c.produto_pai_id].push({
            componentes_produto_id: c.componentes_produto_id,
            componentes_quantidade: c.componentes_quantidade,
            comp_codigo: c.comp_codigo,
            comp_nome:   c.comp_nome
          });
        });

        const kitsEncontrados = Object.keys(kitMap).length;
        console.log('PCP: Kits encontrados:', kitsEncontrados);
      }

      // Montar itens finais — explodindo kits em componentes individuais
      const itensMap = {};
      [...itensE, ...itensD].forEach(item => {
        const pedId = item.pedido_venda_id;
        if (!itensMap[pedId]) itensMap[pedId] = [];

        const componentes = item.produto_id ? kitMap[item.produto_id] : null;

        if (componentes && componentes.length > 0) {
          // É um kit → substituir pelo(s) componente(s) multiplicando a quantidade
          const qtdKit = parseFloat(item.itens_quantidade) || 1;
          componentes.forEach(comp => {
            itensMap[pedId].push({
              codigo:    comp.comp_codigo,
              sku:       comp.comp_codigo,
              nome:      comp.comp_nome || comp.comp_codigo,
              quantidade: (comp.componentes_quantidade || 1) * qtdKit,
              valor:     null  // valor unitário do componente não disponível diretamente
            });
          });
        } else {
          // Item simples
          itensMap[pedId].push({
            codigo:    item.itens_codigo,
            sku:       item.itens_codigo,
            nome:      item.itens_descricao || item.itens_codigo,
            quantidade: item.itens_quantidade,
            valor:     item.itens_valor
          });
        }
      });

      pedidos.forEach(p => {
        p.itens = itensMap[p.id] || [];
      });
    }
    
    conn.release();
    
    console.log('PCP: Enviando resposta com', pedidos.length, 'pedidos');
    
    res.json({ 
      pedidos, 
      total: pedidos.length,
      from,
      to,
      status
    });

  } catch (err) {
    console.error('Erro PCP:', err);
    res.status(500).json({ error: 'Timeout ou erro no servidor. Tente outro status.' });
  }
});

// ── /api/stats ────────────────────────────────────────────
app.get('/api/stats', async (req, res) => {
  try {
    const conn = await pool.getConnection();
    
    // Pedidos
    const [[pedEco]] = await conn.execute(
      'SELECT MIN(data) as min_data, MAX(data) as max_data, COUNT(*) as total FROM `bling_pedidos_venda_detalhes_ecommerce`'
    );
    const [[pedDist]] = await conn.execute(
      'SELECT MIN(data) as min_data, MAX(data) as max_data, COUNT(*) as total FROM `bling_pedidos_venda_detalhes_distribuicao`'
    );
    
    // NF-e
    const [[nfeEco]] = await conn.execute(
      'SELECT MIN(dataemissao) as min_data, MAX(dataemissao) as max_data, COUNT(*) as total FROM `bling_nfe_saida_detalhes_ecommerce`'
    );
    const [[nfeDist]] = await conn.execute(
      'SELECT MIN(dataemissao) as min_data, MAX(dataemissao) as max_data, COUNT(*) as total FROM `bling_nfe_saida_detalhes_distribuicao`'
    );
    
    // Pedidos com NF vinculada
    const [[vinculoEco]] = await conn.execute(
      'SELECT COUNT(*) as com_nf FROM `bling_pedidos_venda_detalhes_ecommerce` WHERE notafiscal_id IS NOT NULL AND notafiscal_id != "" AND notafiscal_id != "0"'
    );
    const [[vinculoDist]] = await conn.execute(
      'SELECT COUNT(*) as com_nf FROM `bling_pedidos_venda_detalhes_distribuicao` WHERE notafiscal_id IS NOT NULL AND notafiscal_id != "" AND notafiscal_id != "0"'
    );
    
    conn.release();
    
    res.json({
      pedidos: {
        ecommerce: { total: pedEco.total, min_data: pedEco.min_data, max_data: pedEco.max_data },
        distribuicao: { total: pedDist.total, min_data: pedDist.min_data, max_data: pedDist.max_data },
        total: (pedEco.total || 0) + (pedDist.total || 0),
        com_nf: (vinculoEco.com_nf || 0) + (vinculoDist.com_nf || 0),
        sem_nf: ((pedEco.total || 0) + (pedDist.total || 0)) - ((vinculoEco.com_nf || 0) + (vinculoDist.com_nf || 0))
      },
      nfe: {
        ecommerce: { total: nfeEco.total, min_data: nfeEco.min_data, max_data: nfeEco.max_data },
        distribuicao: { total: nfeDist.total, min_data: nfeDist.min_data, max_data: nfeDist.max_data },
        total: (nfeEco.total || 0) + (nfeDist.total || 0)
      }
    });
  } catch (err) {
    console.error('[server]', err);
    res.status(500).json({ error: 'Erro interno do servidor.' });
  }
});


// ── /api/data-range ───────────────────────────────────────
app.get('/api/data-range', async (req, res) => {
  try {
    const conn = await pool.getConnection();
    
    // Busca a data mais antiga e mais recente de ambas as tabelas
    const [[ecoRange]] = await conn.execute(
      `SELECT 
        MIN(dataemissao) AS min_data,
        MAX(dataemissao) AS max_data,
        COUNT(*) AS total
       FROM \`bling_nfe_saida_detalhes_ecommerce\``
    );
    
    const [[distRange]] = await conn.execute(
      `SELECT 
        MIN(dataemissao) AS min_data,
        MAX(dataemissao) AS max_data,
        COUNT(*) AS total
       FROM \`bling_nfe_saida_detalhes_distribuicao\``
    );
    
    conn.release();
    
    const minData = [ecoRange.min_data, distRange.min_data]
      .filter(Boolean)
      .sort()[0];
    
    const maxData = [ecoRange.max_data, distRange.max_data]
      .filter(Boolean)
      .sort()
      .reverse()[0];
    
    res.json({
      min_data: minData,
      max_data: maxData,
      total_ecommerce: ecoRange.total || 0,
      total_distribuicao: distRange.total || 0,
      total_geral: (ecoRange.total || 0) + (distRange.total || 0)
    });
    
  } catch (err) {
    console.error('[server]', err);
    res.status(500).json({ error: 'Erro interno do servidor.' });
  }
});

// ── /api/pedidos ──────────────────────────────────────────
app.get('/api/pedidos', async (req, res) => {
  const { from, to, offset = 0 } = req.query;
  if (!from || !to) return res.json({ error: 'Parametros from e to obrigatorios.' });

  const d1  = from + ' 00:00:00';
  const d2  = to   + ' 23:59:59';
  const off = parseInt(offset) || 0;

  try {
    const conn = await pool.getConnection();
    let total = null;

    if (off === 0) {
      const [[row]] = await conn.execute(
        `SELECT
          (SELECT COUNT(*) FROM \`bling_pedidos_venda_detalhes_ecommerce\`    WHERE data BETWEEN ? AND ?) +
          (SELECT COUNT(*) FROM \`bling_pedidos_venda_detalhes_distribuicao\` WHERE data BETWEEN ? AND ?) AS total`,
        [d1, d2, d1, d2]
      );
      total = row.total;
    }

    const [[{ countEco }]] = await conn.execute(
      `SELECT COUNT(*) AS countEco FROM \`bling_pedidos_venda_detalhes_ecommerce\` WHERE data BETWEEN ? AND ?`,
      [d1, d2]
    );

    let pedidos = [];
    let offE = 0, limE = 0, offD = 0, limD = 0;

    if (off < countEco) {
      offE = off; limE = PAGE;
      limD = PAGE - Math.min(PAGE, countEco - off);
      offD = 0;
    } else {
      offD = off - countEco; limD = PAGE;
    }

    if (limE > 0) {
      const [rows] = await conn.execute(
        `SELECT 
          id, numero, numeropedidocompra, data, datasaida, situacao_nome, situacao_id,
          contato_nome, contato_numerodocumento, contato_tipopessoa,
          total, totalprodutos, desconto_valor,
          transporte_contato_nome, transporte_frete, transporte_pesobruto,
          notafiscal_id, numeroloja, loja_id,
          'ecommerce' AS origem
         FROM \`bling_pedidos_venda_detalhes_ecommerce\`
         WHERE data BETWEEN ? AND ?
         ORDER BY data DESC LIMIT ${limE} OFFSET ${offE}`,
        [d1, d2]
      );
      pedidos = pedidos.concat(rows.map(r => montarPedido(r)));
    }

    if (limD > 0) {
      const [rows] = await conn.execute(
        `SELECT 
          id, numero, numeropedidocompra, data, datasaida, situacao_nome, situacao_id,
          contato_nome, contato_numerodocumento, contato_tipopessoa,
          total, totalprodutos, desconto_valor,
          transporte_contato_nome, transporte_frete, transporte_pesobruto,
          notafiscal_id, numeroloja, loja_id,
          observacoes, observacoesinternas,
          'distribuidor' AS origem
         FROM \`bling_pedidos_venda_detalhes_distribuicao\`
         WHERE data BETWEEN ? AND ?
         ORDER BY data DESC LIMIT ${limD} OFFSET ${offD}`,
        [d1, d2]
      );
      pedidos = pedidos.concat(rows.map(r => montarPedido(r)));
    }

    conn.release();

    pedidos.sort((a, b) => {
      const da = a.data ? new Date(a.data).getTime() : 0;
      const db = b.data ? new Date(b.data).getTime() : 0;
      return db - da;
    });

    // ── Buscar itens dos pedidos ──────────────────────────────
    if (pedidos.length > 0) {
      const conn2 = await pool.getConnection();
      const ids = pedidos.map(p => p.id);
      const ph = ids.map(() => '?').join(',');

      // Itens E-commerce com JOIN para pegar nome e SKU do produto
      const [itensE] = await conn2.execute(
        `SELECT i.pedido_venda_id, i.itens_codigo, i.itens_id, i.itens_produto_id,
                i.itens_unidade, i.itens_quantidade, i.itens_valor, i.itens_desconto,
                p.nome AS produto_nome, p.codigo AS produto_sku
         FROM \`bling_pedidos_venda_detalhes_itens_ecommerce\` i
         LEFT JOIN \`bling_produtos_detalhes_ecommerce\` p ON p.id = i.itens_produto_id
         WHERE i.pedido_venda_id IN (${ph})`,
        ids
      ).catch(() => [[]]);

      // Itens Distribuição com JOIN para pegar nome e SKU do produto
      const [itensD] = await conn2.execute(
        `SELECT i.pedido_venda_id, i.itens_codigo, i.itens_id, i.itens_produto_id,
                i.itens_unidade, i.itens_quantidade, i.itens_valor, i.itens_desconto,
                p.nome AS produto_nome, p.codigo AS produto_sku
         FROM \`bling_pedidos_venda_detalhes_itens_distribuicao\` i
         LEFT JOIN \`bling_produtos_detalhes_distribuicao\` p ON p.id = i.itens_produto_id
         WHERE i.pedido_venda_id IN (${ph})`,
        ids
      ).catch(() => [[]]);

      conn2.release();

      // Mapear itens por pedido
      const itensMap = {};
      [...itensE, ...itensD].forEach(item => {
        if (!itensMap[item.pedido_venda_id]) itensMap[item.pedido_venda_id] = [];
        itensMap[item.pedido_venda_id].push({
          codigo: item.itens_codigo,
          sku: item.produto_sku || item.itens_codigo || '—',
          nome: item.produto_nome || item.itens_codigo || 'Produto sem nome',
          id: item.itens_id,
          produto_id: item.itens_produto_id,
          unidade: item.itens_unidade,
          quantidade: item.itens_quantidade,
          valor: item.itens_valor,
          desconto: item.itens_desconto
        });
      });

      // Adicionar itens aos pedidos
      pedidos.forEach(p => {
        p.itens = itensMap[p.id] || [];
      });
    }

    res.json({ pedidos, offset: off, pageSize: PAGE, total, hasMore: pedidos.length === PAGE });

  } catch (err) {
    console.error('[server]', err);
    res.status(500).json({ error: 'Erro interno do servidor.' });
  }
});

// ── /api/notas ────────────────────────────────────────────
// Modo FAST: retorna apenas campos essenciais para o card
// Dados completos (Tray, pesos, pagamentos) são buscados em /api/nota-detalhe/:id
app.get('/api/notas', async (req, res) => {
  const { from, to, offset = 0 } = req.query;
  if (!from || !to) return res.json({ error: 'Parametros from e to obrigatorios.' });

  const d1  = from + ' 00:00:00';
  const d2  = to   + ' 23:59:59';
  const off = parseInt(offset) || 0;

  try {
    const conn = await pool.getConnection();

    // ── Contagens em paralelo ─────────────────────────────
    const [total, countEco] = await Promise.all([
      off === 0
        ? conn.execute(
            `SELECT (SELECT COUNT(*) FROM \`bling_nfe_saida_detalhes_ecommerce\` WHERE dataemissao BETWEEN ? AND ?) +
                    (SELECT COUNT(*) FROM \`bling_nfe_saida_detalhes_distribuicao\` WHERE dataemissao BETWEEN ? AND ?) AS total`,
            [d1, d2, d1, d2]
          ).then(([[r]]) => r.total).catch(() => null)
        : Promise.resolve(null),
      conn.execute(
        `SELECT COUNT(*) AS countEco FROM \`bling_nfe_saida_detalhes_ecommerce\` WHERE dataemissao BETWEEN ? AND ?`,
        [d1, d2]
      ).then(([[r]]) => r.countEco).catch(() => 0)
    ]);

    let offE = 0, limE = 0, offD = 0, limD = 0;
    if (off < countEco) {
      offE = off; limE = PAGE;
      limD = PAGE - Math.min(PAGE, countEco - off);
      offD = 0;
    } else {
      offD = off - countEco; limD = PAGE;
    }

    // ── Apenas campos essenciais para o card ─────────────
    // Dados completos são carregados sob demanda em /api/nota-detalhe/:id
    const COLS_FAST = `n.id, n.numero, n.serie, n.dataemissao, n.situacao,
      n.contato_nome, n.contato_numerodocumento,
      n.contato_endereco_municipio, n.contato_endereco_uf,
      n.transporte_transportador_nome,
      n.x_total_icmstot_vnf,
      n.x_ide_finnfe,
      n.linkdanfe, n.linkpdf, n.xml`;

    // ── Queries principais em paralelo ────────────────────
    const [rowsE, rowsD] = await Promise.all([
      limE > 0
        ? conn.execute(
            `SELECT ${COLS_FAST},
                    COALESCE(p.numero, '')               AS numeropedido,
                    COALESCE(p.numeropedidocompra, '')   AS numeropedidocompra,
                    COALESCE(p.situacao_nome, '')        AS pedido_situacao,
                    COALESCE(p.numeroloja, '')           AS pedido_numeroloja,
                    'ecommerce'                          AS origem
             FROM \`bling_nfe_saida_detalhes_ecommerce\` n
             LEFT JOIN \`bling_pedidos_venda_detalhes_ecommerce\` p
               ON p.notafiscal_id = n.id
             WHERE n.dataemissao BETWEEN ? AND ?
             ORDER BY n.dataemissao DESC LIMIT ${limE} OFFSET ${offE}`,
            [d1, d2]
          ).then(([r]) => r).catch(() => [])
        : Promise.resolve([]),
      limD > 0
        ? conn.execute(
            `SELECT ${COLS_FAST},
                    COALESCE(p.numero, '')               AS numeropedido,
                    COALESCE(p.numeropedidocompra, '')   AS numeropedidocompra,
                    COALESCE(p.situacao_nome, '')        AS pedido_situacao,
                    COALESCE(p.numeroloja, '')           AS pedido_numeroloja,
                    'distribuidor'                       AS origem
             FROM \`bling_nfe_saida_detalhes_distribuicao\` n
             LEFT JOIN \`bling_pedidos_venda_detalhes_distribuicao\` p
               ON p.notafiscal_id = n.id
             WHERE n.dataemissao BETWEEN ? AND ?
             ORDER BY n.dataemissao DESC LIMIT ${limD} OFFSET ${offD}`,
            [d1, d2]
          ).then(([r]) => r).catch(() => [])
        : Promise.resolve([])
    ]);

    conn.release();

    // Montar notas com apenas campos do card
    const notas = [...rowsE, ...rowsD].map(r => ({
      id:            r.id,
      origem:        r.origem,
      numero:        r.numero,
      serie:         r.serie,
      dataemissao:   r.dataemissao ? new Date(r.dataemissao).toISOString() : null,
      situacao:      r.situacao,
      finnfe:        r.x_ide_finnfe || null,
      cliente:       r.contato_nome,
      cpf:           r.contato_numerodocumento,
      cidade:        r.contato_endereco_municipio && r.contato_endereco_uf
                       ? r.contato_endereco_municipio + '/' + r.contato_endereco_uf
                       : (r.contato_endereco_municipio || r.contato_endereco_uf || ''),
      transportadora: r.transporte_transportador_nome,
      valor:          r.x_total_icmstot_vnf || null,
      linkdanfe:      r.linkdanfe,
      linkpdf:        r.linkpdf,
      xmlUrl:         r.xml,
      numeropedido:   r.numeropedido || null,
      numeropedidocompra: r.numeropedidocompra || null,
      pedido_situacao: r.pedido_situacao || null,
      pedido_numeroloja: r.pedido_numeroloja || null,
      // Campos completos carregados sob demanda
      _detalhesCarregados: false
    }));

    notas.sort((a, b) => {
      const da = a.dataemissao ? new Date(a.dataemissao).getTime() : 0;
      const db = b.dataemissao ? new Date(b.dataemissao).getTime() : 0;
      return db - da;
    });

    res.json({ notas, offset: off, pageSize: PAGE, total, hasMore: notas.length === PAGE });

  } catch (err) {
    console.error('[api/notas]', err);
    res.status(500).json({ error: 'Erro interno do servidor.' });
  }
});

// ── /api/nota-detalhe/:id ─────────────────────────────────
// Carrega dados completos de uma nota específica (chamado ao abrir o modal)
app.get('/api/nota-detalhe/:id', async (req, res) => {
  const { id } = req.params;
  const { origem } = req.query;
  if (!id || !origem) return res.json({ error: 'id e origem obrigatorios.' });
  if (!['ecommerce', 'distribuidor'].includes(origem)) return res.status(400).json({ error: 'origem invalida.' });

  const tbl     = origem === 'ecommerce' ? 'ecommerce' : 'distribuicao';
  const tblPed  = origem === 'ecommerce' ? 'ecommerce' : 'distribuicao';

  try {
    const conn = await pool.getConnection();

    const COLS_FULL = `n.id, n.numero, n.serie, n.chaveacesso, n.dataemissao, n.situacao,
      n.contato_nome, n.contato_numerodocumento, n.contato_email, n.contato_telefone,
      n.contato_endereco_endereco, n.contato_endereco_numero, n.contato_endereco_bairro,
      n.contato_endereco_municipio, n.contato_endereco_uf, n.contato_endereco_cep,
      n.contato_endereco_complemento,
      n.transporte_transportador_nome, n.transporte_transportador_numerodocumento,
      n.transporte_freteporconta,
      n.x_total_icmstot_vnf, n.x_total_icmstot_vprod,
      n.x_total_icmstot_vdesc, n.x_total_icmstot_vfrete,
      n.linkdanfe, n.linkpdf, n.xml,
      n.x_ide_finnfe, n.x_infadic_infcpl`;

    const [[row]] = await conn.execute(
      `SELECT ${COLS_FULL},
              COALESCE(p.numero, '')               AS numeropedido,
              COALESCE(p.numeropedidocompra, '')   AS numeropedidocompra,
              COALESCE(p.situacao_nome, '')        AS pedido_situacao,
              COALESCE(p.numeroloja, '')           AS pedido_numeroloja,
              ${origem === 'distribuidor' ? "COALESCE(p.observacoes,'') AS pedido_observacoes, COALESCE(p.observacoesinternas,'') AS pedido_observacoesinternas," : "'' AS pedido_observacoes, '' AS pedido_observacoesinternas,"}
              '${origem}'                          AS origem
       FROM \`bling_nfe_saida_detalhes_${tbl}\` n
       LEFT JOIN \`bling_pedidos_venda_detalhes_${tblPed}\` p
         ON p.notafiscal_id = n.id
       WHERE n.id = ?`,
      [id]
    ).catch(() => [null]);

    if (!row) { conn.release(); return res.json({ error: 'Nota nao encontrada.' }); }

    const nota = montarNota(row);

    // Buscar todos os dados complementares em paralelo
    const ids = [nota.id];
    const ph  = '?';

    const numeros     = nota.numeropedido ? [nota.numeropedido] : [];
    const numerosLoja = nota.pedido_numeroloja ? [nota.pedido_numeroloja] : [];

    const [
      detpagE, detpagD,
      pesosE, pesosD,
      trayObs, trayPag,
      trayObsLoja, trayPagLoja,
      parcs
    ] = await Promise.all([
      conn.execute(`SELECT nfe_id, x_pag_detpag_tpag, x_pag_detpag_vpag FROM \`bling_nfe_saida_detpag_ecommerce\` WHERE nfe_id = ?`, ids).then(([r]) => r).catch(() => []),
      conn.execute(`SELECT nfe_id, x_pag_detpag_tpag, x_pag_detpag_vpag FROM \`bling_nfe_saida_detpag_distribuicao\` WHERE nfe_id = ?`, ids).then(([r]) => r).catch(() => []),
      conn.execute(`SELECT nfe_id, x_transp_vol_pesob, x_transp_vol_pesol, x_transp_vol_qvol FROM \`bling_nfe_saida_x_transp_vol_ecommerce\` WHERE nfe_id = ?`, ids).then(([r]) => r).catch(() => []),
      conn.execute(`SELECT nfe_id, x_transp_vol_pesob, x_transp_vol_pesol, x_transp_vol_qvol FROM \`bling_nfe_saida_x_transp_vol_distribuicao\` WHERE nfe_id = ?`, ids).then(([r]) => r).catch(() => []),
      numeros.length > 0 ? conn.execute(`SELECT order_id, MAX(order_customer_note) AS customer_note FROM \`detalhes_pedidos_ecommerce_tray\` WHERE order_id = ? AND order_customer_note IS NOT NULL GROUP BY order_id`, numeros).then(([r]) => r).catch(() => []) : Promise.resolve([]),
      numeros.length > 0 ? conn.execute(`SELECT d.order_id, MAX(d.order_installment) AS parcelas, MAX(d.order_interest) AS juros, p.payment_form, p.discount_coupon FROM \`detalhes_pedidos_ecommerce_tray\` d LEFT JOIN \`pedidos_ecommerce_tray\` p ON p.id = d.order_id WHERE d.order_id = ? GROUP BY d.order_id, p.payment_form, p.discount_coupon`, numeros).then(([r]) => r).catch(() => []) : Promise.resolve([]),
      numerosLoja.length > 0 ? conn.execute(`SELECT order_id, MAX(order_customer_note) AS customer_note FROM \`detalhes_pedidos_ecommerce_tray\` WHERE order_id = ? AND order_customer_note IS NOT NULL GROUP BY order_id`, numerosLoja).then(([r]) => r).catch(() => []) : Promise.resolve([]),
      numerosLoja.length > 0 ? conn.execute(`SELECT d.order_id, MAX(d.order_installment) AS parcelas, MAX(d.order_interest) AS juros, p.payment_form, p.discount_coupon FROM \`detalhes_pedidos_ecommerce_tray\` d LEFT JOIN \`pedidos_ecommerce_tray\` p ON p.id = d.order_id WHERE d.order_id = ? GROUP BY d.order_id, p.payment_form, p.discount_coupon`, numerosLoja).then(([r]) => r).catch(() => []) : Promise.resolve([]),
      nota.numeropedido && origem === 'distribuidor'
        ? conn.execute(`SELECT pv.numero AS pedido_numero, COUNT(pa.parcelas_id) AS qtd_parcelas, GROUP_CONCAT(pa.parcelas_observacoes SEPARATOR ' | ') AS obs_parcelas FROM \`bling_pedidos_venda_detalhes_distribuicao\` pv JOIN \`bling_pedidos_venda_detalhes_parcelas_distribuicao\` pa ON pa.pedido_venda_id = pv.id WHERE pv.numero = ? GROUP BY pv.numero`, [nota.numeropedido]).then(([r]) => r).catch(() => [])
        : Promise.resolve([])
    ]);

    conn.release();

    // Aplicar dados complementares
    const pagMap = {};
    [...detpagE, ...detpagD].forEach(p => {
      if (!pagMap[p.nfe_id]) pagMap[p.nfe_id] = [];
      pagMap[p.nfe_id].push({ tipo: nomeTpag(p.x_pag_detpag_tpag), valor: p.x_pag_detpag_vpag });
    });
    nota.formas_pagamento = pagMap[nota.id] || [];

    const pm = [...pesosE, ...pesosD].find(p => p.nfe_id === nota.id);
    if (pm) { nota.pesoBruto = pm.x_transp_vol_pesob; nota.pesoLiquido = pm.x_transp_vol_pesol; nota.qtdVolumes = pm.x_transp_vol_qvol; }

    const trayMap = {};
    const mergeTray = (rows, isObs) => rows.forEach(r => {
      const k = String(r.order_id);
      if (!trayMap[k]) trayMap[k] = {};
      if (isObs) trayMap[k].customer_note = r.customer_note;
      else { trayMap[k].parcelas = r.parcelas; trayMap[k].juros = r.juros; trayMap[k].payment_form = r.payment_form; trayMap[k].discount_coupon = r.discount_coupon; }
    });
    mergeTray(trayObs, true); mergeTray(trayPag, false);
    mergeTray(trayObsLoja, true); mergeTray(trayPagLoja, false);

    const t = trayMap[String(nota.numeropedido)] || trayMap[String(nota.pedido_numeroloja)] || {};
    nota.tray_customer_note = t.customer_note?.trim() || null;
    nota.tray_payment_form  = t.payment_form  || null;
    nota.tray_parcelas      = t.parcelas      || null;
    nota.tray_juros         = t.juros         || null;
    if (t.discount_coupon?.trim()) {
      const parts = t.discount_coupon.split('/');
      nota.tray_cupom_nome  = parts[0]?.trim() || t.discount_coupon.trim();
      nota.tray_cupom_valor = parts[1] ? parseFloat(parts[1]) : null;
    } else { nota.tray_cupom_nome = null; nota.tray_cupom_valor = null; }

    if (parcs.length > 0) {
      nota.dist_qtd_parcelas = parcs[0].qtd_parcelas || null;
      nota.dist_obs_parcelas = parcs[0].obs_parcelas || null;
    }

    res.json({ nota });

  } catch (err) {
    console.error('[api/nota-detalhe]', err);
    res.status(500).json({ error: 'Erro interno do servidor.' });
  }
});

// ── /api/produtos-lista ───────────────────────────────────
app.get('/api/produtos-lista', async (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) return res.json({ error: 'Parametros from e to obrigatorios.' });
  const d1 = from + ' 00:00:00', d2 = to + ' 23:59:59';
  try {
    const conn = await pool.getConnection();
    const [rowsE] = await conn.execute(
      'SELECT xml FROM `bling_nfe_saida_detalhes_ecommerce` WHERE dataemissao BETWEEN ? AND ? AND xml IS NOT NULL AND xml != ""', [d1, d2]
    );
    const [rowsD] = await conn.execute(
      'SELECT xml FROM `bling_nfe_saida_detalhes_distribuicao` WHERE dataemissao BETWEEN ? AND ? AND xml IS NOT NULL AND xml != ""', [d1, d2]
    );
    conn.release();
    const urls = [...rowsE, ...rowsD]
      .map(r => r.xml)
      .filter(url => url && !validateXmlUrl(url))  // só passa se URL for válida e domínio permitido
      .slice(0, 20);
    const fetch = (await import('node-fetch')).default;
    const prodMap = {};
    await Promise.all(urls.map(async url => {
      try {
        const r = await fetch(url, { timeout: 8000 });
        if (!r.ok) return;
        parseXmlProdutos(await r.text()).forEach(p => {
          const key = p.codigo || p.nome;
          if (key && !prodMap[key]) prodMap[key] = { codigo: p.codigo, nome: p.nome };
        });
      } catch(e) { /* ignora */ }
    }));
    const produtos = Object.values(prodMap).sort((a,b) => (a.nome||'').localeCompare(b.nome||''));
    res.json({ produtos, total: produtos.length });
  } catch(err) { console.error('[server]', err);
    res.status(500).json({ error: 'Erro interno do servidor.' }); }
});

// ── /api/produtos ─────────────────────────────────────────
// Domínios permitidos para fetch de XML (whitelist SSRF)
const ALLOWED_XML_DOMAINS = ['cdn.bling.com.br', 's3.amazonaws.com', 'bling.com.br', 'storage.googleapis.com'];

function validateXmlUrl(xmlUrl) {
  let parsed;
  try { parsed = new URL(xmlUrl); } catch { return { error: 'URL inválida.', status: 400 }; }
  if (parsed.protocol !== 'https:') return { error: 'Apenas HTTPS permitido.', status: 400 };
  const host = parsed.hostname;
  const allowed = ALLOWED_XML_DOMAINS.some(d => host === d || host.endsWith('.' + d));
  if (!allowed) return { error: 'Domínio não permitido.', status: 403 };
  return null;
}

app.get('/api/produtos', async (req, res) => {
  const { xmlUrl } = req.query;
  if (!xmlUrl) return res.json({ error: 'xmlUrl obrigatorio.' });
  const urlErr = validateXmlUrl(xmlUrl);
  if (urlErr) return res.status(urlErr.status).json({ error: urlErr.error });
  try {
    const fetch = (await import('node-fetch')).default;
    const resp  = await fetch(xmlUrl, { timeout: 15000 });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const produtos = parseXmlProdutos(await resp.text());
    res.json({ produtos, total: produtos.length });
  } catch (err) {
    console.error('[api/produtos]', err);
    res.status(500).json({ error: 'Erro interno do servidor.' });
  }
});

// ── Helpers ───────────────────────────────────────────────
function montarNota(r) {
  const mun = r.contato_endereco_municipio || '';
  const uf  = r.contato_endereco_uf || '';
  
  // Extrair número do pedido do campo x_infadic_infcpl se não vier do JOIN
  let numeropedido = r.numeropedido || null;
  if (!numeropedido && r.x_infadic_infcpl) {
    // Procura por padrões específicos de pedido (evita pegar números de leis como LC 123/2006)
    const match = r.x_infadic_infcpl.match(/(?:pedido|ped|pv|order)[:\s#]*(\d{5,})/i);
    if (match) numeropedido = match[1];
  }
  
  // Extrair produtos do XML se disponível
  let produtos = [];
  // NÃO parsear XML aqui - r.xml é uma URL, não o conteúdo XML
  // Produtos serão carregados no frontend quando necessário
  
  return {
    id:                 r.id,
    origem:             r.origem,
    numero:             r.numero,
    serie:              r.serie,
    chaveacesso:        r.chaveacesso,
    dataemissao:        r.dataemissao ? new Date(r.dataemissao).toISOString() : null,
    situacao:           r.situacao,
    finnfe:             r.x_ide_finnfe || null,   // '2' = devolução/reversa
    cliente:            r.contato_nome,
    cpf:                r.contato_numerodocumento,
    email:              r.contato_email,
    telefone:           r.contato_telefone,
    endereco:           r.contato_endereco_endereco,
    endNumero:          r.contato_endereco_numero,
    bairro:             r.contato_endereco_bairro,
    cidade:             mun && uf ? mun + '/' + uf : (mun || uf || ''),
    cep:                r.contato_endereco_cep,
    complemento:        r.contato_endereco_complemento,
    transportadora:     r.transporte_transportador_nome,
    transportadoraCnpj: r.transporte_transportador_numerodocumento,
    fretePorConta:      r.transporte_freteporconta,
    valor:              r.x_total_icmstot_vnf    || null,
    valorProdutos:      r.x_total_icmstot_vprod  || null,
    desconto:           r.x_total_icmstot_vdesc  || null,
    frete:              r.x_total_icmstot_vfrete || null,
    linkdanfe:          r.linkdanfe,
    linkpdf:            r.linkpdf,
    xmlUrl:             r.xml,
    produtos:           produtos,  // ← PRODUTOS JÁ INCLUÍDOS
    numeropedido:       numeropedido,
    numeropedidocompra: r.numeropedidocompra || null,
    pedido_situacao:    r.pedido_situacao   || null,
    pedido_numeroloja:  r.pedido_numeroloja || null,
    pedido_observacoes: r.pedido_observacoes && r.pedido_observacoes.trim() ? r.pedido_observacoes.trim() : null,
    pedido_observacoesinternas: r.pedido_observacoesinternas && r.pedido_observacoesinternas.trim() ? r.pedido_observacoesinternas.trim() : null,
    formas_pagamento:   [],   // preenchido depois
    tray_customer_note: null,
    tray_payment_form:  null,
    tray_parcelas:      null,
    tray_juros:         null,
    tray_cupom_nome:    null,
    tray_cupom_valor:   null,
    dist_qtd_parcelas:  null,
    dist_obs_parcelas:  null,
    pesoBruto:          null,
    pesoLiquido:        null,
    qtdVolumes:         null
  };
}

function montarPedido(r) {
  return {
    id:                 r.id,
    origem:             r.origem,
    numero:             r.numero,
    numeropedidocompra: r.numeropedidocompra || null,
    data:               r.data ? new Date(r.data).toISOString() : null,
    datasaida:          r.datasaida ? new Date(r.datasaida).toISOString() : null,
    situacao:           r.situacao_nome,
    situacao_id:        r.situacao_id,
    cliente:            r.contato_nome,
    cpf:                r.contato_numerodocumento,
    tipoPessoa:         r.contato_tipopessoa,
    valor:              r.total || null,
    valorProdutos:      r.totalprodutos || null,
    desconto:           r.desconto_valor || null,
    transportadora:     r.transporte_contato_nome,
    frete:              r.transporte_frete || null,
    pesoBruto:          r.transporte_pesobruto || null,
    notafiscal_id:      r.notafiscal_id,
    numeroloja:         r.numeroloja,
    loja_id:            r.loja_id,
    observacoes:        r.observacoes && r.observacoes.trim() ? r.observacoes.trim() : null,
    observacoesinternas: r.observacoesinternas && r.observacoesinternas.trim() ? r.observacoesinternas.trim() : null
  };
}

function parseXmlProdutos(xml) {
  const produtos = [];
  const dets = xml.match(/<det\b[^>]*>[\s\S]*?<\/det>/g) || [];
  dets.forEach(det => {
    const prod = det.match(/<prod>([\s\S]*?)<\/prod>/);
    if (!prod) return;
    const p = prod[1];
    produtos.push({
      codigo:    tag(p,'cProd'), nome:      tag(p,'xProd'),
      ncm:       tag(p,'NCM'),   cfop:      tag(p,'CFOP'),
      unidade:   tag(p,'uCom'),  qtd:       parseFloat(tag(p,'qCom'))   || 0,
      valorUnit: parseFloat(tag(p,'vUnCom')) || 0,
      valor:     parseFloat(tag(p,'vProd'))  || 0,
      desconto:  parseFloat(tag(p,'vDesc'))  || 0
    });
  });
  return produtos;
}

function tag(xml, name) {
  const m = xml.match(new RegExp('<' + name + '>([^<]*)</' + name + '>'));
  return m ? m[1] : '';
}

app.listen(PORT, () => console.log('NF-e API rodando na porta ' + PORT));
