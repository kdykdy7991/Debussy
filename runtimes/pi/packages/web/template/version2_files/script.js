/* ============================================================
   AURUM · Interactive Demo
   Simulated streaming, agent activity, RAG citations, scenes
   ============================================================ */

// ============================================================
// DATA · Mock conversations & content
// ============================================================

const HISTORY = [
  { id: 'h1', title: '差旅住宿与报销标准', meta: '今天', active: true },
  { id: 'h2', title: 'Q2 区域销售对比分析', meta: '昨天' },
  { id: 'h3', title: '产品发布流程梳理', meta: '昨天' },
  { id: 'h4', title: '客户续约话术建议', meta: '本周' },
  { id: 'h5', title: '团队周报模板', meta: '本周' },
  { id: 'h6', title: '关于合同审批权限', meta: '上周' },
  { id: 'h7', title: '差旅申请单填写疑问', meta: '上周' },
  { id: 'h8', title: '市场活动数据复盘', meta: '上周' },
  { id: 'h9', title: '入职流程材料准备', meta: '8月1日' },
  { id: 'h10', title: '客户反馈整理：华东区', meta: '7月' }
];

// ============================================================
// CONTENT · Scenes (the heart of the demo)
// ============================================================

const SCENES = {

  // -------- SCENE 1: Empty state --------
  empty: {
    title: '未命名会话',
    wide: false,
    blocks: () => [
      {
        kind: 'empty',
        greeting: '今天想问点什么？',
        sub: '我会基于企业知识库回答你的问题，必要时调用工具与智能体协作完成。',
        suggestions: [
          { ico: 'doc',     text: '梳理差旅住宿与报销标准' },
          { ico: 'chart',   text: 'Q2 各区域销售对比' },
          { ico: 'people',  text: '为新员工生成入职清单' },
          { ico: 'sparkle', text: '起草一份客户续约话术' }
        ]
      }
    ]
  },

  // -------- SCENE 2: Simple chat --------
  chat: {
    title: '问候与闲聊',
    wide: false,
    blocks: () => [
      { kind: 'user', text: '你好，今天是周几？' },
      {
        kind: 'ai',
        eyebrow: { name: 'Aurum', time: '刚刚' },
        body: '<p>下午好，<strong>今天是 2026 年 8 月 12 日，星期三</strong>。</p><p>需要我帮你做点什么？比如梳理一份会议纪要，或者查一下差旅政策。</p>',
        actions: true,
        finalActions: true
      }
    ]
  },

  // -------- SCENE 3: Editorial RAG (the main showcase) --------
  policy: {
    title: '差旅住宿与报销标准',
    wide: false,
    activity: [
      { label: '理解问题', detail: 'intent: travel.policy · region: cn', status: 'done' },
      { label: '检索企业知识库', src: '知识库 · 财务制度 v3.2', status: 'done', detail: 'query: "差旅住宿 报销 城市分级"\n→ 命中 3 篇文档' },
      { label: '阅读相关条款', detail: 'doc: 财务制度.pdf#4.2\ndoc: 差旅管理办法.pdf#2.1\ndoc: 城市分级表(2025).xlsx', status: 'done' },
      { label: '生成回答', status: 'done' }
    ],
    blocks: () => [
      { kind: 'user', text: '差旅住宿标准是多少？哪些城市可以报 800 以上？' },
      {
        kind: 'ai',
        eyebrow: { name: 'Aurum', time: '14:21' },
        subline: { during: '正在基于企业文档回答', step: '已检索 3 篇' },
        body:
          '<h1>差旅住宿标准与城市分级</h1>' +
          '<p>国内出差的住宿标准按城市分级管理，共分为 <strong>四档</strong>，每档对应不同的可报销上限。城市分级以差旅管理办法中的《国内差旅城市分级表》为准，每年根据实际情况调整一次。<sup class="citation">1</sup><sup class="citation">2</sup></p>' +
          '<h2>分档标准</h2>' +
          '<ul>' +
            '<li><strong>一档城市</strong>（含直辖市与省会）：单日上限 <strong>¥800</strong>，可覆盖一线及主要省会城市。</li>' +
            '<li><strong>二档城市</strong>（计划单列市与重点城市）：单日上限 <strong>¥650</strong>，如宁波、厦门、青岛等。</li>' +
            '<li><strong>三档城市</strong>（其他地级市）：单日上限 <strong>¥500</strong>。</li>' +
            '<li><strong>四档城市</strong>（县级及以下）：单日上限 <strong>¥350</strong>。</li>' +
          '</ul>' +
          '<p>如因客观原因（如展会、大型会议期间酒店价格上浮）需突破上限，<strong>可事前申请特批</strong>，由直属上级与财务共同审批。<sup class="citation">3</sup></p>' +
          '<h2>一档城市清单（可报 800 以上）</h2>' +
          '<p>根据最新分级表，一档城市共 31 个，覆盖以下区域：</p>' +
          '<ul>' +
            '<li><strong>直辖市</strong>：北京、上海、天津、重庆</li>' +
            '<li><strong>省会及特别城市</strong>：广州、深圳、杭州、南京、武汉、成都、西安、苏州、长沙、青岛、济南、合肥、福州、厦门、宁波、郑州、沈阳、大连、哈尔滨、长春、石家庄、太原、南宁、海口、贵阳、昆明、兰州、乌鲁木齐、拉萨<sup class="citation">1</sup></li>' +
          '</ul>' +
          '<blockquote>如果行程同时跨多个城市，标准按 <em>每一段</em> 单独适用。</blockquote>' +
          '<h2>实操建议</h2>' +
          '<p>预订酒店时建议保留 <strong>发票 + 住宿明细单</strong>，并在报销时附上出差申请单号。如对城市分级有疑问，可在提交申请前 @ 财务智能体快速核对。</p>',
        sources: [
          { num: '1', title: '差旅管理办法（2025 修订）', source: '财务制度库', meta: '第 2.1 节 · 城市分级' },
          { num: '2', title: '国内差旅城市分级表（2025）', source: '财务制度库 · 附件 A', meta: 'Excel · 31 个一档城市' },
          { num: '3', title: '特批申请流程说明', source: '财务制度库', meta: '第 4.5 节 · 特殊情形' }
        ],
        actions: true,
        finalActions: true
      }
    ]
  },

  // -------- SCENE 4: Agent working + data report --------
  report: {
    title: 'Q2 区域销售对比分析',
    wide: true,
    activity: [
      { label: '理解问题', status: 'done', detail: 'intent: report.sales.quarterly' },
      { label: '查询数据源', src: 'MCP · Snowflake', status: 'done', detail: 'tool: query_sales_metrics\nargs: { quarter: "Q2-2026", group_by: "region" }' },
      { label: '拉取明细', detail: 'rows: 1,248 · columns: 12 · duration: 1.2s', status: 'done' },
      { label: '生成图表与表格', status: 'active' },
      { label: '撰写洞察与建议', status: 'pending' }
    ],
    blocks: () => [
      { kind: 'user', text: '把 Q2 各区域的销售做一份对比分析，看一下哪几个区域需要关注。' },
      {
        kind: 'ai',
        eyebrow: { name: 'Aurum · 分析', time: '15:02', badge: '已连接 Snowflake' },
        subline: { during: '正在分析数据', step: '已从 Snowflake 拉取 1,248 行' },
        body:
          '<h1>Q2 区域销售对比</h1>' +
          '<p>下面是 <strong>2026 年第二季度</strong>各销售大区的核心指标对比。数据来自 ERP 与 CRM 联合聚合，已剔除内部交易与未确认订单。</p>' +
          '<div class="kpi-strip">' +
            '<div class="kpi-cell"><div class="kpi-label">总营收</div><div class="kpi-value">¥48.6M</div><div class="kpi-trend up">↑ 12.4% vs Q1</div></div>' +
            '<div class="kpi-cell"><div class="kpi-label">新签客户</div><div class="kpi-value">142</div><div class="kpi-trend up">↑ 8.1%</div></div>' +
            '<div class="kpi-cell"><div class="kpi-label">平均客单价</div><div class="kpi-value">¥342K</div><div class="kpi-trend down">↓ 3.2%</div></div>' +
            '<div class="kpi-cell"><div class="kpi-label">续约率</div><div class="kpi-value">91.2%</div><div class="kpi-trend up">↑ 1.4pp</div></div>' +
          '</div>' +
          '<h2>趋势：连续六个季度</h2>' +
          '<div class="chart-card">' +
            '<div class="chart-head">' +
              '<div><div class="chart-title">区域营收（百万元）</div><div class="chart-sub">2025 Q1 — 2026 Q2</div></div>' +
              '<div class="chart-legend"><div class="item"><span class="swatch" style="background:#A06D2A"></span>华东</div><div class="item"><span class="swatch" style="background:#7A6E58"></span>华南</div><div class="item"><span class="swatch" style="background:#C9A66B"></span>华北</div></div>' +
            '</div>' +
            '<div class="chart-body"><svg class="chart-svg" viewBox="0 0 800 200" preserveAspectRatio="none" id="chartSvg"></svg></div>' +
          '</div>' +
          '<h2>区域明细</h2>' +
          '<div class="data-table">' +
            '<div class="data-table-caption"><span>按营收降序 · 截至 2026-06-30</span><span>单位：百万元</span></div>' +
            '<div class="data-table-scroll"><table>' +
              '<thead><tr><th>区域</th><th class="num">营收</th><th class="num">同比</th><th class="num">新签</th><th class="num">续约率</th></tr></thead>' +
              '<tbody>' +
                '<tr><td>华东</td><td class="num">16.4</td><td class="num">16.2%<span class="delta-up">↑</span></td><td class="num">48</td><td class="num">93.1%</td></tr>' +
                '<tr><td>华南</td><td class="num">11.2</td><td class="num">9.4%<span class="delta-up">↑</span></td><td class="num">35</td><td class="num">89.8%</td></tr>' +
                '<tr><td>华北</td><td class="num">9.6</td><td class="num">2.1%<span class="delta-up">↑</span></td><td class="num">28</td><td class="num">90.5%</td></tr>' +
                '<tr><td>西南</td><td class="num">5.1</td><td class="num">-3.8%<span class="delta-down">↓</span></td><td class="num">14</td><td class="num">85.2%</td></tr>' +
                '<tr><td>东北</td><td class="num">3.4</td><td class="num">-1.2%<span class="delta-down">↓</span></td><td class="num">9</td><td class="num">87.6%</td></tr>' +
                '<tr><td>西北</td><td class="num">2.9</td><td class="num">5.7%<span class="delta-up">↑</span></td><td class="num">8</td><td class="num">92.0%</td></tr>' +
              '</tbody>' +
            '</table></div>' +
          '</div>' +
          '<h2>三个值得关注的信号</h2>' +
          '<p><strong>1. 西南区域出现连续两个季度下滑。</strong>主要客户集中在制造业，受 Q2 行业整体疲软影响显著。建议联合客户成功团队进行一次主动回访，识别可加速的项目。</p>' +
          '<p><strong>2. 客单价小幅下降 3.2%。</strong>合同结构变化是主因——更多客户选择「基础版 + 增值模块」组合，模块化收入增加 18%，整体 ARR 仍健康。</p>' +
          '<p><strong>3. 华东新签客户质量提升。</strong>虽然数量未明显增加，但单笔金额中位数提升 22%，<em>应继续加大该区域的渠道投入</em>。<sup class="citation">1</sup></p>' +
          '<div class="pull-quote">如果只看一个数字，关注 <strong>西南的续约率 85.2%</strong>——这是下半年最值得主动管理的指标。<cite>— 基于本次分析</cite></div>' +
          '<p>需要我继续深入某个区域，或者把这份分析导出为 PDF 报告吗？</p>',
        sources: [
          { num: '1', title: 'Q2 渠道投入回报分析', source: '市场部 · 内部报告', meta: '2026-07-12' }
        ],
        actions: true,
        finalActions: true
      }
    ]
  },

  // -------- SCENE 5: File upload --------
  upload: {
    title: '合同要点提取',
    wide: false,
    activity: [
      { label: '接收文件', detail: '合同_华兴制造_v3.pdf · 2.4 MB · 18 页', status: 'done' },
      { label: '解析文档', status: 'done' },
      { label: '提取关键条款', status: 'active' }
    ],
    blocks: () => [
      {
        kind: 'upload-demo',
        files: [
          { name: '合同_华兴制造_v3.pdf', size: '2.4 MB', pages: '18 页' }
        ]
      },
      {
        kind: 'ai',
        eyebrow: { name: 'Aurum · 文档', time: '16:48' },
        subline: { during: '正在阅读合同', step: '已解析 18 页' },
        body:
          '<h1>合同要点提取</h1>' +
          '<p>已阅读 <strong>《华兴制造年度服务合同 v3》</strong>，下面是与过往模板差异较大、值得重点关注的几处条款。</p>' +
          '<h2>1. 付款节奏</h2>' +
          '<p>由原来的 <em>「季度预付 + 季度结算」</em>改为 <strong>「半年预付 + 年度结算」</strong>。财务侧需要相应调整收入确认时点。</p>' +
          '<h2>2. 服务等级（SLA）</h2>' +
          '<p>关键指标的响应时间从 <strong>4 小时</strong>收紧到 <strong>2 小时</strong>，可用性承诺从 99.5% 提升到 <strong>99.9%</strong>，需评估值班排班是否需要扩充。</p>' +
          '<h2>3. 数据归属</h2>' +
          '<p>新增第 12.3 条：<em>客户业务数据的所有权明确归属客户</em>，服务终止后 30 天内完成完整数据导出与删除验证。这一点对我们比较友好。</p>' +
          '<h2>4. 违约金条款</h2>' +
          '<p>新增阶梯式违约金——单次 SLA 违约赔偿 5% 月费，连续 3 个月违约可触发合同重审。请在交付团队同步此条款。</p>' +
          '<blockquote>建议：先与法务确认第 12.3 条与我方标准条款无冲突，再推进签署。</blockquote>',
        actions: true,
        finalActions: true
      }
    ]
  }

};

