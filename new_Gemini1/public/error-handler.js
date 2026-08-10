// Global error handler - helps debug "SSH connect doesn't work" issues
window.onerror = function(msg, url, lineNo, columnNo, error) {
  const errMsg = `JS Error: ${msg} at ${url}:${lineNo}:${columnNo}`;
  console.error(errMsg, error);
  // Show error in the connection modal if it's open
  const errEl = document.getElementById('conn-err');
  if (errEl) {
    errEl.textContent = errMsg;
    errEl.style.display = 'block';
  }
  return false;
};

// Also catch unhandled promise rejections
window.onunhandledrejection = function(e) {
  console.error('Unhandled Promise Rejection:', e.reason);
  const errEl = document.getElementById('conn-err');
  if (errEl && document.getElementById('modal-conn')?.classList.contains('hidden') === false) {
    errEl.textContent = 'Promise error: ' + (e.reason?.message || e.reason);
    errEl.style.display = 'block';
  }
};
