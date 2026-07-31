// Substitui os handlers de histórico do polyfill.js original (loadHistFiltrado,
// loadHistUltimos, buscarDanfNoHistorico, addHistorico, updateHistorico,
// deleteHistorico, updateHistoricoSituacaoPorDANF).
//
// GET  /api/tenant/historico?tenantId=X&perfil=matriz&modo=filtrado&de=YYYY-MM-DD&ate=YYYY-MM-DD
// GET  /api/tenant/historico?tenantId=X&perfil=matriz&modo=ultimos&limite=100&cursorId=500
// GET  /api/tenant/historico?tenantId=X&perfil=matriz&modo=danf&danf=12345
// POST /api/tenant/historico?tenantId=X                body: {perfil, data, danf, loja, fornecedor, erroDesc, comprador, status, situacao, ...resto}
// PUT  /api/tenant/historico?tenantId=X                body: {id, perfil, ...campos}
// PUT  /api/tenant/historico?tenantId=X&modo=situacao-por-danf  body: {danf, loja, perfil}
// DELETE /api/tenant/historico?tenantId=X&id=123&perfil=matriz
const { getTenantClient } = require('./_tursoClient');

function tabela(perfil) {
  return (String(perfil || '').toLowerCase() === 'matriz') ? 'historico_matriz' : 'historico_lojas';
}

function hojeBR() {
  const d = new Date();
  return String(d.getDate()).padStart(2, '0') + '/' + String(d.getMonth() + 1).padStart(2, '0') + '/' + d.getFullYear();
}
function parseDataBR(s) {
  if (!s || typeof s !== 'string') return '1900-01-01';
  const p = s.trim().split('/');
  if (p.length === 3 && p[2].length === 4) return `${p[2]}-${p[1].padStart(2,'0')}-${p[0].padStart(2,'0')}`;
  return '1900-01-01';
}

// Colunas indexadas vs. resto (guardado em payload)
const COLS_PROPRIAS = ['data', 'danf', 'loja', 'fornecedor', 'erroDesc', 'comprador', 'status', 'situacao'];

function linhaParaObjeto(row) {
  const extra = row.payload ? JSON.parse(row.payload) : {};
  return Object.assign({}, extra, {
    id: row.id, data: row.data, danf: row.danf, loja: row.loja, fornecedor: row.fornecedor,
    erroDesc: row.erroDesc, comprador: row.comprador, status: row.status, situacao: row.situacao
  });
}