// ============================================================
// RENDER · History list
// ============================================================

function renderHistory() {
  const list = document.getElementById('historyList');
  list.innerHTML = HISTORY.map(h => `
    <button class="history-item ${h.active ? 'active' : ''}" data-id="${h.id}">
      <span class="dot-mark"></span>
      <span class="title">${h.title}</span>
      <span class="meta">${h.meta}</span>
    </button>
  `).join('');

  list.querySelectorAll('.history-item').forEach(el => {
    el.addEventListener('click', () => {
      list.querySelectorAll('.history-item').forEach(x => x.classList.remove('active'));
      el.classList.add('active');
      const id = el.dataset.id;
      const map = { h1: 'policy', h2: 'report', h3: 'chat', h4: 'chat', h5: 'chat' };
      const target = map[id] || 'policy';
      loadScene(target);
    });
  });
}

// ============================================================
// RENDER · Scenes
// ============================================================

function renderEmptyState(block) {
  const icoSvg = (k) => {
    const map = {
      doc: '<svg width="12" height="12" viewBox="0 0 20 20" fill="none"><path d="M5 2.5h7L15 5.5V17a.5.5 0 0 1-.5.5h-9a.5.5 0 0 1-.5-.5V3a.5.5 0 0 1 .5-.5Z" stroke="currentColor" stroke-width="1.3"/><path d="M12 2.5V5.5h3" stroke="currentColor" stroke-width="1.3"/></svg>',
      chart: '<svg width="12" height="12" viewBox="0 0 20 20" fill="none"><path d="M3 17h14M5 14V9M9 14V5M13 14v-3M17 14V7" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
      people: '<svg width="12" height="12" viewBox="0 0 20 20" fill="none"><circle cx="8" cy="7" r="3" stroke="currentColor" stroke-width="1.3"/><path d="M3 17c0-2.8 2.2-5 5-5s5 2.2 5 5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><circle cx="14" cy="8" r="2.2" stroke="currentColor" stroke-width="1.3"/><path d="M14 12.5c2 0 3.5 1.5 3.5 3.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
      sparkle: '<svg width="12" height="12" viewBox="0 0 20 20" fill="none"><path d="M10 3v3M10 14v3M3 10h3M14 10h3M5.5 5.5l2 2M12.5 12.5l2 2M14.5 5.5l-2 2M7.5 12.5l-2 2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>'
    };
    return map[k] || map.doc;
  };
  return `
    <div class="empty-state fade-in">
      <div class="greeting">${block.greeting.replace('今天', '<em>今天</em>')}</div>
      <div class="sub">${block.sub}</div>
      <div class="empty-suggestions">
        ${block.suggestions.map(s => `
          <button class="suggestion" data-prompt="${s.text}">
            <span class="ico">${icoSvg(s.ico)}</span>
            <span class="text">${s.text}</span>
          </button>
        `).join('')}
      </div>
    </div>
  `;
}

