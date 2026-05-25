const express = require('express');
const mysql   = require('mysql2/promise');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3001;
const PAGE = 300;

const pool = mysql.createPool({
  host:            '162.240.228.36',
  port:            3306,
  user:            'hawktec_alpha_log',
  password:        'Alpha@3030',
  database:        'hawktec_alpha-ecommerce',
  waitForConnections: true,
  connectionLimit:    5,
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

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  next();
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

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

// ── /api/pedidos-status ───────────────────────────────────
app.get('/api/pedidos-status', async (req, res) => {
  try {
    const conn = await pool.getConnection();
    
    // Buscar todos os status únicos de pedidos
    const [statusEco] = await conn.execute(
      'SELECT DISTINCT situacao_nome FROM `bling_pedidos_venda_detalhes_ecommerce` WHERE situacao_nome IS NOT NULL AND situacao_nome != "" ORDER BY situacao_nome'
    );
    const [statusDist] = await conn.execute(
      'SELECT DISTINCT situacao_nome FROM `bling_pedidos_venda_detalhes_distribuicao` WHERE situacao_nome IS NOT NULL AND situacao_nome != "" ORDER BY situacao_nome'
    );
    
    conn.release();
    
    // Combinar e remover duplicatas
    const statusSet = new Set();
    statusEco.forEach(r => statusSet.add(r.situacao_nome));
    statusDist.forEach(r => statusSet.add(r.situacao_nome));
    
    const status = Array.from(statusSet).sort();
    
    res.json({ status, total: status.length });
  } catch (err) {
    console.error(err);
    res.json({ error: err.message });
  }
});

// ── /api/pcp-pedidos ──────────────────────────────────────
app.post('/api/pcp-pedidos', async (req, res) => {
  const { status } = req.body;
  if (!status || !Array.isArray(status) || status.length === 0) {
    return res.json({ error: 'Status obrigatório (array).' });
  }

  try {
    const conn = await pool.getConnection();
    const ph = status.map(() => '?').join(',');
    
    // Reduzir limite para 500 pedidos para resposta mais rápida
    const LIMIT = 500;
    
    // Buscar apenas campos essenciais
    const [pedidosE] = await conn.execute(
      `SELECT 
        id, numero, data, situacao_nome, contato_nome, total, 'ecommerce' AS origem
       FROM \`bling_pedidos_venda_detalhes_ecommerce\`
       WHERE situacao_nome IN (${ph})
       ORDER BY data ASC
       LIMIT ${LIMIT}`,
      status
    );
    
    const [pedidosD] = await conn.execute(
      `SELECT 
        id, numero, data, situacao_nome, contato_nome, total, 'distribuidor' AS origem
       FROM \`bling_pedidos_venda_detalhes_distribuicao\`
       WHERE situacao_nome IN (${ph})
       ORDER BY data ASC
       LIMIT ${LIMIT}`,
      status
    );
    
    let pedidos = [...pedidosE, ...pedidosD].map(r => ({
      id: r.id,
      origem: r.origem,
      numero: r.numero,
      data: r.data ? new Date(r.data).toISOString() : null,
      situacao: r.situacao_nome,
      cliente: r.contato_nome,
      valor: r.total || null,
      itens: []
    }));
    
    // Buscar itens em uma única query otimizada
    if (pedidos.length > 0) {
      const ids = pedidos.map(p => p.id);
      const phIds = ids.map(() => '?').join(',');

      // Itens E-commerce (apenas campos necessários)
      const [itensE] = await conn.execute(
        `SELECT i.pedido_venda_id, i.itens_codigo, i.itens_quantidade, i.itens_valor,
                COALESCE(p.nome, i.itens_codigo) AS produto_nome, 
                COALESCE(p.codigo, i.itens_codigo) AS produto_sku
         FROM \`bling_pedidos_venda_detalhes_itens_ecommerce\` i
         LEFT JOIN \`bling_produtos_detalhes_ecommerce\` p ON p.id = i.itens_produto_id
         WHERE i.pedido_venda_id IN (${phIds})`,
        ids
      ).catch(() => [[]]);

      // Itens Distribuição
      const [itensD] = await conn.execute(
        `SELECT i.pedido_venda_id, i.itens_codigo, i.itens_quantidade, i.itens_valor,
                COALESCE(p.nome, i.itens_codigo) AS produto_nome,
                COALESCE(p.codigo, i.itens_codigo) AS produto_sku
         FROM \`bling_pedidos_venda_detalhes_itens_distribuicao\` i
         LEFT JOIN \`bling_produtos_detalhes_distribuicao\` p ON p.id = i.itens_produto_id
         WHERE i.pedido_venda_id IN (${phIds})`,
        ids
      ).catch(() => [[]]);

      // Mapear itens
      const itensMap = {};
      [...itensE, ...itensD].forEach(item => {
        if (!itensMap[item.pedido_venda_id]) itensMap[item.pedido_venda_id] = [];
        itensMap[item.pedido_venda_id].push({
          codigo: item.itens_codigo,
          sku: item.produto_sku,
          nome: item.produto_nome,
          quantidade: item.itens_quantidade,
          valor: item.itens_valor
        });
      });

      pedidos.forEach(p => {
        p.itens = itensMap[p.id] || [];
      });
    }
    
    conn.release();
    
    res.json({ pedidos, total: pedidos.length, limit: LIMIT });

  } catch (err) {
    console.error(err);
    res.json({ error: err.message });
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
    console.error(err);
    res.json({ error: err.message });
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
    console.error(err);
    res.json({ error: err.message });
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
          id, numero, data, datasaida, situacao_nome, situacao_id,
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
          id, numero, data, datasaida, situacao_nome, situacao_id,
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
    console.error(err);
    res.json({ error: err.message });
  }
});

// ── /api/notas ────────────────────────────────────────────
app.get('/api/notas', async (req, res) => {
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
          (SELECT COUNT(*) FROM \`bling_nfe_saida_detalhes_ecommerce\`    WHERE dataemissao BETWEEN ? AND ?) +
          (SELECT COUNT(*) FROM \`bling_nfe_saida_detalhes_distribuicao\` WHERE dataemissao BETWEEN ? AND ?) AS total`,
        [d1, d2, d1, d2]
      );
      total = row.total;
    }

    const [[{ countEco }]] = await conn.execute(
      `SELECT COUNT(*) AS countEco FROM \`bling_nfe_saida_detalhes_ecommerce\` WHERE dataemissao BETWEEN ? AND ?`,
      [d1, d2]
    );

    let notas = [];
    let offE = 0, limE = 0, offD = 0, limD = 0;

    if (off < countEco) {
      offE = off; limE = PAGE;
      limD = PAGE - Math.min(PAGE, countEco - off);
      offD = 0;
    } else {
      offD = off - countEco; limD = PAGE;
    }

    const COLS = `
      n.id, n.numero, n.serie, n.chaveacesso, n.dataemissao, n.situacao,
      n.contato_nome, n.contato_numerodocumento, n.contato_email, n.contato_telefone,
      n.contato_endereco_endereco, n.contato_endereco_numero, n.contato_endereco_bairro,
      n.contato_endereco_municipio, n.contato_endereco_uf, n.contato_endereco_cep,
      n.contato_endereco_complemento,
      n.transporte_transportador_nome, n.transporte_transportador_numerodocumento,
      n.transporte_freteporconta,
      n.x_total_icmstot_vnf, n.x_total_icmstot_vprod,
      n.x_total_icmstot_vdesc, n.x_total_icmstot_vfrete,
      n.linkdanfe, n.linkpdf, n.xml,
      n.x_ide_finnfe, n.x_infadic_infcpl
    `;

    if (limE > 0) {
      const [rows] = await conn.execute(
        `SELECT ${COLS},
                COALESCE(p.numero, '')        AS numeropedido,
                COALESCE(p.situacao_nome, '') AS pedido_situacao,
                COALESCE(p.numeroloja, '')    AS pedido_numeroloja,
                ''                            AS pedido_observacoes,
                ''                            AS pedido_observacoesinternas,
                'ecommerce'                   AS origem
         FROM \`bling_nfe_saida_detalhes_ecommerce\` n
         LEFT JOIN \`bling_pedidos_venda_detalhes_ecommerce\` p ON p.notafiscal_id = n.numero
         WHERE n.dataemissao BETWEEN ? AND ?
         ORDER BY n.dataemissao DESC LIMIT ${limE} OFFSET ${offE}`,
        [d1, d2]
      );
      notas = notas.concat(rows.map(r => montarNota(r)));
    }

    if (limD > 0) {
      const [rows] = await conn.execute(
        `SELECT ${COLS},
                COALESCE(p.numero, '')               AS numeropedido,
                COALESCE(p.situacao_nome, '')        AS pedido_situacao,
                COALESCE(p.numeroloja, '')           AS pedido_numeroloja,
                COALESCE(p.observacoes, '')          AS pedido_observacoes,
                COALESCE(p.observacoesinternas, '')  AS pedido_observacoesinternas,
                'distribuidor'                       AS origem
         FROM \`bling_nfe_saida_detalhes_distribuicao\` n
         LEFT JOIN \`bling_pedidos_venda_detalhes_distribuicao\` p ON p.notafiscal_id = n.numero
         WHERE n.dataemissao BETWEEN ? AND ?
         ORDER BY n.dataemissao DESC LIMIT ${limD} OFFSET ${offD}`,
        [d1, d2]
      );
      notas = notas.concat(rows.map(r => montarNota(r)));
    }

    // Vínculo 2: notas sem pedido → busca pelo CPF
    const semPedido = notas.filter(n => !n.numeropedido && n.cpf);
    if (semPedido.length > 0) {
      const cpfsEco  = [...new Set(semPedido.filter(n => n.origem === 'ecommerce').map(n => n.cpf))];
      const cpfsDist = [...new Set(semPedido.filter(n => n.origem === 'distribuidor').map(n => n.cpf))];
      const cpfPedidoMap = {};

      if (cpfsEco.length > 0) {
        const ph = cpfsEco.map(() => '?').join(',');
        const [rowsCpf] = await conn.execute(
          `SELECT contato_numerodocumento, numero, situacao_nome, numeroloja,
                  '' AS observacoes, '' AS observacoesinternas
           FROM \`bling_pedidos_venda_detalhes_ecommerce\`
           WHERE contato_numerodocumento IN (${ph})
             AND (notafiscal_id IS NULL OR notafiscal_id = '' OR notafiscal_id = '0')
           ORDER BY id DESC`, cpfsEco
        ).catch(() => [[]]);
        rowsCpf.forEach(r => {
          if (!cpfPedidoMap[r.contato_numerodocumento]) cpfPedidoMap[r.contato_numerodocumento] = r;
        });
      }

      if (cpfsDist.length > 0) {
        const ph = cpfsDist.map(() => '?').join(',');
        const [rowsCpf] = await conn.execute(
          `SELECT contato_numerodocumento, numero, situacao_nome, numeroloja,
                  COALESCE(observacoes,'') AS observacoes,
                  COALESCE(observacoesinternas,'') AS observacoesinternas
           FROM \`bling_pedidos_venda_detalhes_distribuicao\`
           WHERE contato_numerodocumento IN (${ph})
             AND (notafiscal_id IS NULL OR notafiscal_id = '' OR notafiscal_id = '0')
           ORDER BY id DESC`, cpfsDist
        ).catch(() => [[]]);
        rowsCpf.forEach(r => {
          if (!cpfPedidoMap[r.contato_numerodocumento]) cpfPedidoMap[r.contato_numerodocumento] = r;
        });
      }

      notas.forEach(n => {
        if (!n.numeropedido && n.cpf && cpfPedidoMap[n.cpf]) {
          const p = cpfPedidoMap[n.cpf];
          n.numeropedido               = p.numero        || null;
          n.pedido_situacao            = p.situacao_nome || null;
          n.pedido_numeroloja          = p.numeroloja    || null;
          n.pedido_observacoes         = p.observacoes && p.observacoes.trim() ? p.observacoes.trim() : null;
          n.pedido_observacoesinternas = p.observacoesinternas && p.observacoesinternas.trim() ? p.observacoesinternas.trim() : null;
        }
      });
    }

    // ── Forma de pagamento NF (detpag) ────────────────────
    if (notas.length > 0) {
      const ids = notas.map(n => n.id);
      const ph  = ids.map(() => '?').join(',');

      const [detpagE] = await conn.execute(
        `SELECT nfe_id, x_pag_detpag_tpag, x_pag_detpag_vpag
         FROM \`bling_nfe_saida_detpag_ecommerce\` WHERE nfe_id IN (${ph})`, ids
      ).catch(() => [[]]);
      const [detpagD] = await conn.execute(
        `SELECT nfe_id, x_pag_detpag_tpag, x_pag_detpag_vpag
         FROM \`bling_nfe_saida_detpag_distribuicao\` WHERE nfe_id IN (${ph})`, ids
      ).catch(() => [[]]);

      const pagMap = {};
      [...detpagE, ...detpagD].forEach(p => {
        if (!pagMap[p.nfe_id]) pagMap[p.nfe_id] = [];
        pagMap[p.nfe_id].push({ tipo: nomeTpag(p.x_pag_detpag_tpag), valor: p.x_pag_detpag_vpag });
      });
      notas.forEach(n => { n.formas_pagamento = pagMap[n.id] || []; });
    }

    // ── Obs Tray + cupom + parcelas (e-commerce) ─────────
    const notasEco = notas.filter(n => n.origem === 'ecommerce');
    if (notasEco.length > 0) {
      const numeros     = [...new Set(notasEco.map(n => n.numeropedido).filter(Boolean))];
      const numerosLoja = [...new Set(notasEco.map(n => n.pedido_numeroloja).filter(Boolean))];

      const trayMap = {};

      const fetchTray = async (ids) => {
        if (!ids.length) return;
        const ph = ids.map(() => '?').join(',');
        // Obs cliente
        const [tObs] = await conn.execute(
          `SELECT order_id, MAX(order_customer_note) AS customer_note
           FROM \`detalhes_pedidos_ecommerce_tray\`
           WHERE order_id IN (${ph}) AND order_customer_note IS NOT NULL AND order_customer_note != ''
           GROUP BY order_id`, ids
        ).catch(() => [[]]);
        tObs.forEach(r => {
          if (!trayMap[String(r.order_id)]) trayMap[String(r.order_id)] = {};
          trayMap[String(r.order_id)].customer_note = r.customer_note;
        });
        // Parcelas + payment_form
        const [tPag] = await conn.execute(
          `SELECT d.order_id, MAX(d.order_installment) AS parcelas, MAX(d.order_interest) AS juros,
                  p.payment_form, p.discount_coupon
           FROM \`detalhes_pedidos_ecommerce_tray\` d
           LEFT JOIN \`pedidos_ecommerce_tray\` p ON p.id = d.order_id
           WHERE d.order_id IN (${ph})
           GROUP BY d.order_id, p.payment_form, p.discount_coupon`, ids
        ).catch(() => [[]]);
        tPag.forEach(r => {
          if (!trayMap[String(r.order_id)]) trayMap[String(r.order_id)] = {};
          trayMap[String(r.order_id)].parcelas     = r.parcelas;
          trayMap[String(r.order_id)].juros        = r.juros;
          trayMap[String(r.order_id)].payment_form = r.payment_form;
          trayMap[String(r.order_id)].discount_coupon = r.discount_coupon;
        });
      };

      await fetchTray(numeros);
      await fetchTray(numerosLoja.filter(id => !trayMap[String(id)]));

      notasEco.forEach(n => {
        const t = trayMap[String(n.numeropedido)] || trayMap[String(n.pedido_numeroloja)] || {};
        n.tray_customer_note  = t.customer_note  && t.customer_note.trim()  ? t.customer_note.trim()  : null;
        n.tray_payment_form   = t.payment_form   || null;
        n.tray_parcelas       = t.parcelas       || null;
        n.tray_juros          = t.juros          || null;
        // Cupom: formato "NOME/valor"
        if (t.discount_coupon && t.discount_coupon.trim()) {
          const parts = t.discount_coupon.split('/');
          n.tray_cupom_nome  = parts[0] ? parts[0].trim() : t.discount_coupon.trim();
          n.tray_cupom_valor = parts[1] ? parseFloat(parts[1]) : null;
        } else {
          n.tray_cupom_nome  = null;
          n.tray_cupom_valor = null;
        }
      });
    }

    // ── Parcelas distribuidor ─────────────────────────────
    const notasDist = notas.filter(n => n.origem === 'distribuidor' && n.numeropedido);
    if (notasDist.length > 0) {
      const pedidoIds = [...new Set(notasDist.map(n => n._pedido_id).filter(Boolean))];
      // Busca pelo numero do pedido
      const numPedidos = [...new Set(notasDist.map(n => n.numeropedido).filter(Boolean))];
      if (numPedidos.length > 0) {
        const ph = numPedidos.map(() => '?').join(',');
        const [parcs] = await conn.execute(
          `SELECT pv.numero AS pedido_numero,
                  COUNT(pa.parcelas_id) AS qtd_parcelas,
                  GROUP_CONCAT(pa.parcelas_observacoes SEPARATOR ' | ') AS obs_parcelas,
                  SUM(pa.parcelas_valor) AS total_parcelas
           FROM \`bling_pedidos_venda_detalhes_distribuicao\` pv
           JOIN \`bling_pedidos_venda_detalhes_parcelas_distribuicao\` pa ON pa.pedido_venda_id = pv.id
           WHERE pv.numero IN (${ph})
           GROUP BY pv.numero`, numPedidos
        ).catch(() => [[]]);
        const parcMap = {};
        parcs.forEach(p => { parcMap[p.pedido_numero] = p; });
        notasDist.forEach(n => {
          const p = parcMap[n.numeropedido];
          if (p) {
            n.dist_qtd_parcelas   = p.qtd_parcelas   || null;
            n.dist_obs_parcelas   = p.obs_parcelas   || null;
          }
        });
      }
    }

    // ── Pesos ─────────────────────────────────────────────
    if (notas.length > 0) {
      const ids = notas.map(n => n.id);
      const ph  = ids.map(() => '?').join(',');
      const [pesosE] = await conn.execute(
        `SELECT nfe_id, x_transp_vol_pesob, x_transp_vol_pesol, x_transp_vol_qvol
         FROM \`bling_nfe_saida_x_transp_vol_ecommerce\` WHERE nfe_id IN (${ph})`, ids
      ).catch(() => [[]]);
      const [pesosD] = await conn.execute(
        `SELECT nfe_id, x_transp_vol_pesob, x_transp_vol_pesol, x_transp_vol_qvol
         FROM \`bling_nfe_saida_x_transp_vol_distribuicao\` WHERE nfe_id IN (${ph})`, ids
      ).catch(() => [[]]);
      const pm = {};
      [...pesosE, ...pesosD].forEach(p => {
        pm[p.nfe_id] = { pesoBruto: p.x_transp_vol_pesob, pesoLiquido: p.x_transp_vol_pesol, qtdVolumes: p.x_transp_vol_qvol };
      });
      notas.forEach(n => {
        const p = pm[n.id];
        if (p) { n.pesoBruto = p.pesoBruto; n.pesoLiquido = p.pesoLiquido; n.qtdVolumes = p.qtdVolumes; }
      });
    }

    conn.release();

    notas.sort((a, b) => {
      const da = a.dataemissao ? new Date(a.dataemissao).getTime() : 0;
      const db = b.dataemissao ? new Date(b.dataemissao).getTime() : 0;
      return db - da;
    });

    res.json({ notas, offset: off, pageSize: PAGE, total, hasMore: notas.length === PAGE });

  } catch (err) {
    console.error(err);
    res.json({ error: err.message });
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
    const urls = [...rowsE, ...rowsD].map(r => r.xml).filter(Boolean).slice(0, 20);
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
  } catch(err) { res.json({ error: err.message }); }
});

// ── /api/produtos ─────────────────────────────────────────
app.get('/api/produtos', async (req, res) => {
  const { xmlUrl } = req.query;
  if (!xmlUrl) return res.json({ error: 'xmlUrl obrigatorio.' });
  try {
    const fetch = (await import('node-fetch')).default;
    const resp  = await fetch(xmlUrl, { timeout: 15000 });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const produtos = parseXmlProdutos(await resp.text());
    res.json({ produtos, total: produtos.length });
  } catch (err) { res.json({ error: err.message }); }
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
