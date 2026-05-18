const express  = require('express');
const mysql    = require('mysql2/promise');
const path     = require('path');

const app  = express();
const PORT = process.env.PORT || 3001;

// ── Conexão MySQL ─────────────────────────────────────────
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

// ── CORS ──────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  next();
});

// ── Serve o index.html ────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Campos das notas ──────────────────────────────────────
const CAMPOS = `
  id, numero, serie, chaveacesso, dataemissao, situacao,
  contato_nome, contato_numerodocumento, contato_email, contato_telefone,
  contato_endereco_endereco, contato_endereco_numero, contato_endereco_bairro,
  contato_endereco_municipio, contato_endereco_uf, contato_endereco_cep,
  contato_endereco_complemento,
  transporte_transportador_nome, transporte_transportador_numerodocumento,
  transporte_freteporconta,
  x_total_icmstot_vnf, x_total_icmstot_vprod,
  x_total_icmstot_vdesc, x_total_icmstot_vfrete,
  linkdanfe, linkpdf, xml
`.trim();

// ── GET /api/notas ────────────────────────────────────────
// ?from=2026-01-01&to=2026-03-31&offset=0
app.get('/api/notas', async (req, res) => {
  const { from, to, offset = 0 } = req.query;
  if (!from || !to) return res.json({ error: 'Parâmetros from e to obrigatórios.' });

  const d1  = from + ' 00:00:00';
  const d2  = to   + ' 23:59:59';
  const off = parseInt(offset) || 0;
  const PAGE = 300;

  try {
    const conn = await pool.getConnection();

    // Total geral (só no offset 0)
    let total = null;
    if (off === 0) {
      const [[row]] = await conn.execute(
        `SELECT
          (SELECT COUNT(*) FROM \`bling_nfe_saida_detalhes_ecommerce\`   WHERE dataemissao BETWEEN ? AND ?) +
          (SELECT COUNT(*) FROM \`bling_nfe_saida_detalhes_distribuicao\` WHERE dataemissao BETWEEN ? AND ?) AS total`,
        [d1, d2, d1, d2]
      );
      total = row.total;
    }

    // Quantas notas de ecommerce no período
    const [[{ countEco }]] = await conn.execute(
      `SELECT COUNT(*) AS countEco FROM \`bling_nfe_saida_detalhes_ecommerce\` WHERE dataemissao BETWEEN ? AND ?`,
      [d1, d2]
    );

    // Calcula offsets para cada tabela
    let notas = [];
    let offE = 0, limE = 0, offD = 0, limD = 0;

    if (off < countEco) {
      offE = off;
      limE = PAGE;
      const sobra = PAGE - Math.min(PAGE, countEco - off);
      offD = 0;
      limD = sobra;
    } else {
      offD = off - countEco;
      limD = PAGE;
    }

    if (limE > 0) {
      const [rows] = await conn.execute(
        `SELECT ${CAMPOS}, 'ecommerce' AS origem FROM \`bling_nfe_saida_detalhes_ecommerce\`
         WHERE dataemissao BETWEEN ? AND ? ORDER BY dataemissao DESC LIMIT ${limE} OFFSET ${offE}`,
        [d1, d2]
      );
      notas = notas.concat(rows.map(r => montarNota(r)));
    }

    if (limD > 0) {
      const [rows] = await conn.execute(
        `SELECT ${CAMPOS}, 'distribuidor' AS origem FROM \`bling_nfe_saida_detalhes_distribuicao\`
         WHERE dataemissao BETWEEN ? AND ? ORDER BY dataemissao DESC LIMIT ${limD} OFFSET ${offD}`,
        [d1, d2]
      );
      notas = notas.concat(rows.map(r => montarNota(r)));
    }

    // Pesos dos volumes pelos IDs desta página
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

      const pesoMap = {};
      [...pesosE, ...pesosD].forEach(p => {
        pesoMap[p.nfe_id] = {
          pesoBruto:   p.x_transp_vol_pesob,
          pesoLiquido: p.x_transp_vol_pesol,
          qtdVolumes:  p.x_transp_vol_qvol
        };
      });
      notas.forEach(n => {
        const p = pesoMap[n.id];
        if (p) { n.pesoBruto = p.pesoBruto; n.pesoLiquido = p.pesoLiquido; n.qtdVolumes = p.qtdVolumes; }
      });
    }

    conn.release();

    // Ordena por data desc
    notas.sort((a, b) => {
      const da = a.dataemissao ? new Date(a.dataemissao).getTime() : 0;
      const db = b.dataemissao ? new Date(b.dataemissao).getTime() : 0;
      return db - da;
    });

    res.json({
      notas,
      offset:   off,
      pageSize: PAGE,
      total,
      hasMore:  notas.length === PAGE
    });

  } catch (err) {
    console.error(err);
    res.json({ error: err.message });
  }
});