function renderUser(block) {
  return `
    <div class="message-user">
      <div class="bubble-user">${block.text}</div>
    </div>
  `;
}

function renderEyebrow(meta) {
  return `
    <div class="ai-eyebrow">
      <span class="mark">
        <svg width="16" height="16" viewBox="0 0 20 20" fill="none">
          <path d="M10 2.5 L11.6 8.4 L17.5 10 L11.6 11.6 L10 17.5 L8.4 11.6 L2.5 10 L8.4 8.4 Z" fill="currentColor"/>
        </svg>
      </span>
      <span class="name">${meta.name}</span>
      ${meta.badge ? `<span style="color:var(--amber); font-size:11px; padding:1px 6px; background:var(--amber-soft); border-radius:4px; font-weight:500; font-style:normal; font-family:var(--font-sans);">${meta.badge}</span>` : ''}
      <span style="color:var(--ink-5); margin:0 2px;">·</span>
      <span class="time">${meta.time}</span>
    </div>
  `;
}

function renderSources(sources) {
  if (!sources || !sources.length) return '';
  return `
    <div class="sources">
      <div class="sources-head">
        <svg width="13" height="13" viewBox="0 0 20 20" fill="none">
          <path d="M5 3h7l3 3v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" stroke="currentColor" stroke-width="1.3"/>
          <path d="M7 9h6M7 12h4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
        </svg>
        来源 · ${sources.length} 篇
      </div>
      <div class="sources-list">
        ${sources.map(s => `
          <div class="source-item">
            <span class="source-num">${s.num}</span>
            <div class="source-meta">
              <div class="source-title">${s.title}</div>
              <div class="source-source">${s.source} <span class="sep">·</span> ${s.meta}</div>
            </div>
          </div>
        `).join('')}
      </div>
    </div>
  `;
}

