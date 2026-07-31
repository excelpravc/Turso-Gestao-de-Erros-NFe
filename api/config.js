// Substitui loadAssinatura/saveAssinatura/loadSenhaSistema/saveSenhaSistema/
// loadEmailRecuperacao/saveEmailRecuperacao do polyfill.js original.
//
// GET /api/tenant/config?tenantId=X&chave=sistema
// PUT /api/tenant/config?tenantId=X   body: { chave, valor: {...}, merge: true }
const { getTenantClient, getAdminClient } = require('./_tursoClient');

module.exports = async function handler(req, res) {
  const q = req.query;
  const body = req.body || {};
  const tenantId = q.tenantId || body.tenantId;

  try {
    const db = await getTenantClient(tenantId);

    if (req.method === 'GET') {
      const rs = await db.execute({ sql: 'SELECT valor FROM config WHERE chave = ?', args: [q.chave] });
      const row = rs.rows[0];
      return res.status(200).json({ ok: true, valor: row ? JSON.parse(row.valor) : null });
    }

    if (req.method === 'PUT') {
      const { chave, valor, merge } = body;
      if (!chave) return res.status(400).json({ ok: false, error: 'chave é obrigatória.' });

      let novoValor = valor || {};
      if (merge) {
        const atual = await db.execute({ sql: 'SELECT valor FROM config WHERE chave = ?', args: [chave] });
        const base = atual.rows[0] ? JSON.parse(atual.rows[0].valor) : {};
        novoValor = Object.assign({}, base, valor);
      }

      await db.execute({
        sql: 'INSERT INTO config (chave, valor) VALUES (?, ?) ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor',
        args: [chave, JSON.stringify(novoValor)]
      });

      // Espelha a senha do sistema no diretório central, igual ao
      // comportamento original de saveSenhaSistema (mirror pro dbCentral).
      if (chave === 'sistema' && novoValor.senha) {
        try {
          const admin = getAdminClient();
          await admin.execute({
            sql: 'UPDATE usuarios SET senhaSistemaAtual = ?, senhaSistemaAtualizadaEm = ? WHERE id = ?',
            args: [novoValor.senha, new Date().toISOString(), tenantId]
          });
        } catch (e) {
          console.error('[tenant/config] falha ao espelhar senha no diretório central:', e);
        }
      }

      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  } catch (e) {
    console.error('[tenant/config] erro:', e);
    return res.status(500).json({ ok: false, error: e.message || 'Erro interno.' });
  }
};