// ── GET /api/produtos-lista ───────────────────────────────
// Retorna lista de produtos únicos das notas do período (via XML parsing seria lento,
// então usa os nomes das notas já carregadas — endpoint separado busca do banco de produtos)
// ?from=...&to=...
app.get('/api/produtos-lista', async (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) return res.json({ error: 'Parâmetros from e to obrigatórios.' });
  const d1 = from + ' 00:00:00';
  const d2 = to   + ' 23:59:59';
  try {
    const conn = await pool.getConnection();
    // Busca XMLs das notas do período para extrair produtos únicos
    const [rowsE] = await conn.execute(
      'SELECT xml FROM `bling_nfe_saida_detalhes_ecommerce` WHERE dataemissao BETWEEN ? AND ? AND xml IS NOT NULL AND xml != ""',
      [d1, d2]
    );
    const [rowsD] = await conn.execute(
      'SELECT xml FROM `bling_nfe_saida_detalhes_distribuicao` WHERE dataemissao BETWEEN ? AND ? AND xml IS NOT NULL AND xml != ""',
      [d1, d2]
    );
    conn.release();

    // Coleta URLs únicas de XML e busca produtos em paralelo (máx 20 XMLs para não travar)
    const urls = [...rowsE, ...rowsD].map(r => r.xml).filter(Boolean).slice(0, 20);
    const fetch = (await import('node-fetch')).default;
    const prodMap = {};

    await Promise.all(urls.map(async url => {
      try {
        const r = await fetch(url, { timeout: 8000 });
        if (!r.ok) return;
        const xml = await r.text();
        parseXmlProdutos(xml).forEach(p => {
          const key = p.codigo || p.nome;
          if (key && !prodMap[key]) prodMap[key] = { codigo: p.codigo, nome: p.nome };
        });
      } catch(e) {}
    }));

    const produtos = Object.values(prodMap).sort((a,b) => (a.nome||'').localeCompare(b.nome||''));
    res.json({ produtos, total: produtos.length });
  } catch(err) {
    res.json({ error: err.message });
  }
});


// ?xmlUrl=https://...
app.get('/api/produtos', async (req, res) => {
  const { xmlUrl } = req.query;
  if (!xmlUrl) return res.json({ error: 'xmlUrl obrigatório.' });

  try {
    const fetch = (await import('node-fetch')).default;
    const resp  = await fetch(xmlUrl, { timeout: 15000 });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const xml = await resp.text();
    const produtos = parseXmlProdutos(xml);
    res.json({ produtos, total: produtos.length });
  } catch (err) {
    res.json({ error: err.message });
  }
});

// ── Parse XML de produtos ─────────────────────────────────
function parseXmlProdutos(xml) {
  const produtos = [];
  const dets = xml.match(/<det\b[^>]*>[\s\S]*?<\/det>/g) || [];
  dets.forEach(det => {
    const prod = det.match(/<prod>([\s\S]*?)<\/prod>/);
    if (!prod) return;
    const p = prod[1];
    produtos.push({
      codigo:    tag(p, 'cProd'),
      nome:      tag(p, 'xProd'),
      ncm:       tag(p, 'NCM'),
      cfop:      tag(p, 'CFOP'),
      unidade:   tag(p, 'uCom'),
      qtd:       parseFloat(tag(p, 'qCom'))   || 0,
      valorUnit: parseFloat(tag(p, 'vUnCom')) || 0,
      valor:     parseFloat(tag(p, 'vProd'))  || 0,
      desconto:  parseFloat(tag(p, 'vDesc'))  || 0
    });
  });
  return produtos;
}

function tag(xml, name) {
  const m = xml.match(new RegExp('<' + name + '>([^<]*)</' + name + '>'));
  return m ? m[1] : '';
}

// ── Montar objeto nota ────────────────────────────────────
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
    pesoBruto:          null,
    pesoLiquido:        null,
    qtdVolumes:         null
  };
}

app.listen(PORT, () => console.log('NF-e API rodando na porta ' + PORT));