function renderActions() {
  return `
    <div class="response-actions">
      <button class="action-btn">
        <svg viewBox="0 0 16 16" fill="none"><rect x="5" y="5" width="8" height="8" rx="1.5" stroke="currentColor" stroke-width="1.2"/><path d="M3 11V4a1 1 0 0 1 1-1h7" stroke="currentColor" stroke-width="1.2"/></svg>
        复制
      </button>
      <button class="action-btn">
        <svg viewBox="0 0 16 16" fill="none"><path d="M3 8.5l3 3 7-7" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>
        有用
      </button>
      <button class="action-btn">
        <svg viewBox="0 0 16 16" fill="none"><path d="M3 4h10M6 4v8M10 4v3M5 12l-2 2v-2" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>
        重新生成
      </button>
      <button class="action-btn" id="openActivity">
        <svg viewBox="0 0 16 16" fill="none"><circle cx="3" cy="8" r="1.2" fill="currentColor"/><circle cx="8" cy="8" r="1.2" fill="currentColor"/><circle cx="13" cy="8" r="1.2" fill="currentColor"/></svg>
        任务进度
      </button>
    </div>
  `;
}

function renderSubline(block) {
  if (!block.subline) return '';
  return `
    <div class="activity-subline" data-subline>
      <span class="pulse"></span>
      <span class="label">${block.subline.during}</span>
      ${block.subline.step ? `<span class="step">· ${block.subline.step}</span>` : ''}
    </div>
  `;
}

