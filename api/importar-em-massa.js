// Substitui importarEmMassa e limparColecao do polyfill.js original.
// Usa transação em lote do libsql (equivalente ao db.batch() do Firestore).
//
// POST   /api/tenant/importar-em-massa?tenantId=X&colecao=lojas   body: { rows: [...] }
// DELETE /api/tenant/importar-em-massa?tenantId=X&colecao=lojas   (limpa a coleção inteira)
const { getTenantClient } = require('./_tursoClient');

const TABELAS_PAYLOAD = new Set([
  'compradores_matriz', 'compradores_lojas', 'cod_erros_matriz', 'cod_erros_lojas',
  'comerciais', 'lojas', 'manifestos', 'fornecedores', 'justificativas', 'gruposLoja'
]);
const TABELAS_HISTORICO = new Set(['historico_matriz', 'historico_lojas']);

module.exports = async function handler(req, res) {
  const q = req.query;
  const tenantId = q.tenantId || (req.body && req.body.tenantId);
  const colecao = q.colecao;

  try {
    if (!TABELAS_PAYLOAD.has(colecao) && !TABELAS_HISTORICO.has(colecao)) {
      return res.status(400).json({ ok: false, error: 'Coleção inválida: ' + colecao });
    }
    const db = await getTenantClient(tenantId);

    if (req.method === 'POST') {
      const rows = (req.body && req.body.rows) || [];
      if (!rows.length) return res.status(200).json({ ok: true, importados: 0 });

      const CHUNK = 450; // mesmo tamanho de lote do batch() original
      let importados = 0;
      let primeiroId = null;
      const agora = new Date().toISOString();

      for (let i = 0; i < rows.length; i += CHUNK) {
        const parte = rows.slice(i, i + CHUNK);
        const statements = parte.map(row => {
          if (TABELAS_HISTORICO.has(colecao)) {
            const { data, danf, loja, fornecedor, erroDesc, comprador, status, situacao, ...resto } = row;
            return {
              sql: `INSERT INTO ${colecao} (data, danf, loja, fornecedor, erroDesc, comprador, status, situacao, payload, atualizadoEm) VALUES (?,?,?,?,?,?,?,?,?,?)`,
              args: [data || null, danf || null, loja || null, fornecedor || null, erroDesc || null,
                     comprador || null, status || null, situacao || null, JSON.stringify(resto), agora]
            };
          }
          return { sql: `INSERT INTO ${colecao} (payload) VALUES (?)`, args: [JSON.stringify(row)] };
        });
        const results = await db.batch(statements, 'write');
        if (primeiroId == null && results[0]) primeiroId = Number(results[0].lastInsertRowid);
        importados += parte.length;
      }

      return res.status(200).json({ ok: true, importados, idInicial: primeiroId });
    }

    if (req.method === 'DELETE') {
      const rs = await db.execute(`SELECT COUNT(*) as total FROM ${colecao}`);
      const total = rs.rows[0] ? Number(rs.rows[0].total) : 0;
      await db.execute(`DELETE FROM ${colecao}`);
      return res.status(200).json({ ok: true, removidos: total });
    }

    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  } catch (e) {
    console.error('[tenant/importar-em-massa] erro:', e);
    return res.status(500).json({ ok: false, error: e.message || 'Erro interno.' });
  }
};
