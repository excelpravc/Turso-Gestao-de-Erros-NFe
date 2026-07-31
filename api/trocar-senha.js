// Substitui o trecho do MultiTenant.js (alterarSenhaVisualizacao) que fazia:
//   window.dbCentral.collection('usuarios').doc(CURRENT_USUARIO_ID).get() → conferir senha atual → .update({senha})
// PUT /api/auth/trocar-senha   body: { id, atual, nova }
const { getAdminClient } = require('../../lib/tursoClient');

module.exports = async function handler(req, res) {
  if (req.method !== 'PUT') return res.status(405).json({ ok: false, error: 'Method not allowed' });
  const { id, atual, nova } = req.body || {};
  if (!id || !atual || !nova) return res.status(400).json({ ok: false, error: 'id, senha atual e nova senha são obrigatórios.' });

  try {
    const admin = getAdminClient();
    const rs = await admin.execute({ sql: 'SELECT senha FROM usuarios WHERE id = ?', args: [id] });
    const row = rs.rows[0];
    if (!row) return res.status(404).json({ ok: false, error: 'Usuário não encontrado.' });
    if (String(atual) !== String(row.senha || '')) {
      return res.status(200).json({ ok: false, msg: 'Senha atual incorreta!' });
    }
    await admin.execute({ sql: 'UPDATE usuarios SET senha = ? WHERE id = ?', args: [nova, id] });
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('[auth/trocar-senha] erro:', e);
    return res.status(500).json({ ok: false, error: e.message || 'Erro interno.' });
  }
};
