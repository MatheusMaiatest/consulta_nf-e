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

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  next();
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

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
      n.linkdanfe, n.linkpdf, n.xml
    `;

    if (limE > 0) {
      // Vínculo 1: notafiscal_id = n.id (notas com pedido já sincronizado)
      const [rows] = await conn.execute(
        `SELECT ${COLS}, COALESCE(p.numero, '') AS numeropedido,
                COALESCE(p.situacao_nome, '') AS pedido_situacao,
                COALESCE(p.numeroloja, '')    AS pedido_numeroloja,
                '' AS pedido_observacoes,
                '' AS pedido_observacoesinternas,
                'ecommerce' AS origem
         FROM \`bling_nfe_saida_detalhes_ecommerce\` n
         LEFT JOIN \`bling_pedidos_venda_detalhes_ecommerce\` p ON p.notafiscal_id = n.id
         WHERE n.dataemissao BETWEEN ? AND ?
         ORDER BY n.dataemissao DESC LIMIT ${limE} OFFSET ${offE}`,
        [d1, d2]
      );
      notas = notas.concat(rows.map(r => montarNota(r)));
    }

    if (limD > 0) {
      const [rows] = await conn.execute(
        `SELECT ${COLS}, COALESCE(p.numero, '') AS numeropedido,
                COALESCE(p.situacao_nome, '')       AS pedido_situacao,
                COALESCE(p.numeroloja, '')           AS pedido_numeroloja,
                COALESCE(p.observacoes, '')          AS pedido_observacoes,
                COALESCE(p.observacoesinternas, '')  AS pedido_observacoesinternas,
                'distribuidor' AS origem
         FROM \`bling_nfe_saida_detalhes_distribuicao\` n
         LEFT JOIN \`bling_pedidos_venda_detalhes_distribuicao\` p ON p.notafiscal_id = n.id
         WHERE n.dataemissao BETWEEN ? AND ?
         ORDER BY n.dataemissao DESC LIMIT ${limD} OFFSET ${offD}`,
        [d1, d2]
      );
      notas = notas.concat(rows.map(r => montarNota(r)));
    }

    // Vínculo 2: para notas sem pedido, busca pelo CPF do contato
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
          if (!cpfPedidoMap[r.contato_numerodocumento])
            cpfPedidoMap[r.contato_numerodocumento] = r;
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
          if (!cpfPedidoMap[r.contato_numerodocumento])
            cpfPedidoMap[r.contato_numerodocumento] = r;
        });
      }

      notas.forEach(n => {
        if (!n.numeropedido && n.cpf && cpfPedidoMap[n.cpf]) {
          const p = cpfPedidoMap[n.cpf];
          n.numeropedido            = p.numero            || null;
          n.pedido_situacao         = p.situacao_nome     || null;
          n.pedido_numeroloja       = p.numeroloja        || null;
          n.pedido_observacoes      = p.observacoes       || null;
          n.pedido_observacoesinternas = p.observacoesinternas || null;
        }
      });
    }

    // Pesos pelos IDs desta página
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
      notas.forEach(n => { const p = pm[n.id]; if (p) { n.pesoBruto = p.pesoBruto; n.pesoLiquido = p.pesoLiquido; n.qtdVolumes = p.qtdVolumes; } });
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
      } catch(e) {}
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
  return {
    id:                 r.id,
    origem:             r.origem,
    numero:             r.numero,
    serie:              r.serie,
    chaveacesso:        r.chaveacesso,
    dataemissao:        r.dataemissao ? new Date(r.dataemissao).toISOString() : null,
    situacao:           r.situacao,
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
    numeropedido:       r.numeropedido       || null,
    pedido_situacao:    r.pedido_situacao    || null,
    numeropedido:       r.numeropedido      || null,
    pedido_situacao:    r.pedido_situacao   || null,
    pedido_numeroloja:  r.pedido_numeroloja || null,
    pedido_observacoes: r.pedido_observacoes && r.pedido_observacoes.trim() ? r.pedido_observacoes.trim() : null,
    pedido_observacoesinternas: r.pedido_observacoesinternas && r.pedido_observacoesinternas.trim() ? r.pedido_observacoesinternas.trim() : null,
    pesoBruto:          null,
    pesoLiquido:        null,
    qtdVolumes:         null
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
