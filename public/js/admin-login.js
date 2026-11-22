const $ = (id) => document.getElementById(id);
const TOKEN_KEY = 'xueya_token';

const steps = {
  login: $('step-login'),
  mfa: $('step-mfa'),
  password: $('step-password'),
  done: $('step-done')
};

const state = {
  mfaToken: '',
  pwdToken: '',
  countdownTimer: 0
};

function showStep(name) {
  for (const [key, el] of Object.entries(steps)) el.hidden = key !== name;
}

function setError(el, message) {
  if (!message) {
    el.hidden = true;
    el.textContent = '';
    return;
  }
  el.hidden = false;
  el.textContent = message;
}

function busy(button, value) {
  button.disabled = value;
  button.setAttribute('aria-busy', value ? 'true' : 'false');
}

function startCountdown(seconds) {
  window.clearInterval(state.countdownTimer);
  let left = Math.max(1, Number(seconds) || 0);
  const button = document.querySelector('button[type="submit"]');
  const render = () => {
    if (left <= 0) {
      window.clearInterval(state.countdownTimer);
      if (button) button.disabled = false;
      return;
    }
    if (button) button.disabled = true;
    document.querySelectorAll('.error:not([hidden])').forEach((el) => {
      el.textContent = `${el.dataset.base || el.textContent.replace(/（\d+ 秒后可重试）$/, '')}（${left} 秒后可重试）`;
    });
    left -= 1;
  };
  render();
  state.countdownTimer = window.setInterval(render, 1000);
}

async function post(path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(path, { method: 'POST', headers, body: JSON.stringify(body) });
  let data = {};
  try {
    data = await res.json();
  } catch {
    data = {};
  }
  if (res.status === 423 && data.retryAfter) startCountdown(data.retryAfter);
  return { ok: res.ok, status: res.status, data };
}

/* ---- 第一步：账号密码 ---- */
$('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const error = $('login-error');
  const button = $('login-submit');
  setError(error, '');
  busy(button, true);
  try {
    const result = await post('/api/admin/auth/login', {
      account: $('account').value.trim(),
      password: $('password').value
    });
    if (!result.ok) {
      setError(error, result.data.error || '登录失败，请稍后重试');
      return;
    }
    state.mfaToken = result.data.mfaToken || '';
    if (result.data.stage === 'enroll' && result.data.secret) {
      $('enroll-box').hidden = false;
      $('mfa-secret').textContent = result.data.secret;
      const link = $('otpauth-link');
      link.href = result.data.otpauth || '#';
      link.textContent = '在验证器应用中打开绑定链接';
    } else {
      $('enroll-box').hidden = true;
    }
    showStep('mfa');
    $('code').value = '';
    $('code').focus();
  } catch {
    setError(error, '网络异常，请稍后重试');
  } finally {
    busy(button, false);
  }
});

/* ---- 第二步：动态验证码 ---- */
$('mfa-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const error = $('mfa-error');
  const button = $('mfa-submit');
  setError(error, '');
  busy(button, true);
  try {
    const result = await post('/api/admin/auth/mfa', {
      mfaToken: state.mfaToken,
      code: $('code').value.trim()
    });
    if (!result.ok) {
      setError(error, result.data.error || '验证失败，请稍后重试');
      return;
    }
    if (result.data.stage === 'password_expired') {
      state.pwdToken = result.data.token || '';
      $('password-tip').textContent = result.data.message || '管理员密码已过期，请先修改密码。';
      showStep('password');
      $('oldPassword').value = $('password').value;
      $('oldPassword').focus();
      return;
    }
    if (result.data.stage === 'ok' && result.data.token) {
      localStorage.setItem(TOKEN_KEY, result.data.token);
      window.location.replace('/#/admin');
      return;
    }
    setError(error, '登录状态异常，请重新登录');
  } catch {
    setError(error, '网络异常，请稍后重试');
  } finally {
    busy(button, false);
  }
});

$('mfa-back').addEventListener('click', () => {
  state.mfaToken = '';
  setError($('mfa-error'), '');
  showStep('login');
});

/* ---- 第三步：密码过期改密 ---- */
$('password-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const error = $('password-error');
  const button = $('password-submit');
  setError(error, '');
  const newPassword = $('newPassword').value;
  if (newPassword !== $('confirmPassword').value) {
    setError(error, '两次输入的新密码不一致');
    return;
  }
  busy(button, true);
  try {
    const result = await post('/api/admin/auth/password', {
      oldPassword: $('oldPassword').value,
      newPassword,
      code: $('pwdCode').value.trim()
    }, state.pwdToken);
    if (!result.ok) {
      setError(error, result.data.error || '密码更新失败');
      return;
    }
    state.pwdToken = '';
    localStorage.removeItem(TOKEN_KEY);
    $('done-message').textContent = result.data.message || '密码已更新，请重新登录。';
    showStep('done');
  } catch {
    setError(error, '网络异常，请稍后重试');
  } finally {
    busy(button, false);
  }
});

$('done-back').addEventListener('click', () => {
  $('password-form').reset();
  setError($('password-error'), '');
  showStep('login');
});

/* 仅保留数字输入，提升动态码输入体验 */
['code', 'pwdCode'].forEach((id) => {
  $(id).addEventListener('input', (event) => {
    event.target.value = event.target.value.replace(/\D/g, '').slice(0, 6);
  });
});
