// GET    /api/tenant/data?tenantId=X&colecao=lojas                → lista tudo (equivalente a _loadColl)
// POST   /api/tenant/data?tenantId=X&colecao=lojas   body: {...}  → insere (equivalente a _add)
// PUT    /api/tenant/data?tenantId=X&colecao=lojas   body: {id,...} → atualiza (equivalente a _update)
// DELETE /api/tenant/data?tenantId=X&colecao=lojas&id=123          → apaga (equivalente a _delete)
const { getTenantClient } = require('./_tursoClient');

// Só tabelas "genéricas" (payload JSON) passam por aqui.
// Histórico tem rota própria (colunas indexadas), config também.
const TABELAS_PERMITIDAS = new Set([
  'compradores_matriz', 'compradores_lojas',
  'cod_erros_matriz', 'cod_erros_lojas',
  'comerciais', 'lojas', 'manifestos', 'fornecedores',
  'justificativas', 'gruposLoja', 'regras'
]);

function validarColecao(colecao) {
  if (!TABELAS_PERMITIDAS.has(colecao)) throw new Error('Coleção inválida: ' + colecao);
  return colecao;
}

module.exports = async function handler(req, res) {
  const { tenantId, colecao, id } = req.method === 'GET' || req.method === 'DELETE' ? req.query : { ...req.query, ...req.body };
  try {
    const tabela = validarColecao(colecao);
    const db = await getTenantClient(tenantId);

    if (req.method === 'GET') {
      // regras tem colunas próprias; as demais são payload JSON
      if (tabela === 'regras') {
        const rs = await db.execute('SELECT id, codErro, descErro, destinatarios, criadoEm FROM regras ORDER BY id ASC');
        return res.status(200).json({ ok: true, rows: rs.rows });
      }
      const rs = await db.execute(`SELECT id, payload FROM ${tabela} ORDER BY id ASC`);
      const rows = rs.rows.map(r => Object.assign({}, JSON.parse(r.payload || '{}'), { id: r.id }));
      return res.status(200).json({ ok: true, rows });
    }

    if (req.method === 'POST') {
      const data = req.body || {};
      if (tabela === 'regras') {
        const rs = await db.execute({
          sql: 'INSERT INTO regras (codErro, descErro, destinatarios, criadoEm) VALUES (?, ?, ?, ?)',
          args: [data.codErro || null, data.descErro || null, data.destinatarios || null, data.criadoEm || null]
        });
        return res.status(200).json({ ok: true, id: Number(rs.lastInsertRowid) });
      }
      const payload = JSON.stringify(Object.assign({}, data));
      const rs = await db.execute({ sql: `INSERT INTO ${tabela} (payload) VALUES (?)`, args: [payload] });
      return res.status(200).json({ ok: true, id: Number(rs.lastInsertRowid) });
    }

    if (req.method === 'PUT') {
      const data = req.body || {};
      if (data.id == null) return res.status(400).json({ ok: false, error: 'id é obrigatório para update.' });
      if (tabela === 'regras') {
        await db.execute({
          sql: 'UPDATE regras SET codErro = ?, descErro = ?, destinatarios = ?, criadoEm = ? WHERE id = ?',
          args: [data.codErro || null, data.descErro || null, data.destinatarios || null, data.criadoEm || null, data.id]
        });
        return res.status(200).json({ ok: true });
      }
      // merge: true equivalente — lê o payload atual, faz merge, regrava
      const atual = await db.execute({ sql: `SELECT payload FROM ${tabela} WHERE id = ?`, args: [data.id] });
      const base = atual.rows[0] ? JSON.parse(atual.rows[0].payload || '{}') : {};
      const merged = Object.assign({}, base, data);
      delete merged.id;
      await db.execute({
        sql: `UPDATE ${tabela} SET payload = ? WHERE id = ?`,
        args: [JSON.stringify(merged), data.id]
      });
      return res.status(200).json({ ok: true });
    }

    if (req.method === 'DELETE') {
      if (id == null) return res.status(400).json({ ok: false, error: 'id é obrigatório.' });
      await db.execute({ sql: `DELETE FROM ${tabela} WHERE id = ?`, args: [id] });
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  } catch (e) {
    console.error('[tenant/data] erro:', e);
    return res.status(500).json({ ok: false, error: e.message || 'Erro interno.' });
  }
};
