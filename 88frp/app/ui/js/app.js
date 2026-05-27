// 前端主逻辑
document.addEventListener('DOMContentLoaded', () => {
  let instances = [];
  let currentInstanceId = null;
  let activeView = 'editor';
  let statusTimer = null;
  let actionInProgress = false;
  let originalConfigText = '';
  let originalAutoSyncEnabled = false;

  // DOM 元素
  const instanceList = document.getElementById('instanceList');
  const emptyState = document.getElementById('emptyState');
  const workbench = document.getElementById('workbench');
  const createModal = document.getElementById('createModal');
  const configEditor = document.getElementById('configEditor');
  const logContent = document.getElementById('logContent');
  const inputSecret = document.getElementById('inputSecret');
  const inputAutoSync = document.getElementById('inputAutoSync');
  const instStatusInfo = document.getElementById('instStatusInfo');
  const toast = document.getElementById('toast');
  const btnStart = document.getElementById('btnStart');
  const btnRestart = document.getElementById('btnRestart');
  const btnStop = document.getElementById('btnStop');
  const btnDelete = document.getElementById('btnDelete');
  const btnSaveConfig = document.getElementById('btnSaveConfig');

  // 初始化
  fetchInstances();
  startStatusPolling();

  // 事件绑定
  document.getElementById('btnShowCreate').onclick = () => {
    document.getElementById('newInstName').value = '';
    document.getElementById('newInstSecret').value = '';
    document.getElementById('newInstAutoSync').checked = false;
    createModal.style.display = 'flex';
  };

  document.getElementById('btnCancelCreate').onclick = () => {
    createModal.style.display = 'none';
  };

  document.getElementById('btnConfirmCreate').onclick = async () => {
    const name = document.getElementById('newInstName').value.trim();
    const secret = document.getElementById('newInstSecret').value.trim();
    const autoSyncEnabled = document.getElementById('newInstAutoSync').checked;
    if (!name) return showToast('请输入实例名称');

    try {
      const res = await API.createInstance({ name, secretKey: secret, autoSyncEnabled });
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
      const detailRes = await saveInstanceDetail();
      if (!detailRes.success) {
        return showToast(detailRes.message || '实例设置保存失败');
      }

      const res = await API.saveConfig(currentInstanceId, configEditor.value);
      if (res.success) {
        syncCurrentInstanceMeta({
          secretKey: inputSecret.value.trim(),
          autoSyncEnabled: inputAutoSync.checked,
        });
        markCurrentStateAsSaved();
        showToast(res.message || '配置已保存');
      } else {
        showToast(res.message || '配置保存失败');
      }
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
      const detailRes = await saveInstanceDetail();
      if (!detailRes.success) {
        return showToast(detailRes.message || '实例设置保存失败');
      }

      const res = await API.fetchRemoteConfig(currentInstanceId, {
        secretKey: secret,
        autoSyncEnabled: inputAutoSync.checked,
      });
      if (res.success) {
        configEditor.value = res.data.configText;
        syncCurrentInstanceMeta({
          secretKey: secret,
          autoSyncEnabled: inputAutoSync.checked,
        });
        markCurrentStateAsSaved();
        showToast(res.message || '同步成功');
      } else {
        showToast(res.message || '同步失败');
      }
    } catch (e) {
      showToast('同步失败: ' + e.message);
    }
  };

  btnStart.onclick = () => handleAction('start');
  btnRestart.onclick = () => handleAction('restart');
  btnStop.onclick = () => handleAction('stop');
  btnDelete.onclick = async () => {
    if (!currentInstanceId || actionInProgress) return;
    if (!confirm('确定要删除该实例吗？相关配置和日志将永久移除。')) return;

    const currentInstance = getCurrentInstance();
    try {
      actionInProgress = true;
      updateActionButtons();

      if (currentInstance && canStopInstance(currentInstance.runtime)) {
        showToast('删除前正在暂停实例...', 5000);
        const stopRes = await API.stopInstance(currentInstanceId);
        if (!stopRes.success) {
          return showToast(stopRes.message || '暂停实例失败，已取消删除');
        }
      }

      const res = await API.deleteInstance(currentInstanceId);
      if (res.success) {
        currentInstanceId = null;
        await fetchInstances();
        renderWorkbench();
        showToast('已删除');
      } else {
        showToast(res.message || '删除失败');
      }
    } catch (e) {
      showToast('删除失败: ' + e.message);
    } finally {
      actionInProgress = false;
      updateActionButtons();
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
  configEditor.addEventListener('input', updateDirtyState);
  inputAutoSync.addEventListener('change', updateDirtyState);

  // 函数定义
  async function fetchInstances() {
    try {
      const res = await API.getInstances();
      if (res.success) {
        instances = res.data;
        renderInstanceList();
        updateActionButtons();
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
      inputAutoSync.checked = Boolean(inst.autoSyncEnabled);
      updateActionButtons();
      try {
        const configRes = await API.getConfig(id);
        if (configRes.success) {
          configEditor.value = configRes.data.configText;
          setSavedState(configRes.data.configText, Boolean(inst.autoSyncEnabled));
        }
      } catch (e) {
        configEditor.value = '';
        setSavedState('', Boolean(inst.autoSyncEnabled));
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
      setSavedState('', false);
    }
    updateActionButtons();
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
    if (!currentInstanceId || actionInProgress) return;
    try {
      actionInProgress = true;
      updateActionButtons();

      const actionMap = {
        start: {
          request: () => API.startInstance(currentInstanceId),
          pendingText: '正在启动实例...',
          successText: '实例已启动',
        },
        restart: {
          request: () => API.restartInstance(currentInstanceId),
          pendingText: '正在重启实例...',
          successText: '实例已重启',
        },
        stop: {
          request: () => API.stopInstance(currentInstanceId),
          pendingText: '正在暂停实例...',
          successText: '实例已暂停',
        },
      };
      const currentAction = actionMap[action];
      if (!currentAction) return;

      showToast(currentAction.pendingText, 5000);
      const res = await currentAction.request();
      if (res.success) {
        showToast(res.message || currentAction.successText);
        await fetchInstances();
      } else {
        showToast('失败: ' + res.message);
      }
    } catch (e) {
      showToast('操作异常: ' + e.message);
    } finally {
      actionInProgress = false;
      updateActionButtons();
    }
  }

  async function saveInstanceDetail() {
    return API.updateInstance(currentInstanceId, {
      secretKey: inputSecret.value.trim(),
      autoSyncEnabled: inputAutoSync.checked,
    });
  }

  function syncCurrentInstanceMeta(patch) {
    instances = instances.map(inst => (
      inst.id === currentInstanceId
        ? { ...inst, ...patch }
        : inst
    ));
  }

  function getCurrentInstance() {
    return instances.find(inst => inst.id === currentInstanceId) || null;
  }

  function canStopInstance(runtime = {}) {
    return runtime.status === 'running';
  }

  function canRestartInstance(runtime = {}) {
    return runtime.status === 'running';
  }

  function canStartInstance(runtime = {}) {
    return !runtime.status || runtime.status === 'stopped' || runtime.status === 'error';
  }

  function updateActionButtons() {
    const currentInstance = getCurrentInstance();
    const hasInstance = Boolean(currentInstanceId && currentInstance);
    const runtime = (currentInstance && currentInstance.runtime) || {};
    const showStart = hasInstance && canStartInstance(runtime);
    const showRestart = hasInstance && canRestartInstance(runtime);
    const showStop = hasInstance && canStopInstance(runtime);

    btnStart.style.display = showStart ? 'inline-flex' : 'none';
    btnRestart.style.display = showRestart ? 'inline-flex' : 'none';
    btnStop.style.display = showStop ? 'inline-flex' : 'none';

    btnStart.disabled = !showStart || actionInProgress;
    btnRestart.disabled = !showRestart || actionInProgress;
    btnStop.disabled = !showStop || actionInProgress;
    btnDelete.disabled = !hasInstance || actionInProgress;
  }

  function normalizeEditorText(text) {
    return String(text || '').replace(/\r\n/g, '\n');
  }

  function setSavedState(configText, autoSyncEnabled) {
    originalConfigText = normalizeEditorText(configText);
    originalAutoSyncEnabled = Boolean(autoSyncEnabled);
    updateDirtyState();
  }

  function markCurrentStateAsSaved() {
    setSavedState(configEditor.value, inputAutoSync.checked);
  }

  function updateDirtyState() {
    const hasInstance = Boolean(currentInstanceId);
    const isDirty = hasInstance && (
      normalizeEditorText(configEditor.value) !== originalConfigText ||
      Boolean(inputAutoSync.checked) !== originalAutoSyncEnabled
    );
    btnSaveConfig.classList.toggle('is-dirty', isDirty);
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
