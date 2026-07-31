// POST /api/auth/login  { usuario, senha, modo }
//   modo = 'view' → confere a Senha de Visualização (campo `senha` do diretório central) — igual ao original.
//   modo = 'edit' → confere contra a Senha do Sistema gravada no banco do PRÓPRIO tenant
//                    (equivalente a _lerSenhaEdicaoTenantAtual + comparação no MultiTenant.js original).
// Substitui: window.dbCentral.collection('usuarios').where('usuario','==',usuario).limit(1).get()
const { getAdminClient, getTenantClient } = require('../../lib/tursoClient');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  const { usuario, senha, modo } = req.body || {};
  if (!usuario || !senha) return res.status(400).json({ ok: false, error: 'usuario e senha são obrigatórios.' });

  try {
    const admin = getAdminClient();
    const rs = await admin.execute({
      sql: 'SELECT * FROM usuarios WHERE usuario = ? LIMIT 1',
      args: [String(usuario).trim()]
    });
    const row = rs.rows[0];
    if (!row) return res.status(401).json({ ok: false, error: 'Usuário ou senha inválidos.' });
    if (!row.ativo) return res.status(403).json({ ok: false, error: 'Usuário inativo.' });

    // ── ADMIN: sempre confere contra a senha do diretório central, ignora modo ──
    if (row.isAdmin) {
      if (String(row.senha) !== String(senha)) return res.status(401).json({ ok: false, error: 'Usuário ou senha inválidos.' });
      return res.status(200).json({
        ok: true,
        usuario: { id: row.id, usuario: row.usuario, empresa: row.empresa, isAdmin: true }
      });
    }

    // ── CLIENTE: precisa ter banco Turso configurado ──
    if (!row.tursoUrl || !row.tursoToken) {
      return res.status(400).json({ ok: false, error: 'Este usuário ainda não tem um banco configurado. Fale com o administrador.' });
    }

    if (modo === 'edit') {
      const tenantDb = await getTenantClient(row.id);
      const cfgRs = await tenantDb.execute({ sql: "SELECT valor FROM config WHERE chave = 'sistema'", args: [] });
      const cfg = cfgRs.rows[0] ? JSON.parse(cfgRs.rows[0].valor) : {};
      const senhaEdicaoAtual = cfg.senha || '@mudar';
      if (String(senha) !== String(senhaEdicaoAtual)) return res.status(401).json({ ok: false, error: 'Usuário ou senha inválidos.' });
      return res.status(200).json({
        ok: true,
        modo: 'edit',
        senhaEdicaoAtual, // o frontend usa isso pra popular a variável global SENHA_EDICAO, igual ao original
        usuario: { id: row.id, usuario: row.usuario, empresa: row.empresa, isAdmin: false }
      });
    }

    // modo 'view' (padrão)
    if (String(row.senha) !== String(senha)) return res.status(401).json({ ok: false, error: 'Usuário ou senha inválidos.' });
    return res.status(200).json({
      ok: true,
      modo: 'view',
      usuario: { id: row.id, usuario: row.usuario, empresa: row.empresa, isAdmin: false }
    });
  } catch (e) {
    console.error('[auth/login] erro:', e);
    return res.status(500).json({ ok: false, error: 'Erro ao autenticar.' });
  }
};
