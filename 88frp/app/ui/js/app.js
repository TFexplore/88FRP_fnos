// 前端主逻辑
document.addEventListener('DOMContentLoaded', () => {
  let instances = [];
  let currentInstanceId = null;
  let activeView = 'editor';
  let statusTimer = null;

  // DOM 元素
  const instanceList = document.getElementById('instanceList');
  const emptyState = document.getElementById('emptyState');
  const workbench = document.getElementById('workbench');
  const createModal = document.getElementById('createModal');
  const configEditor = document.getElementById('configEditor');
  const logContent = document.getElementById('logContent');
  const inputSecret = document.getElementById('inputSecret');
  const instStatusInfo = document.getElementById('instStatusInfo');
  const toast = document.getElementById('toast');

  // 初始化
  fetchInstances();
  startStatusPolling();

  // 事件绑定
  document.getElementById('btnShowCreate').onclick = () => {
    document.getElementById('newInstName').value = '';
    document.getElementById('newInstSecret').value = '';
    createModal.style.display = 'flex';
  };

  document.getElementById('btnCancelCreate').onclick = () => {
    createModal.style.display = 'none';
  };

  document.getElementById('btnConfirmCreate').onclick = async () => {
    const name = document.getElementById('newInstName').value.trim();
    const secret = document.getElementById('newInstSecret').value.trim();
    if (!name) return showToast('请输入实例名称');

    try {
      const res = await API.createInstance({ name, secretKey: secret });
      if (res.success) {
        createModal.style.display = 'none';
        await fetchInstances();
        selectInstance(res.data.id);
        showToast('创建成功');
      }
    } catch (e) {
      showToast('创建失败: ' + e.message);
    }
  };

  document.getElementById('btnSaveConfig').onclick = async () => {
    if (!currentInstanceId) return;
    try {
      const res = await API.saveConfig(currentInstanceId, configEditor.value);
      if (res.success) showToast('配置已保存');
    } catch (e) {
      showToast('保存失败: ' + e.message);
    }
  };

  document.getElementById('btnSync').onclick = async () => {
    if (!currentInstanceId) return;
    const secret = inputSecret.value.trim();
    if (!secret) return showToast('请先输入密匙');

    try {
      showToast('正在拉取配置...', 5000);
      const res = await API.fetchRemoteConfig(currentInstanceId, { secretKey: secret });
      if (res.success) {
        configEditor.value = res.data.configText;
        showToast('同步成功');
      }
    } catch (e) {
      showToast('同步失败: ' + e.message);
    }
  };

  document.getElementById('btnStart').onclick = () => handleAction('start');
  document.getElementById('btnStop').onclick = () => handleAction('stop');
  document.getElementById('btnDelete').onclick = async () => {
    if (!confirm('确定要删除该实例吗？相关配置和日志将永久移除。')) return;
    try {
      const res = await API.deleteInstance(currentInstanceId);
      if (res.success) {
        currentInstanceId = null;
        await fetchInstances();
        renderWorkbench();
        showToast('已删除');
      }
    } catch (e) {
      showToast('删除失败: ' + e.message);
    }
  };

  document.querySelectorAll('.tab').forEach(tab => {
    tab.onclick = () => {
      activeView = tab.dataset.view;
      renderTabs();
      if (activeView === 'log') fetchLogs();
    };
  });

  document.getElementById('btnRefreshLog').onclick = fetchLogs;

  // 函数定义
  async function fetchInstances() {
    try {
      const res = await API.getInstances();
      if (res.success) {
        instances = res.data;
        renderInstanceList();
      }
    } catch (e) {
      console.error('Fetch instances failed', e);
    }
  }

  function renderInstanceList() {
    instanceList.innerHTML = '';
    instances.forEach(inst => {
      const item = document.createElement('div');
      item.className = `instance-item ${inst.id === currentInstanceId ? 'active' : ''}`;
      item.onclick = () => selectInstance(inst.id);
      
      const runtime = inst.runtime || {};
      const statusClass = runtime.status === 'running' ? 'running' : (runtime.status === 'error' ? 'error' : '');
      
      item.innerHTML = `
        <div class="instance-info">
          <span class="instance-name">${inst.name}</span>
          <div class="instance-status">
            <span class="status-dot ${statusClass}"></span>
            <span>${translateStatus(runtime.status)}</span>
          </div>
        </div>
      `;
      instanceList.appendChild(item);
    });
    
    // 如果有选中的实例，更新工作台状态信息
    if (currentInstanceId) {
      updateStatusInfo();
    }
  }

  function updateStatusInfo() {
    const inst = instances.find(i => i.id === currentInstanceId);
    if (!inst || !inst.runtime) {
      instStatusInfo.innerHTML = '';
      return;
    }

    const runtime = inst.runtime;
    if (runtime.status === 'running') {
      const uptime = calculateUptime(runtime.lastStartedAt);
      instStatusInfo.innerHTML = `
        <span>PID: <b>${runtime.pid}</b></span>
        <span>运行时间: <b>${uptime}</b></span>
      `;
    } else if (runtime.status === 'error' && runtime.lastError) {
      instStatusInfo.innerHTML = `<span style="color: var(--accent-red)">${runtime.lastError}</span>`;
    } else {
      instStatusInfo.innerHTML = `<span>状态: <b>${translateStatus(runtime.status)}</b></span>`;
    }
  }

  function calculateUptime(startTime) {
    if (!startTime) return '未知';
    const start = new Date(startTime).getTime();
    const now = new Date().getTime();
    const diff = Math.floor((now - start) / 1000);

    if (diff < 60) return `${diff}秒`;
    if (diff < 3600) return `${Math.floor(diff / 60)}分${diff % 60}秒`;
    const hours = Math.floor(diff / 3600);
    const mins = Math.floor((diff % 3600) / 60);
    return `${hours}小时${mins}分`;
  }

  async function selectInstance(id) {
    currentInstanceId = id;
    renderInstanceList();
    renderWorkbench();
    
    const inst = instances.find(i => i.id === id);
    if (inst) {
      inputSecret.value = inst.secretKey || '';
      try {
        const configRes = await API.getConfig(id);
        if (configRes.success) {
          configEditor.value = configRes.data.configText;
        }
      } catch (e) {
        configEditor.value = '';
      }
      if (activeView === 'log') fetchLogs();
    }
  }

  function renderWorkbench() {
    if (currentInstanceId) {
      emptyState.style.display = 'none';
      workbench.style.display = 'flex';
    } else {
      emptyState.style.display = 'flex';
      workbench.style.display = 'none';
    }
  }

  function renderTabs() {
    document.querySelectorAll('.tab').forEach(t => {
      t.classList.toggle('active', t.dataset.view === activeView);
    });
    document.getElementById('editorView').classList.toggle('active', activeView === 'editor');
    document.getElementById('logView').classList.toggle('active', activeView === 'log');
  }

  async function fetchLogs() {
    if (!currentInstanceId || activeView !== 'log') return;
    try {
      const res = await API.getLogs(currentInstanceId);
      logContent.innerText = res.data.content || '暂无日志内容';
      logContent.scrollTop = logContent.scrollHeight;
    } catch (e) {
      logContent.innerText = '获取日志失败: ' + e.message;
    }
  }

  async function handleAction(action) {
    if (!currentInstanceId) return;
    try {
      showToast('正在执行操作...');
      const res = await (action === 'start' ? API.startInstance(currentInstanceId) : API.stopInstance(currentInstanceId));
      if (res.success) {
        showToast('操作成功');
        await fetchInstances();
      } else {
        showToast('失败: ' + res.message);
      }
    } catch (e) {
      showToast('操作异常: ' + e.message);
    }
  }

  function startStatusPolling() {
    if (statusTimer) clearInterval(statusTimer);
    statusTimer = setInterval(async () => {
      await fetchInstances();
      if (activeView === 'log') fetchLogs();
    }, 3000);
  }

  function translateStatus(s) {
    const map = {
      'running': '运行中',
      'stopped': '已停止',
      'error': '异常',
      'starting': '正在启动',
      'stopping': '正在停止'
    };
    return map[s] || s;
  }

  function showToast(msg, duration = 3000) {
    toast.innerText = msg;
    toast.style.display = 'block';
    setTimeout(() => {
      toast.style.display = 'none';
    }, duration);
  }
});
