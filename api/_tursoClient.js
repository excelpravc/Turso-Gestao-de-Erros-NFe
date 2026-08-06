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

// ════════════════════════════════════════════════════════════════
//  Cria automaticamente TODAS as tabelas necessárias no banco Turso
//  de um cliente novo — equivalente ao que o Firebase fazia sozinho
//  ao gravar o primeiro documento numa coleção nova. Como SQLite
//  não cria tabela "na marra" ao inserir, isso roda 1x (ou toda vez
//  que salvarmos o usuário) logo depois que a URL/Token do Turso
//  desse cliente forem informados no Painel Admin.
//  Usa "IF NOT EXISTS" em tudo, então é seguro rodar mais de uma vez
//  (ex.: se o ADM editar o usuário e resalvar) sem apagar dados.
// ════════════════════════════════════════════════════════════════
const TABELAS_PAYLOAD_SIMPLES = [
  'compradores_matriz', 'compradores_lojas',
  'cod_erros_matriz', 'cod_erros_lojas',
  'comerciais', 'lojas', 'manifestos', 'fornecedores',
  'justificativas', 'gruposLoja'
];

async function criarSchemaTenant(tursoUrl, tursoToken) {
  const db = getTemporaryTenantClient(tursoUrl, tursoToken);

  const statements = [
    `CREATE TABLE IF NOT EXISTS config (
      chave TEXT PRIMARY KEY,
      valor TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS regras (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      codErro TEXT,
      descErro TEXT,
      destinatarios TEXT,
      criadoEm TEXT
    )`,
    ...TABELAS_PAYLOAD_SIMPLES.map(t =>
      `CREATE TABLE IF NOT EXISTS ${t} (id INTEGER PRIMARY KEY AUTOINCREMENT, payload TEXT)`
    ),
    `CREATE TABLE IF NOT EXISTS historico_matriz (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      data TEXT, danf TEXT, loja TEXT, fornecedor TEXT,
      erroDesc TEXT, comprador TEXT, status TEXT, situacao TEXT, payload TEXT,
      atualizadoEm TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS historico_lojas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      data TEXT, danf TEXT, loja TEXT, fornecedor TEXT,
      erroDesc TEXT, comprador TEXT, status TEXT, situacao TEXT, payload TEXT,
      atualizadoEm TEXT
    )`,
    // Índices na coluna danf — sem isso, toda vez que uma NF é marcada
    // como "Lançada" (UPDATE ... WHERE danf = ?) o SQLite escaneia a
    // tabela INTEIRA pra achar a linha, o que consome cota de "rows
    // read" do Turso proporcional ao tamanho da tabela a cada clique.
    // Com o índice, vai direto na linha certa.
    `CREATE INDEX IF NOT EXISTS idx_historico_matriz_danf ON historico_matriz(danf)`,
    `CREATE INDEX IF NOT EXISTS idx_historico_lojas_danf ON historico_lojas(danf)`,
    // Índice em atualizadoEm — usado pelo polling do frontend (modo=delta)
    // para saber quais registros mudaram desde a última checagem, incluindo
    // UPDATEs (não só INSERTs novos).
    `CREATE INDEX IF NOT EXISTS idx_historico_matriz_atualizado ON historico_matriz(atualizadoEm)`,
    `CREATE INDEX IF NOT EXISTS idx_historico_lojas_atualizado ON historico_lojas(atualizadoEm)`
  ];

  for (const sql of statements) {
    await db.execute(sql);
  }

  // Migração pra bancos de tenant que já existiam ANTES desta coluna —
  // CREATE TABLE IF NOT EXISTS não adiciona coluna em tabela já criada.
  // SQLite não tem "ADD COLUMN IF NOT EXISTS", então tentamos e ignoramos
  // o erro "duplicate column" se ela já tiver sido adicionada antes.
  const migracoes = [
    `ALTER TABLE historico_matriz ADD COLUMN atualizadoEm TEXT`,
    `ALTER TABLE historico_lojas ADD COLUMN atualizadoEm TEXT`
  ];
  for (const sql of migracoes) {
    try { await db.execute(sql); } catch (e) {
      if (!/duplicate column/i.test(e.message || '')) throw e;
    }
  }
}

module.exports = { getAdminClient, getTenantClient, getTemporaryTenantClient, criarSchemaTenant };