function renderAi(block) {
  const sources = renderSources(block.sources);
  const actions = block.actions ? renderActions() : '';
  return `
    <div class="message-ai streaming" data-ai>
      ${renderEyebrow(block.eyebrow)}
      <div class="response-body" data-body>${block.body}</div>
      ${renderSubline(block)}
      <div class="post-stream" data-post>
        ${sources}
        ${actions}
      </div>
    </div>
  `;
}

function renderUploadDemo(block) {
  return `
    <div class="message-user">
      <div class="bubble-user" style="display:flex; flex-direction:column; gap:8px; padding:12px 14px;">
        <div style="font-size:12px; color:var(--ink-3);">已上传文件</div>
        ${block.files.map(f => `
          <div style="display:flex; align-items:center; gap:10px; padding:8px 10px; background:var(--paper-pure); border:1px solid var(--line-1); border-radius:8px;">
            <span style="display:grid; place-items:center; width:28px; height:28px; background:var(--amber-soft); color:var(--amber); border-radius:6px;">
              <svg width="14" height="14" viewBox="0 0 20 20" fill="none"><path d="M5 2.5h7L15 5.5V17a.5.5 0 0 1-.5.5h-9a.5.5 0 0 1-.5-.5V3a.5.5 0 0 1 .5-.5Z" stroke="currentColor" stroke-width="1.3"/><path d="M12 2.5V5.5h3" stroke="currentColor" stroke-width="1.3"/></svg>
            </span>
            <div style="display:flex; flex-direction:column; min-width:0; flex:1;">
              <div style="font-size:13px; color:var(--ink-1); font-weight:500;">${f.name}</div>
              <div style="font-size:11px; color:var(--ink-3);">${f.size} · ${f.pages}</div>
            </div>
          </div>
        `).join('')}
        <div style="font-size:13px; color:var(--ink-1); margin-top:4px;">帮我提取这份合同的关键条款</div>
      </div>
    </div>
  `;
}

function renderBlock(block) {
  switch (block.kind) {
    case 'empty':       return renderEmptyState(block);
    case 'user':        return renderUser(block);
    case 'ai':          return renderAi(block);
    case 'upload-demo': return renderUploadDemo(block);
    default:            return '';
  }
}

// ============================================================
// SCENE LOADER
// ============================================================

let currentStream = null;
let sceneId = 'policy';

