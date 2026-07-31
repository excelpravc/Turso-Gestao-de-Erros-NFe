// Substitui saveSenhaSistema do polyfill.js original — mantém a validação
// da senha atual antes de trocar (regra de negócio que não pode virar um
// PUT genérico em config.js, pois tem lógica própria).
//
// PUT /api/tenant/senha-sistema?tenantId=X   body: { atual, nova }
const { getTenantClient, getAdminClient } = require('../../lib/tursoClient');

module.exports = async function handler(req, res) {
  if (req.method !== 'PUT') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  const tenantId = req.query.tenantId || req.body.tenantId;
  const { atual, nova } = req.body || {};

  try {
    const db = await getTenantClient(tenantId);
    const rs = await db.execute({ sql: 'SELECT valor FROM config WHERE chave = ?', args: ['sistema'] });
    const cfgAtual = rs.rows[0] ? JSON.parse(rs.rows[0].valor) : {};
    const senhaSalva = cfgAtual.senha || '@mudar';

    if (String(atual) !== String(senhaSalva)) {
      return res.status(200).json({ ok: false, msg: 'Senha atual incorreta!' });
    }

    const novoValor = Object.assign({}, cfgAtual, { senha: nova });
    await db.execute({
      sql: 'INSERT INTO config (chave, valor) VALUES (?, ?) ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor',
      args: ['sistema', JSON.stringify(novoValor)]
    });

    try {
      const admin = getAdminClient();
      await admin.execute({
        sql: 'UPDATE usuarios SET senhaSistemaAtual = ?, senhaSistemaAtualizadaEm = ? WHERE id = ?',
        args: [nova, new Date().toISOString(), tenantId]
      });
    } catch (e) {
      console.error('[tenant/senha-sistema] falha ao espelhar senha no diretório central:', e);
    }

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('[tenant/senha-sistema] erro:', e);
    return res.status(500).json({ ok: false, error: e.message || 'Erro interno.' });
  }
};
