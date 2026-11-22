import { api } from '../api.js';
import { esc, fileSize, readAsDataURL } from '../util.js';
import { icon, toast, openModal } from '../components.js';
import { state, loadMeta } from '../layout.js';
import { attachSelectSearch } from '../list-search.js';

export async function renderUpload(root) {
  const meta = await loadMeta();
  const user = state.user;
  if (!user || !user.verified) {
    root.innerHTML = `<div class="view-enter">
      <div class="page-hero">
        <h1>上传资料</h1>
        <p>完成实名认证与高校认证后，才可获得资料售卖权限</p>
      </div>
      <div class="panel panel-pad verify-gate">
        <span class="verify-gate-icon">${icon('shieldCheck')}</span>
        <h2>先完成认证，再发布资料</h2>
        <p class="muted">平台要求卖家提交真实姓名、所在高校与学号，审核通过后即可上传资料并获得 90% 的成交收益。</p>
        <div class="steps" style="max-width:520px;margin:18px auto 22px;text-align:left">
          <div class="step"><b>1</b><div><strong>提交实名信息</strong><span>填写真实姓名、选择高校并填写学号</span></div></div>
          <div class="step"><b>2</b><div><strong>等待管理员审核</strong><span>通常在 1 个工作日内完成</span></div></div>
          <div class="step"><b>3</b><div><strong>解锁买卖权限</strong><span>认证通过后默认进入本校专区，可上传与购买资料</span></div></div>
        </div>
        <div class="row" style="justify-content:center;gap:10px">
          <a class="btn btn-ghost" href="#/market">先去逛逛</a>
          <a class="btn btn-primary" href="#/me?tab=verify">${icon('badgeCheck')} 前往实名认证</a>
        </div>
      </div>
    </div>`;
    return;
  }
  let pickedFile = null;
  let priceTouched = false;
  let currentRec = null;

  root.innerHTML = `<div class="view-enter">
    <div class="page-hero">
      <h1>上传资料</h1>
      <p>把你的课堂整理分享给同学，通过审核后即可获得 90% 的成交收益</p>
    </div>
    <div class="upload-grid">
      <form class="panel form-panel" data-upload-form>
        <div class="form-grid">
          <div class="field full">
            <label class="label">资料标题<span class="req">*</span></label>
            <input class="input" name="title" maxlength="80" placeholder="例如：数据结构期末复习提纲（含近五年真题）">
            <div class="hint">清晰的标题更容易被搜到，建议包含课程名 + 资料类型 + 年份</div>
          </div>
          <div class="field">
            <label class="label">资料分类<span class="req">*</span></label>
            <select class="select" name="category">
              ${meta.categories.map((c) => `<option>${esc(c)}</option>`).join('')}
            </select>
          </div>
          <div class="field">
            <label class="label">所属院校<span class="req">*</span></label>
            <select class="select" name="school">
              <option value="">不限院校</option>
              ${meta.schools.map((s) => `<option ${user.school === s ? 'selected' : ''}>${esc(s)}</option>`).join('')}
            </select>
          </div>
          <div class="field">
            <label class="label">所属学科<span class="req">*</span></label>
            <select class="select" name="subject" required>
              <option value="">请选择学科</option>
              ${meta.subjects.map((s) => `<option>${esc(s)}</option>`).join('')}
            </select>
            <div class="hint">学科用于资料市场的三维筛选与官方标准定价匹配</div>
          </div>
          <div class="field">
            <label class="label">授课老师</label>
            <input class="input" name="teacher" maxlength="30" placeholder="例如：王海涛 / 陈立群">
            <div class="hint">填写老师姓名后，同学可按老师筛选到这份资料</div>
          </div>
          <div class="field">
            <label class="label">相关课程</label>
            <input class="input" name="course" maxlength="30" placeholder="例如：数据结构 / 高等数学">
          </div>
          <div class="field">
            <label class="label">定价<span class="req">*</span></label>
            <div class="price-input">
              <span class="prefix">¥</span>
              <input class="input" name="price" type="number" min="0" max="999" step="0.1" value="19.9">
            </div>
            <div class="stepper">
              <button type="button" data-price="0">免费分享</button>
              <button type="button" data-price="9.9">¥9.9</button>
              <button type="button" data-price="19.9">¥19.9</button>
              <button type="button" data-price="29.9">¥29.9</button>
            </div>
            <div class="hint" data-price-hint>选择院校、学科与类型后，系统会自动匹配官方标准价</div>
          </div>
          <div class="field full">
            <div class="price-card" data-price-card>
              <span class="small muted">正在匹配官方价格标准库…</span>
            </div>
          </div>
          <div class="field">
            <label class="label">试读比例</label>
            <select class="select" name="previewRatio">
              <option value="10">前 10% 内容</option>
              <option value="15" selected>前 15% 内容（推荐）</option>
              <option value="20">前 20% 内容</option>
            </select>
            <div class="hint">系统会截取资料前 N% 作为试读片段，禁止复制与下载</div>
          </div>
          <div class="field">
            <label class="label">收益说明</label>
            <div class="guarantee">${icon('checkCircle')} 平台收取 10% 服务费，其余 90% 计入账户收益并按 T+1 结算</div>
          </div>
          <div class="field full">
            <label class="label">标签</label>
            <input class="input" name="tags" maxlength="80" placeholder="用逗号分隔，最多 5 个，例如：期末, 真题, 重点">
          </div>
          <div class="field full">
            <label class="label">资料文件<span class="req">*</span></label>
            <div class="dropzone" data-dropzone tabindex="0" role="button" aria-label="选择资料文件">
              ${icon('upload')}
              <b>点击选择或拖拽文件到此处</b>
              <span>支持 PDF / Word / PPT / Excel / ZIP / 图片 / 文本，单个文件不超过 20MB</span>
              <input type="file" data-file hidden accept=".pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.zip,.rar,.txt,.md,.png,.jpg,.jpeg">
            </div>
            <div class="file-picked hidden" data-picked></div>
          </div>
          <div class="field full">
            <label class="label">资料介绍<span class="req">*</span></label>
            <textarea class="textarea" name="description" maxlength="1500" placeholder="介绍资料包含哪些内容、适合什么阶段的同学、有什么使用建议（至少 20 字）"></textarea>
            <div class="hint">写清章节范围、年份、是否含答案，可以减少售前咨询，也更容易通过审核</div>
          </div>
        </div>
        <div class="row" style="margin-top:22px;justify-content:flex-end;gap:10px">
          <span class="small muted">提交后先进行内容合规自动检测，再进入人工审核</span>
          <button class="btn btn-primary btn-lg" type="submit">${icon('send')} 提交审核</button>
        </div>
      </form>

      <aside class="stack" style="gap:16px">
        <div class="panel side-panel">
          <h4>上架小贴士</h4>
          <div class="tip-list">
            <div class="tip"><span class="num">1</span><span>上传你<strong>本人整理</strong>的资料，避免直接搬运教材、付费课程或他人笔记。</span></div>
            <div class="tip"><span class="num">2</span><span>标题写清课程、资料类型和年份；介绍里说明章节范围与是否含答案。</span></div>
            <div class="tip"><span class="num">3</span><span>首次定价建议 9.9—29.9 元，先积累评价与下载量，再考虑调整。</span></div>
            <div class="tip"><span class="num">4</span><span>平台收取 10% 服务费，其余 90% 计入你的账户收益，按 T+1 自动结算。</span></div>
          </div>
        </div>
        <div class="panel side-panel">
          <h4>审核标准</h4>
          <div class="stack" style="gap:9px">
            <div class="guarantee">${icon('checkCircle')} 内容完整、可正常打开</div>
            <div class="guarantee">${icon('checkCircle')} 描述与文件内容一致</div>
            <div class="guarantee">${icon('checkCircle')} 无侵权、无个人隐私信息</div>
            <div class="guarantee">${icon('alertCircle')} 低质拼凑、重复上传将被驳回</div>
          </div>
        </div>
      </aside>
    </div>
  </div>`;

  const form = root.querySelector('[data-upload-form]');
  attachSelectSearch(form.elements.school, { placeholder: '搜索院校，如「清华」「师范」' });
  attachSelectSearch(form.elements.subject, { placeholder: '搜索学科，支持模糊匹配' });
  const dropzone = root.querySelector('[data-dropzone]');
  const fileInput = root.querySelector('[data-file]');
  const pickedBox = root.querySelector('[data-picked]');

  const setFile = (file) => {
    if (!file) return;
    if (file.size > 20 * 1024 * 1024) {
      toast('文件不能超过 20MB', 'error');
      return;
    }
    pickedFile = file;
    pickedBox.classList.remove('hidden');
    pickedBox.innerHTML = `<span class="file-icon" style="width:42px;height:48px;font-size:10px">${esc(file.name.split('.').pop().toUpperCase().slice(0, 4))}</span>
      <div style="flex:1;min-width:0"><b>${esc(file.name)}</b><span>${fileSize(file.size)} · 已选择</span></div>
      <button class="btn btn-quiet btn-sm" type="button" data-remove-file>${icon('x')}</button>`;
    pickedBox.querySelector('[data-remove-file]').addEventListener('click', () => {
      pickedFile = null;
      fileInput.value = '';
      pickedBox.classList.add('hidden');
    });
  };

  dropzone.addEventListener('click', () => fileInput.click());
  dropzone.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') fileInput.click(); });
  fileInput.addEventListener('change', () => setFile(fileInput.files[0]));
  ['dragenter', 'dragover'].forEach((evt) => dropzone.addEventListener(evt, (e) => {
    e.preventDefault(); dropzone.classList.add('drag');
  }));
  ['dragleave', 'drop'].forEach((evt) => dropzone.addEventListener(evt, (e) => {
    e.preventDefault(); dropzone.classList.remove('drag');
  }));
  dropzone.addEventListener('drop', (e) => {
    const file = e.dataTransfer.files[0];
    if (file) setFile(file);
  });

  root.querySelectorAll('[data-price]').forEach((btn) => {
    btn.addEventListener('click', () => {
      form.elements.price.value = btn.dataset.price;
      priceTouched = true;
      checkRange();
    });
  });

  const card = root.querySelector('[data-price-card]');
  const hint = root.querySelector('[data-price-hint]');

  function checkRange() {
    if (!currentRec) return;
    const cents = Math.round(Number(form.elements.price.value || 0) * 100);
    if (cents > 0 && cents < currentRec.min) {
      hint.textContent = `当前定价低于官方参考区间（¥${yuan(currentRec.min)} — ¥${yuan(currentRec.max)}），可能影响买家信任`;
      hint.classList.add('warn');
    } else if (cents > currentRec.max) {
      hint.textContent = `当前定价高于官方参考区间（¥${yuan(currentRec.min)} — ¥${yuan(currentRec.max)}），建议说明资料亮点`;
      hint.classList.add('warn');
    } else {
      hint.textContent = '可在推荐价基础上自由调整；平台运营方保留价格校准权限';
      hint.classList.remove('warn');
    }
  }

  async function refreshPrice(apply) {
    const school = form.elements.school.value;
    const subject = form.elements.subject.value;
    const category = form.elements.category.value;
    if (!category) return;
    card.innerHTML = '<span class="small muted">正在匹配官方价格标准库…</span>';
    try {
      const params = new URLSearchParams({ category });
      if (school) params.set('school', school);
      if (subject) params.set('subject', subject);
      const res = await api.get(`/api/pricing/recommend?${params}`);
      const rec = res.recommendation;
      currentRec = rec;
      card.innerHTML = `<div class="price-rec ${rec.matched ? 'matched' : ''}">
        <div class="price-rec-head">
          <span class="badge ${rec.matched ? 'green' : 'gold'}">${rec.matched ? '已匹配官方标准库' : '平台默认参考价'}</span>
          <span class="small muted">${esc(rec.basisText)}</span>
        </div>
        <div class="price-rec-main">
          <div>
            <span class="small muted">推荐定价</span>
            <b class="price-rec-value">¥${yuan(rec.suggestion)}</b>
          </div>
          <div class="price-rec-range">参考区间 <b>¥${yuan(rec.min)}</b> — <b>¥${yuan(rec.max)}</b></div>
        </div>
        <p class="small muted">${esc(rec.note)}</p>
        <div class="row" style="justify-content:space-between;align-items:center">
          <span class="small muted">依据院校公开资料与同类成交价测算</span>
          <button type="button" class="btn btn-soft btn-sm" data-use-rec>采用推荐价</button>
        </div>
      </div>`;
      card.querySelector('[data-use-rec]').addEventListener('click', () => {
        form.elements.price.value = yuan(rec.suggestion);
        priceTouched = false;
        checkRange();
        toast('已采用官方推荐价');
      });
      if (apply && !priceTouched) {
        form.elements.price.value = yuan(rec.suggestion);
      }
      checkRange();
    } catch (err) {
      card.innerHTML = `<span class="small muted">推荐定价获取失败：${esc(err.message)}</span>`;
    }
  }

  form.elements.price.addEventListener('input', () => {
    priceTouched = true;
    checkRange();
  });
  ['category', 'school', 'subject'].forEach((name) => {
    form.elements[name].addEventListener('change', () => {
      priceTouched = false;
      refreshPrice(true);
    });
  });
  refreshPrice(true);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!pickedFile) return toast('请先选择资料文件', 'error');
    const data = new FormData(form);
    const submit = form.querySelector('button[type="submit"]');
    submit.setAttribute('aria-busy', 'true');
    try {
      const fileData = await readAsDataURL(pickedFile);
      const res = await api.post('/api/materials', {
        title: String(data.get('title')).trim(),
        category: data.get('category'),
        school: data.get('school'),
        subject: data.get('subject'),
        teacher: String(data.get('teacher')).trim(),
        course: String(data.get('course')).trim(),
        previewRatio: Number(data.get('previewRatio')),
        price: Number(data.get('price')),
        tags: String(data.get('tags')).split(/[,，]/).map((t) => t.trim()).filter(Boolean),
        description: String(data.get('description')).trim(),
        fileName: pickedFile.name,
        fileData
      });
      form.reset();
      pickedFile = null;
      pickedBox.classList.add('hidden');
      openModal({
        title: '资料已提交审核',
        subtitle: '通常 24 小时内完成，请留意卖家中心的状态',
        body: `<p class="prose">我们已收到你的资料，审核通过后会自动上架到资料市场。若被驳回，会在卖家中心显示具体原因，修改后可再次提交。</p>
          ${res && res.audit && res.audit.verdict === 'review' ? `<div class="guarantee" style="margin-top:12px">${icon('alertCircle')} 自动检测发现疑似风险内容，已优先转人工复核，不影响后续修改。</div>` : ''}`,
        footer: `<a class="btn btn-ghost" href="#/market">去资料市场</a>
                 <a class="btn btn-primary" href="#/seller">前往卖家中心</a>`
      });
    } catch (err) {
      if (err.data && err.data.code === 'CONTENT_BLOCKED') {
        const audit = err.data.audit || {};
        const categories = (audit.categories || []).map((c) => `<span class="tag">${esc(c)}</span>`).join(' ');
        const rules = (audit.rules || []).map((r) => `<div class="guarantee">${icon('alertCircle')} ${esc(r.category)} · ${esc(r.tip || r.code)}</div>`).join('');
        const modal = openModal({
          title: '内容未通过合规检测',
          subtitle: '资料已被自动拦截，不会进入审核队列，也不会对外展示',
          wide: true,
          body: `<div class="stack" style="gap:14px">
            <p class="prose" style="margin:0">${esc(err.message)}</p>
            ${categories ? `<div><div class="small muted" style="margin-bottom:6px">命中分类</div><div class="row wrap" style="gap:6px">${categories}</div></div>` : ''}
            ${rules ? `<div class="stack" style="gap:8px">${rules}</div>` : ''}
            <div class="guarantee">${icon('shield')} 平台严禁涉政、涉恐、涉黄、涉赌、涉毒、暴力诈骗等违法犯罪内容。请删除相关内容后重新提交；多次违规将限制账号发布权限，情节严重的依法移交监管部门。</div>
          </div>`,
          footer: `<a class="btn btn-ghost" href="#/about">查看平台规范</a><button class="btn btn-danger" type="button" data-ack>我知道了，去修改</button>`
        });
        modal.el.querySelector('[data-ack]').addEventListener('click', modal.close);
      } else {
        toast(err.message, 'error');
      }
    } finally {
      submit.removeAttribute('aria-busy');
    }
  });
}

function yuan(cents) {
  return (Number(cents || 0) / 100).toFixed(1).replace(/\.0$/, '');
}