function loadScene(id) {
  sceneId = id;
  const scene = SCENES[id];
  if (!scene) return;
  cancelStream();
  const thread = document.getElementById('thread');
  thread.classList.toggle('wide', !!scene.wide);
  document.getElementById('conversationTitle').textContent = scene.title;

  const blocks = scene.blocks();
  thread.innerHTML = blocks.map(renderBlock).join('');

  // Scroll to bottom after render
  requestAnimationFrame(() => {
    const ts = document.getElementById('threadScroll');
    ts.scrollTop = ts.scrollHeight;
  });

  // Render activity panel state
  if (scene.activity) {
    renderActivity(scene.activity);
  } else {
    document.getElementById('activityList').innerHTML = '';
  }

  // Simulate streaming for the AI block in this scene
  const aiBlock = thread.querySelector('.message-ai .response-body[data-body]');
  const aiMsg = thread.querySelector('.message-ai');
  if (aiBlock && id !== 'empty') {
    const subline = thread.querySelector('[data-subline]');
    streamInto(aiBlock, aiBlock.innerHTML, () => {
      // On complete: remove streaming class to reveal post-stream content
      if (aiMsg) aiMsg.classList.remove('streaming');
      // Mark subline as done
      if (subline) {
        subline.classList.add('done');
        const label = subline.querySelector('.label');
        const step = subline.querySelector('.step');
        if (id === 'policy') {
          if (label) label.textContent = '已基于 3 篇企业文档回答';
          if (step) step.textContent = '· 14:21';
        } else if (id === 'report') {
          if (label) label.textContent = '已基于 1,248 行数据回答';
          if (step) step.textContent = '· 15:02';
        } else if (id === 'upload') {
          if (label) label.textContent = '已阅读合同并提取要点';
          if (step) step.textContent = '· 16:48';
        } else {
          if (label) label.textContent = '回答完成';
        }
      }
      // Draw chart if needed
      if (id === 'report') drawChart();
    });
  } else {
    if (aiMsg) aiMsg.classList.remove('streaming');
    if (id === 'report') drawChart();
  }

  // Wire subline click to open activity
  thread.querySelectorAll('[data-subline]').forEach(el => {
    el.addEventListener('click', openActivity);
  });

  // Wire activity open button
  const openBtn = thread.querySelector('#openActivity');
  if (openBtn) openBtn.addEventListener('click', openActivity);

  // Wire suggestions
  thread.querySelectorAll('.suggestion').forEach(s => {
    s.addEventListener('click', () => {
      const map = { '梳理差旅住宿与报销标准': 'policy', 'Q2 各区域销售对比': 'report' };
      const target = map[s.dataset.prompt];
      if (target) loadScene(target);
    });
  });

  // Build chart if present (only if no streaming will happen)
  if (id === 'report' && !thread.querySelector('.message-ai .response-body[data-body]')) {
    requestAnimationFrame(() => drawChart());
  }
}

// ============================================================
// STREAMING
// ============================================================

function streamInto(el, html, onComplete) {
  cancelStream();
  // Tokenize: keep tags intact, but stream text inside
  const tokens = tokenize(html);
  el.innerHTML = '';
  let i = 0;
  let buffer = '';
  const tick = () => {
    if (i >= tokens.length) {
      // Remove the streaming cursor
      const cursors = el.querySelectorAll('.cursor');
      cursors.forEach(c => c.remove());
      // Add a final subtle cursor that fades
      const finalCursor = document.createElement('span');
      finalCursor.className = 'cursor';
      el.appendChild(finalCursor);
      setTimeout(() => { finalCursor.style.transition = 'opacity 400ms'; finalCursor.style.opacity = '0'; }, 500);
      currentStream = null;
      if (onComplete) onComplete();
      return;
    }
    const tok = tokens[i++];
    if (tok.type === 'tag') {
      buffer += tok.value;
      el.innerHTML = buffer + '<span class="cursor"></span>';
    } else {
      // Reveal text char-by-char
      buffer += tok.value;
      el.innerHTML = buffer + '<span class="cursor"></span>';
      // Auto-scroll
      const ts = document.getElementById('threadScroll');
      ts.scrollTop = ts.scrollHeight;
    }
    const delay = tok.type === 'tag' ? 0 : 6 + Math.random() * 12;
    currentStream = setTimeout(tick, delay);
  };
  tick();
}

function cancelStream() {
  if (currentStream) {
    clearTimeout(currentStream);
    currentStream = null;
  }
}

function tokenize(html) {
  // Split into tags and text
  const out = [];
  let i = 0;
  while (i < html.length) {
    if (html[i] === '<') {
      const end = html.indexOf('>', i);
      if (end < 0) {
        out.push({ type: 'text', value: html.slice(i) });
        break;
      }
      out.push({ type: 'tag', value: html.slice(i, end + 1) });
      i = end + 1;
    } else {
      let end = html.indexOf('<', i);
      if (end < 0) end = html.length;
      const seg = html.slice(i, end);
      // Stream word-by-word for latin; char-by-char for CJK
      const hasSpace = /\s/.test(seg);
      if (hasSpace) {
        const parts = seg.split(/(\s+)/);
        for (const p of parts) {
          if (p) out.push({ type: 'text', value: p });
        }
      } else {
        // CJK or no-whitespace text: split into 2-char chunks for natural flow
        for (let k = 0; k < seg.length; k += 2) {
          out.push({ type: 'text', value: seg.slice(k, k + 2) });
        }
      }
      i = end;
    }
  }
  return out;
}

// ============================================================
// ACTIVITY PANEL
// ============================================================

