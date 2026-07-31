// GET    /api/admin/usuarios                → lista todos (ordenado por usuario)
// GET    /api/admin/usuarios?id=X            → detalhe de um cliente
// POST   /api/admin/usuarios   body: {...}   → cria cliente novo
// PUT    /api/admin/usuarios   body: {id,...}→ atualiza cliente existente
// DELETE /api/admin/usuarios?id=X            → remove só o ACESSO (não apaga o banco Turso do cliente)
//
// IMPORTANTE: esta rota deve ser protegida por sessão/isAdmin no
// middleware de autenticação da aplicação (fora do escopo deste
// arquivo) — no Firestore original a proteção vinha das regras de
// segurança do projeto; aqui precisa ser feita explicitamente aqui
// ou num middleware comum, senão qualquer um pode listar clientes.
const { getAdminClient } = require('../../lib/tursoClient');

module.exports = async function handler(req, res) {
  try {
    const admin = getAdminClient();

    if (req.method === 'GET') {
      if (req.query.id) {
        const rs = await admin.execute({ sql: 'SELECT * FROM usuarios WHERE id = ?', args: [req.query.id] });
        return res.status(200).json({ ok: true, usuario: rs.rows[0] || null });
      }
      const rs = await admin.execute('SELECT * FROM usuarios ORDER BY usuario ASC');
      return res.status(200).json({ ok: true, usuarios: rs.rows });
    }

    if (req.method === 'POST') {
      const d = req.body || {};
      const id = d.id || ('u_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8));
      await admin.execute({
        sql: `INSERT INTO usuarios (id, usuario, senha, empresa, ativo, isAdmin, tursoUrl, tursoToken)
              VALUES (?,?,?,?,?,?,?,?)`,
        args: [id, d.usuario, d.senha, d.empresa || null, d.ativo === false ? 0 : 1, d.isAdmin ? 1 : 0,
               d.tursoUrl || null, d.tursoToken || null]
      });
      return res.status(200).json({ ok: true, id });
    }

    if (req.method === 'PUT') {
      const d = req.body || {};
      if (!d.id) return res.status(400).json({ ok: false, error: 'id é obrigatório.' });
      const atual = await admin.execute({ sql: 'SELECT * FROM usuarios WHERE id = ?', args: [d.id] });
      if (!atual.rows[0]) return res.status(404).json({ ok: false, error: 'Cliente não encontrado.' });
      const base = atual.rows[0];
      const merged = Object.assign({}, base, d); // merge: true, igual ao .set(dados,{merge:true}) original
      await admin.execute({
        sql: `UPDATE usuarios SET usuario=?, senha=?, empresa=?, ativo=?, isAdmin=?, tursoUrl=?, tursoToken=? WHERE id=?`,
        args: [merged.usuario, merged.senha, merged.empresa || null, merged.ativo ? 1 : 0, merged.isAdmin ? 1 : 0,
               merged.tursoUrl || null, merged.tursoToken || null, d.id]
      });
      return res.status(200).json({ ok: true });
    }

    if (req.method === 'DELETE') {
      const id = req.query.id;
      if (!id) return res.status(400).json({ ok: false, error: 'id é obrigatório.' });
      // Mesma observação do original: isso remove só o acesso (linha no
      // diretório), não apaga o banco Turso de dados do cliente — precisa
      // ser feito manualmente no dashboard do Turso, se for o caso.
      await admin.execute({ sql: 'DELETE FROM usuarios WHERE id = ?', args: [id] });
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  } catch (e) {
    console.error('[admin/usuarios] erro:', e);
    return res.status(500).json({ ok: false, error: e.message || 'Erro interno.' });
  }
};
