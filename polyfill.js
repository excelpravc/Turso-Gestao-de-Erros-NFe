// ════════════════════════════════════════════════════════════════
//  POLYFILL — Intercepta google.script.run e redireciona para a API
//  própria (Vercel) que fala com Turso. A ASSINATURA E O NOME DE
//  CADA FUNÇÃO em HANDLERS são IDÊNTICOS ao polyfill.js original —
//  scripts.js, Perfil_Lojas.js, Perfil_Matriz.js, ImportExcel.js e
//  RecuperarSenha.js continuam chamando google.script.run.* exatamente
//  como chamavam antes. Só a implementação interna trocou.
//
//  Precisa carregar DEPOIS de turso-init.js.
// ════════════════════════════════════════════════════════════════

(function () {
  window.google = window.google || {};
  window.google.script = window.google.script || {};

  function tenantId() {
    const id = window.CURRENT_TENANT_ID || window.dbTenant;
    if (!id) throw new Error('Nenhum cliente logado ainda — faça login antes de usar o sistema.');
    return id;
  }

  // ── Helper genérico de fetch pra API ──
  async function _api(method, path, { query, body } = {}) {
    const params = new URLSearchParams(Object.assign({ tenantId: tenantId() }, query || {}));
    const url = (window.__API_BASE__ || '') + path + '?' + params.toString();
    const resp = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined
    });
    let json;
    try { json = await resp.json(); } catch (e) { json = null; }
    if (!resp.ok || !json || json.ok === false) {
      const msg = (json && json.error) || `Erro na API (${resp.status})`;
      const err = new Error(msg);
      if (resp.status === 429 || /quota/i.test(msg)) {
        err.message = 'Limite de uso do banco foi atingido. Tente novamente mais tarde.';
      }
      throw err;
    }
    return json;
  }

  const COLLECTIONS = {
    comprador: null, // resolvido dinamicamente por perfil (ver _compradoresColl)
    comercial: 'comerciais',
    loja: 'lojas',
    manifesto: 'manifestos',
    codErro: null,   // resolvido dinamicamente por perfil (ver _codErrosColl)
    fornecedor: 'fornecedores',
    justificativa: 'justificativas',
    regra: 'regras',
    grupoLoja: 'gruposLoja'
  };

  function _compradoresColl(perfil) {
    return (String(perfil || '').toLowerCase() === 'matriz') ? 'compradores_matriz' : 'compradores_lojas';
  }
  function _codErrosColl(perfil) {
    return (String(perfil || '').toLowerCase() === 'matriz') ? 'cod_erros_matriz' : 'cod_erros_lojas';
  }

  // ── CRUD genérico (coleções payload JSON) — via /api/data ──
  async function _loadColl(collName) {
    const r = await _api('GET', '/api/data', { query: { colecao: collName } });
    return r.rows;
  }
  async function _add(collName, data) {
    const r = await _api('POST', '/api/data', { query: { colecao: collName }, body: data });
    return { ok: true, id: r.id };
  }
  async function _update(collName, data) {
    if (!data || data.id == null) return { ok: false };
    await _api('PUT', '/api/data', { query: { colecao: collName }, body: data });
    return { ok: true };
  }
  async function _delete(collName, id) {
    await _api('DELETE', '/api/data', { query: { colecao: collName, id } });
    return { ok: true };
  }

  // ── Histórico: antes sincronizado por onSnapshot; agora por POLLING de
  //    delta (só busca o que mudou desde o maior id já visto). Mantém a
  //    mesma ideia de "1 leitura completa na primeira vez, depois só o
  //    que mudou" — evita reler a coleção inteira a cada abertura de tela. ──
  const _histFull = new Map();     // perfilKey -> array de linhas, sempre em dia
  const _histMaxId = new Map();    // perfilKey -> maior id já visto
  const _histPolling = new Map();  // perfilKey -> intervalId
  const _histReady = new Map();    // perfilKey -> Promise resolvida na 1ª leitura

  const POLL_INTERVAL_MS = 4000; // ~mesma "vivacidade" percebida do onSnapshot, sem custo de infra extra

  function _perfilKey(perfil) { return String(perfil || '').toLowerCase() === 'matriz' ? 'matriz' : 'lojas'; }
  function _hojeBR() {
    const d = new Date();
    return String(d.getDate()).padStart(2, '0') + '/' + String(d.getMonth() + 1).padStart(2, '0') + '/' + d.getFullYear();
  }
  function _parseDataBR(s) {
    if (!s || typeof s !== 'string') return '1900-01-01';
    const p = s.trim().split('/');
    if (p.length === 3 && p[2].length === 4) return `${p[2]}-${p[1].padStart(2, '0')}-${p[0].padStart(2, '0')}`;
    return '1900-01-01';
  }

  async function _puxarDelta(perfil) {
    const perfilKey = _perfilKey(perfil);
    const sinceId = _histMaxId.get(perfilKey) || 0;
    const r = await _api('GET', '/api/historico', { query: { perfil, modo: 'delta', sinceId } });
    if (!r.rows.length) return;
    const rows = _histFull.get(perfilKey);
    r.rows.forEach(data => {
      const idx = rows.findIndex(x => String(x.id) === String(data.id));
      if (idx >= 0) rows[idx] = data; else rows.push(data);
      if (Number(data.id) > (_histMaxId.get(perfilKey) || 0)) _histMaxId.set(perfilKey, Number(data.id));
    });
  }

  function _garantirListenerHistorico(perfil) {
    const perfilKey = _perfilKey(perfil);
    if (_histReady.has(perfilKey)) return _histReady.get(perfilKey); // já existe — reaproveita

    _histFull.set(perfilKey, []);
    _histMaxId.set(perfilKey, 0);

    const ready = (async () => {
      // 1ª leitura: carrega tudo (equivalente à primeira entrega do onSnapshot)
      const r = await _api('GET', '/api/historico', { query: { perfil, modo: 'delta', sinceId: 0 } });
      _histFull.set(perfilKey, r.rows);
      const maxId = r.rows.reduce((m, x) => Math.max(m, Number(x.id) || 0), 0);
      _histMaxId.set(perfilKey, maxId);

      // Poll contínuo a partir daqui — só delta.
      const intervalId = setInterval(() => {
        _puxarDelta(perfil).catch(err => console.error('[Polling] Falha ao atualizar histórico (' + perfilKey + '):', err));
      }, POLL_INTERVAL_MS);
      _histPolling.set(perfilKey, intervalId);
    })();

    _histReady.set(perfilKey, ready);
    return ready;
  }

  // Chamado antes de trocar de banco (ex.: troca de cliente logado) —
  // mesmo cuidado do original, agora limpando os intervals de polling
  // em vez de cancelar listeners do Firestore.
  window.__cancelarListenersHistorico = function () {
    _histPolling.forEach(intervalId => clearInterval(intervalId));
    _histPolling.clear();
    _histReady.clear();
    _histFull.clear();
    _histMaxId.clear();
  };

  async function addHistorico(data) {
    const payload = Object.assign({}, data);
    if (!payload.data) payload.data = _hojeBR();
    const r = await _api('POST', '/api/historico', { body: payload });
    return { ok: true, id: r.id };
  }
  async function updateHistorico(data) {
    await _api('PUT', '/api/historico', { body: data });
    return { ok: true };
  }
  async function deleteHistorico(id, perfil) {
    await _api('DELETE', '/api/historico', { query: { id, perfil } });
    // Remove também do cache local (_histFull) — senão o registro
    // "renasce" na tela na próxima vez que o Histórico for recarregado,
    // porque o polling de delta só sabe ADICIONAR/ATUALIZAR, nunca remover.
    const perfilKey = _perfilKey(perfil);
    const rows = _histFull.get(perfilKey);
    if (rows) {
      const idx = rows.findIndex(x => String(x.id) === String(id));
      if (idx >= 0) rows.splice(idx, 1);
    }
    return { ok: true };
  }

  async function loadHistFiltrado(de, ate, perfil) {
    await _garantirListenerHistorico(perfil);
    const rows = _histFull.get(_perfilKey(perfil));
    return rows.filter(r => {
      const d = _parseDataBR(r.data);
      return d >= de && d <= ate;
    });
  }

  // ── Busca direta por DANF: só traz os documentos que batem (leitura barata) ──
  async function buscarDanfNoHistorico(danf, perfil) {
    const r = await _api('GET', '/api/historico', { query: { perfil, modo: 'danf', danf } });
    return r.rows;
  }

  // ── Carrega só os últimos N registros do histórico, ordenado por id ──
  async function loadHistUltimos(perfil, limite, cursorId) {
    const query = { perfil, modo: 'ultimos', limite: limite || 100 };
    if (cursorId) query.cursorId = cursorId;
    const r = await _api('GET', '/api/historico', { query });
    return r.rows;
  }

  async function updateHistoricoSituacaoPorDANF(danf, loja, perfil) {
    const r = await _api('PUT', '/api/historico', {
      query: { modo: 'situacao-por-danf' },
      body: { danf, loja, perfil }
    });
    return { ok: r.ok, totalMarcadas: r.totalMarcadas };
  }

  // ── Assinatura / config por perfil ──
  async function loadAssinatura(perfil) {
    const r = await _api('GET', '/api/config', { query: { chave: String(perfil) } });
    return r.valor;
  }
  async function saveAssinatura(data, perfil) {
    await _api('PUT', '/api/config', { body: { chave: String(perfil), valor: data, merge: true } });
    return { ok: true };
  }

  // ── Senha única do sistema ──
  async function loadSenhaSistema() {
    const r = await _api('GET', '/api/config', { query: { chave: 'sistema' } });
    return r.valor ? (r.valor.senha || null) : null;
  }
  async function saveSenhaSistema(atual, nova) {
    const r = await _api('PUT', '/api/senha-sistema', { body: { atual, nova } });
    return r.ok ? { ok: true } : { ok: false, msg: r.msg };
  }

  // ── E-mail de recuperação da senha do sistema ──
  async function loadEmailRecuperacao() {
    const r = await _api('GET', '/api/config', { query: { chave: 'sistema' } });
    return r.valor ? (r.valor.emailRecuperacao || null) : null;
  }
  async function saveEmailRecuperacao(email) {
    await _api('PUT', '/api/config', { body: { chave: 'sistema', valor: { emailRecuperacao: String(email || '').trim() }, merge: true } });
    return { ok: true };
  }

  // ── Regras de destinatários por erro ──
  async function saveAllRegras(regrasArray) {
    const hoje = new Date().toLocaleDateString('pt-BR');
    const existentes = await _loadColl('regras');
    let saved = 0;
    for (const nova of (regrasArray || [])) {
      const match = existentes.find(r => r.codErro === nova.codErro && r.descErro === nova.descErro);
      if (match) {
        await _update('regras', Object.assign({}, match, { destinatarios: nova.destinatarios, criadoEm: hoje }));
        saved++;
      } else if (nova.destinatarios) {
        await _add('regras', { codErro: nova.codErro, descErro: nova.descErro, destinatarios: nova.destinatarios, criadoEm: hoje });
        saved++;
      }
    }
    return { ok: true, saved };
  }

  // ── Grupos de loja (add e update pela mesma função) ──
  async function saveGrupoLoja(data) {
    if (!data || !data.id) {
      return _add(COLLECTIONS.grupoLoja, { grupo: data.grupo, lojas: data.lojas || '' });
    }
    return _update(COLLECTIONS.grupoLoja, data);
  }

  // ── Importação em massa ──
  async function importarEmMassa(collName, rows) {
    const r = await _api('POST', '/api/importar-em-massa', { query: { colecao: collName }, body: { rows } });
    return { ok: true, importados: r.importados, idInicial: r.idInicial };
  }

  // ── Limpeza em lote de uma coleção inteira ──
  async function limparColecao(collName) {
    const r = await _api('DELETE', '/api/importar-em-massa', { query: { colecao: collName } });
    return { ok: true, removidos: r.removidos };
  }

  // ── loadAll: junta todas as coleções + histórico do perfil ativo ──
  async function loadAll(perfil) {
    const [compradores, comerciais, lojas, manifestos, codErros, fornecedores, historico, regras, justificativas, gruposLoja] =
      await Promise.all([
        _loadColl(_compradoresColl(perfil)),
        _loadColl(COLLECTIONS.comercial),
        _loadColl(COLLECTIONS.loja),
        _loadColl(COLLECTIONS.manifesto),
        _loadColl(_codErrosColl(perfil)),
        _loadColl(COLLECTIONS.fornecedor),
        loadHistUltimos(perfil, 100),
        _loadColl(COLLECTIONS.regra),
        _loadColl(COLLECTIONS.justificativa),
        _loadColl(COLLECTIONS.grupoLoja)
      ]);
    return { compradores, comerciais, lojas, manifestos, codErros, fornecedores, historico, regras, justificativas, gruposLoja };
  }

  // ── Tabela de despacho (idêntica em nomes e assinaturas ao polyfill.js original) ──
  const HANDLERS = {
    loadAll,
    loadHistFiltrado,
    loadHistUltimos,
    buscarDanfNoHistorico,
    addHistorico, updateHistorico, deleteHistorico, updateHistoricoSituacaoPorDANF,
    loadAssinatura, saveAssinatura,
    addComprador: (d) => _add(_compradoresColl(d && d.perfil), d),
    updateComprador: (d) => _update(_compradoresColl(d && d.perfil), d),
    deleteComprador: (id, perfil) => _delete(_compradoresColl(perfil), id),
    addComercial: (d) => _add(COLLECTIONS.comercial, d),
    updateComercial: (d) => _update(COLLECTIONS.comercial, d),
    deleteComercial: (id) => _delete(COLLECTIONS.comercial, id),
    addLoja: (d) => _add(COLLECTIONS.loja, d),
    updateLoja: (d) => _update(COLLECTIONS.loja, d),
    deleteLoja: (id) => _delete(COLLECTIONS.loja, id),
    addManifesto: (d) => _add(COLLECTIONS.manifesto, d),
    updateManifesto: (d) => _update(COLLECTIONS.manifesto, d),
    deleteManifesto: (id) => _delete(COLLECTIONS.manifesto, id),
    addCodErro: (d) => _add(_codErrosColl(d && d.perfil), d),
    updateCodErro: (d) => _update(_codErrosColl(d && d.perfil), d),
    deleteCodErro: (id, perfil) => _delete(_codErrosColl(perfil), id),
    addFornecedor: (d) => _add(COLLECTIONS.fornecedor, d),
    updateFornecedor: (d) => _update(COLLECTIONS.fornecedor, d),
    deleteFornecedor: (id) => _delete(COLLECTIONS.fornecedor, id),
    saveAllRegras,
    deleteRegra: (id) => _delete(COLLECTIONS.regra, id),
    addJustificativa: (d) => _add(COLLECTIONS.justificativa, d),
    updateJustificativa: (d) => _update(COLLECTIONS.justificativa, d),
    deleteJustificativa: (id) => _delete(COLLECTIONS.justificativa, id),
    saveGrupoLoja,
    deleteGrupoLoja: (id) => _delete(COLLECTIONS.grupoLoja, id),
    loadSenhaSistema, saveSenhaSistema,
    loadEmailRecuperacao, saveEmailRecuperacao,
    limparColecao, importarEmMassa
  };

  // ── Proxy que imita a API do google.script.run — IDÊNTICO ao original ──
  function makeProxy() {
    const proxy = {
      withSuccessHandler(cb) { this._ok = cb; return this; },
      withFailureHandler(cb) { this._fail = cb; return this; }
    };
    Object.keys(HANDLERS).forEach(name => {
      proxy[name] = function (...args) {
        const ok = this._ok, fail = this._fail;
        Promise.resolve()
          .then(() => HANDLERS[name].apply(null, args))
          .then(result => { if (ok) ok(result); })
          .catch(err => {
            console.error(`[Polyfill/Turso] Erro em ${name}:`, err);
            if (fail) fail(err); else throw err;
          });
        return makeProxy();
      };
    });
    return proxy;
  }

  window.google.script.run = makeProxy();

  console.log('[Polyfill] google.script.run redirecionado para Turso com sucesso!');
})();