function renderActivity(steps) {
  const list = document.getElementById('activityList');
  list.innerHTML = steps.map((s, i) => `
    <div class="act-item ${s.status || ''}" data-i="${i}">
      <div class="act-marker"></div>
      <div class="act-body">
        <div class="act-label">${s.label}</div>
        ${s.src ? `<div class="act-meta"><span>via</span><span class="src">${s.src}</span></div>` : ''}
        ${s.detail ? `<div class="act-detail">${s.detail}</div><button class="act-toggle">查看参数 <span class="chev">›</span></button>` : ''}
      </div>
    </div>
  `).join('');

  list.querySelectorAll('.act-item').forEach(item => {
    const toggle = item.querySelector('.act-toggle');
    if (toggle) {
      toggle.addEventListener('click', e => {
        e.stopPropagation();
        item.classList.toggle('expanded');
      });
    }
  });
}

function openActivity() {
  document.getElementById('activityOverlay').classList.add('open');
}
function closeActivity() {
  document.getElementById('activityOverlay').classList.remove('open');
}

// ============================================================
// CHART
// ============================================================

function drawChart() {
  const svg = document.getElementById('chartSvg');
  if (!svg) return;

  const series = [
    { name: '华东', color: '#A06D2A', data: [10.2, 11.4, 12.8, 13.6, 14.9, 16.4] },
    { name: '华南', color: '#7A6E58', data: [ 8.6,  9.1,  9.8, 10.2, 10.6, 11.2] },
    { name: '华北', color: '#C9A66B', data: [ 7.4,  8.0,  8.5,  8.9,  9.2,  9.6] }
  ];
  const labels = ['25Q1','25Q2','25Q3','25Q4','26Q1','26Q2'];
  const W = 800, H = 200, PAD = { l: 36, r: 12, t: 16, b: 28 };
  const innerW = W - PAD.l - PAD.r, innerH = H - PAD.t - PAD.b;
  const maxY = 18, minY = 0;
  const yScale = v => PAD.t + innerH - ((v - minY) / (maxY - minY)) * innerH;
  const xScale = i => PAD.l + (i / (labels.length - 1)) * innerW;

  // Build paths
  const paths = series.map(s => {
    const d = s.data.map((v, i) => `${i === 0 ? 'M' : 'L'} ${xScale(i)} ${yScale(v)}`).join(' ');
    const area = d + ` L ${xScale(s.data.length - 1)} ${yScale(0)} L ${xScale(0)} ${yScale(0)} Z`;
    return { ...s, d, area };
  });

  // Y gridlines
  const gridY = [0, 4, 8, 12, 16].map(v => {
    const y = yScale(v);
    return `<line x1="${PAD.l}" y1="${y}" x2="${W - PAD.r}" y2="${y}" stroke="rgba(27,24,20,0.06)"/>
            <text x="${PAD.l - 8}" y="${y + 3}" font-size="10" fill="#837B6E" text-anchor="end" font-family="Inter">${v}M</text>`;
  }).join('');

  // X labels
  const xLabels = labels.map((l, i) => `
    <text x="${xScale(i)}" y="${H - 10}" font-size="10" fill="#837B6E" text-anchor="middle" font-family="Inter">${l}</text>
  `).join('');

  // Series
  const seriesSvg = paths.map(p => `
    <path d="${p.area}" fill="${p.color}" fill-opacity="0.06" />
    <path d="${p.d}" fill="none" stroke="${p.color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" pathLength="1000" stroke-dasharray="1000" stroke-dashoffset="1000" class="draw-line"/>
    ${p.data.map((v, i) => `<circle cx="${xScale(i)}" cy="${yScale(v)}" r="3" fill="var(--paper-pure)" stroke="${p.color}" stroke-width="1.6"/>`).join('')}
  `).join('');

  svg.innerHTML = gridY + seriesSvg + xLabels;

  // Animate draw
  requestAnimationFrame(() => {
    svg.querySelectorAll('.draw-line').forEach((p, i) => {
      p.style.transition = `stroke-dashoffset 1200ms cubic-bezier(0.32, 0.72, 0, 1) ${i * 200}ms`;
      p.style.strokeDashoffset = '0';
    });
  });
}

// ============================================================
// COMPOSER
// ============================================================