module.exports = async function handler(req, res) {
  const q = req.method === 'GET' || req.method === 'DELETE' ? req.query : { ...req.query };
  const body = req.body || {};
  const tenantId = q.tenantId || body.tenantId;

  try {
    const db = await getTenantClient(tenantId);

    if (req.method === 'GET') {
      const t = tabela(q.perfil);

      if (q.modo === 'filtrado') {
        // Filtragem por data feita no SQLite direto (data BR não ordena bem em texto,
        // por isso mantemos a comparação em app-side com parseDataBR como no original,
        // mas já restringindo por índice de `data` quando possível para reduzir scan).
        const rs = await db.execute(`SELECT * FROM ${t}`);
        const rows = rs.rows.map(linhaParaObjeto).filter(r => {
          const d = parseDataBR(r.data);
          return d >= q.de && d <= q.ate;
        });
        return res.status(200).json({ ok: true, rows });
      }

      if (q.modo === 'ultimos') {
        const limite = Number(q.limite) || 100;
        let sql = `SELECT * FROM ${t}`;
        const args = [];
        if (q.cursorId) { sql += ' WHERE id < ?'; args.push(Number(q.cursorId)); }
        sql += ' ORDER BY id DESC LIMIT ?';
        args.push(limite);
        const rs = await db.execute({ sql, args });
        return res.status(200).json({ ok: true, rows: rs.rows.map(linhaParaObjeto) });
      }

      if (q.modo === 'danf') {
        const rs = await db.execute({ sql: `SELECT * FROM ${t} WHERE danf = ?`, args: [String(q.danf || '').trim()] });
        return res.status(200).json({ ok: true, rows: rs.rows.map(linhaParaObjeto) });
      }

      // modo=delta: usado pelo polling do frontend (substitui onSnapshot).
      // Devolve tudo que tem id > sinceId, pra aplicar como "docChanges" incremental.
      if (q.modo === 'delta') {
        const sinceId = Number(q.sinceId) || 0;
        const rs = await db.execute({ sql: `SELECT * FROM ${t} WHERE id > ? ORDER BY id ASC`, args: [sinceId] });
        return res.status(200).json({ ok: true, rows: rs.rows.map(linhaParaObjeto) });
      }

      return res.status(400).json({ ok: false, error: 'modo inválido.' });
    }

    if (req.method === 'POST') {
      const t = tabela(body.perfil);
      const data = Object.assign({}, body);
      if (!data.data) data.data = hojeBR();
      const extra = {};
      Object.keys(data).forEach(k => { if (!COLS_PROPRIAS.includes(k) && k !== 'perfil' && k !== 'tenantId') extra[k] = data[k]; });
      const rs = await db.execute({
        sql: `INSERT INTO ${t} (data, danf, loja, fornecedor, erroDesc, comprador, status, situacao, payload) VALUES (?,?,?,?,?,?,?,?,?)`,
        args: [data.data, data.danf || null, data.loja || null, data.fornecedor || null, data.erroDesc || null,
               data.comprador || null, data.status || null, data.situacao || null, JSON.stringify(extra)]
      });
      return res.status(200).json({ ok: true, id: Number(rs.lastInsertRowid) });
    }

    if (req.method === 'PUT') {
      const t = tabela(body.perfil);

      if (q.modo === 'situacao-por-danf') {
        const { danf, loja } = body;
        let sql = `UPDATE ${t} SET situacao = 'Lançada' WHERE danf = ?`;
        const args = [String(danf || '').trim()];
        if (loja) { sql += ' AND LOWER(TRIM(loja)) = LOWER(TRIM(?))'; args.push(loja); }
        const rs = await db.execute({ sql, args });
        return res.status(200).json({ ok: rs.rowsAffected > 0, totalMarcadas: rs.rowsAffected });
      }

      if (body.id == null) return res.status(400).json({ ok: false, error: 'id é obrigatório.' });
      const atual = await db.execute({ sql: `SELECT * FROM ${t} WHERE id = ?`, args: [body.id] });
      if (!atual.rows[0]) return res.status(404).json({ ok: false, error: 'Registro não encontrado.' });
      const atualObj = linhaParaObjeto(atual.rows[0]);
      const merged = Object.assign({}, atualObj, body);
      const extra = {};
      Object.keys(merged).forEach(k => { if (!COLS_PROPRIAS.includes(k) && k !== 'id' && k !== 'perfil' && k !== 'tenantId') extra[k] = merged[k]; });
      await db.execute({
        sql: `UPDATE ${t} SET data=?, danf=?, loja=?, fornecedor=?, erroDesc=?, comprador=?, status=?, situacao=?, payload=? WHERE id=?`,
        args: [merged.data, merged.danf || null, merged.loja || null, merged.fornecedor || null, merged.erroDesc || null,
               merged.comprador || null, merged.status || null, merged.situacao || null, JSON.stringify(extra), body.id]
      });
      return res.status(200).json({ ok: true });
    }

    if (req.method === 'DELETE') {
      const t = tabela(q.perfil);
      if (q.id == null) return res.status(400).json({ ok: false, error: 'id é obrigatório.' });
      await db.execute({ sql: `DELETE FROM ${t} WHERE id = ?`, args: [q.id] });
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  } catch (e) {
    console.error('[tenant/historico] erro:', e);
    return res.status(500).json({ ok: false, error: e.message || 'Erro interno.' });
  }
};
