const storageKey = 'hyperagents:browser-handoff-demo:v1';
const form = document.getElementById('registration-demo');
const nickname = document.getElementById('nickname');
const submit = document.getElementById('complete-demo');
const result = document.getElementById('result');
const message = document.getElementById('completion-message');
const reset = document.getElementById('reset-demo');

function showCompletion(name) {
  nickname.value = name;
  nickname.disabled = true;
  submit.disabled = true;
  message.textContent = `演示注册完成：${name}`;
  result.hidden = false;
  reset.hidden = false;
}

try {
  const saved = JSON.parse(sessionStorage.getItem(storageKey) || 'null');
  if (typeof saved?.nickname === 'string' && saved.nickname.trim() && saved.nickname.length <= 32) showCompletion(saved.nickname);
} catch { /* Storage can be disabled; the current page still works. */ }

nickname.addEventListener('input', () => nickname.setCustomValidity(''));
form.addEventListener('submit', (event) => {
  event.preventDefault();
  const name = nickname.value.trim();
  if (!name) {
    nickname.setCustomValidity('请输入一个测试昵称。');
    nickname.reportValidity();
    return;
  }
  const boundedName = name.slice(0, 32);
  try { sessionStorage.setItem(storageKey, JSON.stringify({ nickname: boundedName })); } catch { /* No server fallback. */ }
  showCompletion(boundedName);
});

reset.addEventListener('click', () => {
  try { sessionStorage.removeItem(storageKey); } catch { /* No server fallback. */ }
  form.reset();
  nickname.disabled = false;
  nickname.setCustomValidity('');
  submit.disabled = false;
  result.hidden = true;
  reset.hidden = true;
  message.textContent = '';
  nickname.focus();
});