function setupComposer() {
  const input = document.getElementById('composerInput');
  const send = document.getElementById('composerSend');
  const stop = document.getElementById('composerStop');
  const intent = document.getElementById('composerIntent');

  function autoResize() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 200) + 'px';
  }

  input.addEventListener('input', () => {
    autoResize();
    send.disabled = input.value.trim().length === 0;
  });

  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!send.disabled) submit();
    }
  });

  send.addEventListener('click', submit);

  function submit() {
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    autoResize();
    send.disabled = true;
    // Simple echo
    if (text === '差旅') loadScene('policy');
    else if (text.includes('销售') || text.includes('Q2')) loadScene('report');
    else if (text.includes('合同')) loadScene('upload');
    else {
      // Generic echo
      const thread = document.getElementById('thread');
      thread.insertAdjacentHTML('beforeend', renderUser({ text }));
      const aiHtml = `<p>这是一个演示版本——尝试输入 <strong>差旅</strong>、<strong>Q2</strong> 或 <strong>合同</strong> 查看不同场景。</p>`;
      const aiWrap = document.createElement('div');
      aiWrap.innerHTML = renderAi({
        eyebrow: { name: 'Aurum', time: '刚刚' },
        body: aiHtml,
        actions: true,
        finalActions: true
      });
      thread.appendChild(aiWrap.firstElementChild);
      const body = thread.querySelector('.message-ai:last-child .response-body');
      if (body) streamInto(body, aiHtml);
      requestAnimationFrame(() => {
        const ts = document.getElementById('threadScroll');
        ts.scrollTop = ts.scrollHeight;
      });
    }
  }

  // Tool buttons
  document.querySelectorAll('.composer-tool').forEach(btn => {
    btn.addEventListener('click', () => {
      const t = btn.dataset.tool;
      if (t === 'files') {
        // Simulate file attach
        const att = document.getElementById('composerAttachments');
        att.hidden = false;
        att.innerHTML = `
          <div class="attachment-chip">
            <span class="ico">
              <svg width="10" height="10" viewBox="0 0 20 20" fill="none"><path d="M5 2.5h7L15 5.5V17a.5.5 0 0 1-.5.5h-9a.5.5 0 0 1-.5-.5V3a.5.5 0 0 1 .5-.5Z" stroke="currentColor" stroke-width="1.5"/></svg>
            </span>
            <span class="name">合同_华兴制造_v3.pdf</span>
            <span class="size">· 2.4 MB</span>
            <span class="x">
              <svg width="10" height="10" viewBox="0 0 16 16" fill="none"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
            </span>
          </div>
        `;
        // Also reflect as a label in intent
        intent.hidden = false;
        intent.innerHTML = `
          <span class="intent-chip">
            <span class="k">@</span>
            <span>财务制度库</span>
            <span class="x">×</span>
          </span>
        `;
        // Auto-remove on click
        att.querySelector('.x').addEventListener('click', () => {
          att.hidden = true;
          att.innerHTML = '';
        });
      } else if (t === 'knowledge') {
        intent.hidden = false;
        intent.innerHTML = `
          <span class="intent-chip">
            <span class="k">@</span>
            <span>财务制度库</span>
            <span class="x">×</span>
          </span>
          <span class="intent-chip">
            <span class="k">@</span>
            <span>差旅管理办法</span>
            <span class="x">×</span>
          </span>
        `;
      } else if (t === 'thinking' || t === 'agents') {
        btn.classList.toggle('active');
      }
    });
  });
}

// ============================================================
// SIDEBAR
// ============================================================

function setupSidebar() {
  const toggle = document.getElementById('sidebarToggle');
  const app = document.querySelector('.app');
  toggle.addEventListener('click', () => {
    app.classList.toggle('sidebar-collapsed');
  });
}

// ============================================================
// TOPBAR (scroll-aware border)
// ============================================================

function setupTopbar() {
  const ts = document.getElementById('threadScroll');
  const tb = document.querySelector('.topbar');
  ts.addEventListener('scroll', () => {
    tb.classList.toggle('scrolled', ts.scrollTop > 8);
  });
}

// ============================================================
// ACTIVITY OVERLAY
// ============================================================

function setupActivity() {
  const overlay = document.getElementById('activityOverlay');
  document.getElementById('activityClose').addEventListener('click', closeActivity);
  overlay.addEventListener('click', e => {
    if (e.target === overlay) closeActivity();
  });
}

// ============================================================
// SCENE SWITCHER
// ============================================================

function setupSceneSwitcher() {
  const switcher = document.createElement('div');
  switcher.className = 'scene-switcher';
  switcher.innerHTML = `
    <span class="scene-label">View</span>
    <button class="scene-btn" data-scene="empty">空状态</button>
    <button class="scene-btn" data-scene="chat">简单对话</button>
    <button class="scene-btn active" data-scene="policy">RAG 长文</button>
    <button class="scene-btn" data-scene="report">数据分析</button>
    <button class="scene-btn" data-scene="upload">文件</button>
    <span style="width:1px; height:14px; background:var(--line-1); margin:0 4px;"></span>
    <button class="scene-btn" id="activityBtn" title="活动面板">任务</button>
  `;
  document.body.appendChild(switcher);

  switcher.querySelectorAll('.scene-btn[data-scene]').forEach(b => {
    b.addEventListener('click', () => {
      switcher.querySelectorAll('.scene-btn').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      loadScene(b.dataset.scene);
    });
  });

  document.getElementById('activityBtn').addEventListener('click', openActivity);
}

// ============================================================
// INIT
// ============================================================

function init() {
  renderHistory();
  setupSidebar();
  setupComposer();
  setupTopbar();
  setupActivity();
  setupSceneSwitcher();
  loadScene('policy');
}

document.addEventListener('DOMContentLoaded', init);
