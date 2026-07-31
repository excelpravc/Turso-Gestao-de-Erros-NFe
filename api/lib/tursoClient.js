// ════════════════════════════════════════════════════════════════
//  tursoClient.js — substitui firebase-init.js no lado do SERVIDOR.
//  Mantém um client @libsql/client em cache por tenant (equivalente
//  a reaproveitar o app 'tenant' do firebase quando é o mesmo
//  projectId, como o firebase-init.js original já fazia).
// ════════════════════════════════════════════════════════════════
const { createClient } = require('@libsql/client');

// ── Banco admin (diretório central, único, fixo) ──
let _adminClient = null;
function getAdminClient() {
  if (_adminClient) return _adminClient;
  const url = process.env.TURSO_ADMIN_URL;
  const authToken = process.env.TURSO_ADMIN_TOKEN;
  if (!url || !authToken) {
    throw new Error('TURSO_ADMIN_URL / TURSO_ADMIN_TOKEN não configurados nas variáveis de ambiente da Vercel.');
  }
  _adminClient = createClient({ url, authToken });
  return _adminClient;
}

// ── Bancos de tenant (um por cliente) ──
// Cache simples em memória do processo serverless. Como cada
// invocação da função pode rodar numa instância "fria" diferente,
// isso não é garantia de reaproveitamento entre requests como no
// browser (SPA de sessão longa) — mas evita reconexões repetidas
// dentro da mesma invocação/instância quente.
const _tenantClients = new Map(); // tenantId -> client

async function getTenantClient(tenantId) {
  if (!tenantId) throw new Error('tenantId não informado.');
  if (_tenantClients.has(tenantId)) return _tenantClients.get(tenantId);

  const admin = getAdminClient();
  const rs = await admin.execute({
    sql: 'SELECT tursoUrl, tursoToken, ativo FROM usuarios WHERE id = ?',
    args: [tenantId]
  });
  const row = rs.rows[0];
  if (!row) throw new Error('Cliente (tenant) não encontrado no diretório central.');
  if (!row.ativo) throw new Error('Este cliente está inativo.');
  if (!row.tursoUrl || !row.tursoToken) throw new Error('Este cliente ainda não tem banco Turso configurado.');

  const client = createClient({ url: row.tursoUrl, authToken: row.tursoToken });
  _tenantClients.set(tenantId, client);
  return client;
}

// Usado pelo Painel Admin quando ele precisa abrir uma conexão
// TEMPORÁRIA com o banco de um cliente específico (ex.: ler/gravar a
// senha do sistema direto no tenant), sem passar pelo cache — mesmo
// papel que _lerSenhaSistemaDoTenant/_escreverSenhaSistemaNoTenant
// faziam no MultiTenant.js original com firebase.initializeApp(cfg, nomeApp).
function getTemporaryTenantClient(tursoUrl, tursoToken) {
  if (!tursoUrl || !tursoToken) throw new Error('Configuração Turso incompleta.');
  return createClient({ url: tursoUrl, authToken: tursoToken });
}

module.exports = { getAdminClient, getTenantClient, getTemporaryTenantClient };
