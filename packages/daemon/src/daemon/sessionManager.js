import { normalizeId } from './sessionOptions.js';

// Ordered stages a session moves through, surfaced in status payloads/logs.
export const SESSION_STAGES = {
  START: 'start',
  LAUNCH_CHROME: 'launch_chrome',
  OPEN_DAEMON_PAGE: 'open_daemon_page',
  OPEN_TARGET_PAGE: 'open_target_page',
  CONNECT_TO_SIGNAL_SERVER: 'connect_to_signal_server',
  WAIT_CLIENT_RESOLVE: 'wait_client_resolve',
  USER_INTERACTION: 'user_interaction',
  FINISH: 'finish',
};

// Owns the lifecycle of the single active daemon session: its progress/status
// state, the client-message inactivity timeout, the `leave` grace window, the
// ready/completion waiter queues, and termination cleanup. index.js drives the
// session flow and message routing; this class holds the state those steps mutate.
export class SessionManager {
  constructor({ browser, daemonPageBridge, logger, config, getFallbackClientId }) {
    this.browser = browser;
    this.daemonPageBridge = daemonPageBridge;
    this.logger = logger;
    this.config = config;
    // Fallback client id for pre-session timeouts (before activeSession.clientId is set).
    this.getFallbackClientId = typeof getFallbackClientId === 'function' ? getFallbackClientId : () => '';

    this.STAGES = SESSION_STAGES;

    this.clientMessageTimeoutHandle = null;
    // Pending `leave` grace timer -- see scheduleLeaveTermination(). Non-null means a
    // leave was received and we are waiting to see if the client reconnects (refresh)
    // before actually terminating the session (close).
    this.pendingLeaveHandle = null;
    this.pendingLeaveClientId = '';
    this.currentClientMessageTimeoutMs = Number(config.clientMessageTimeoutMs || 120000);

    this.snapshots = [];
    this.readyWaiters = [];
    this.completionWaiters = [];

    this.activeSession = {
      id: '',
      daemonId: '',
      clientId: '',
      targetUrl: '',
      timeoutMs: this.currentClientMessageTimeoutMs,
      stage: SESSION_STAGES.START,
      status: 'idle',
      statusMessage: '',
      outcome: '',
      connected: false,
      connectedAt: 0,
      resolved: false,
      startedAt: 0,
      lastResolveAt: 0,
      lastResolveFrom: '',
      lastFinishAt: 0,
      lastFinishFrom: '',
      completedAt: 0,
      snapshots: this.snapshots,
    };
  }

  // Resets activeSession to a fresh running session with the given identity.
  beginSession({ id, daemonId, clientId, targetUrl, timeoutMs }) {
    const s = this.activeSession;
    s.id = id;
    s.daemonId = daemonId;
    s.clientId = clientId;
    s.targetUrl = targetUrl;
    s.timeoutMs = timeoutMs;
    s.stage = SESSION_STAGES.START;
    s.status = 'running';
    s.statusMessage = 'session initialized';
    s.outcome = '';
    s.connected = false;
    s.connectedAt = 0;
    s.resolved = false;
    s.startedAt = Date.now();
    s.lastResolveAt = 0;
    s.lastResolveFrom = '';
    s.lastFinishAt = 0;
    s.lastFinishFrom = '';
    s.completedAt = 0;
    this.snapshots.length = 0;
  }

  updateProgress(stage, status, statusMessage = '') {
    this.activeSession.stage = stage;
    this.activeSession.status = status;
    this.activeSession.statusMessage = statusMessage;
  }

  notifyCompletionWaiters(result) {
    while (this.completionWaiters.length) {
      const waiter = this.completionWaiters.shift();
      clearTimeout(waiter.timer);
      waiter.resolve(result);
    }
  }

  completeSession(outcome, statusMessage = '') {
    if (this.activeSession.completedAt) {
      return;
    }

    this.clearClientMessageTimeout();
    // The session is ending now; any deferred leave timer is moot.
    this.clearPendingLeave('session_completed');
    this.activeSession.outcome = outcome;
    this.activeSession.completedAt = Date.now();
    this.updateProgress(SESSION_STAGES.FINISH, outcome, statusMessage);
    this.notifyCompletionWaiters({
      outcome,
      status: this.activeSession.status,
      stage: this.activeSession.stage,
      statusMessage,
      completedAt: this.activeSession.completedAt,
    });
  }

  enqueueTerminalNotice(type, {
    clientId = '',
    message = '',
    status = '',
    outcome = '',
    stage = SESSION_STAGES.FINISH,
  } = {}) {
    const targetId = String(clientId || this.activeSession.clientId || '').trim();
    if (!targetId) {
      return null;
    }

    return this.daemonPageBridge.enqueue('send_peer_notice', {
      targetId,
      type,
      requestId: `${type}-${Date.now()}`,
      message,
      payload: {
        clientId: targetId,
        sessionId: this.activeSession.id,
        stage,
        status,
        outcome,
        completedAt: Date.now(),
      },
    });
  }

  // True when a message's origin/payload client id identifies the active session's
  // client (or a session is active and not yet completed).
  isMessageForActiveClient({ expectedActiveClientId, messageOrigin, payloadClientId }) {
    const originMatchesActiveClient = normalizeId(messageOrigin) && expectedActiveClientId && normalizeId(messageOrigin) === expectedActiveClientId;
    const payloadMatchesActiveClient = normalizeId(payloadClientId) && expectedActiveClientId && normalizeId(payloadClientId) === expectedActiveClientId;
    return Boolean(originMatchesActiveClient || payloadMatchesActiveClient || (this.activeSession.id && !this.activeSession.completedAt));
  }

  async handleTerminationMessage(options = {}) {
    const {
      outcome,
      statusMessage,
      snapshotPrefix,
      sendNotice = false,
      updateSessionState = null, // function to update activeSession state
    } = options;

    if (!this.isMessageForActiveClient(options)) {
      return false;
    }

    // Update session state if needed
    if (updateSessionState) {
      updateSessionState();
    }

    // Capture snapshot
    try {
      const snapshot = await this.browser.saveTargetSnapshotToFile({
        fullPage: true,
        outputDir: this.config.timeoutSnapshotDir,
        fileNamePrefix: snapshotPrefix,
      });
      this.rememberTimeoutSnapshot(snapshot, outcome);
    } catch (error) {
      this.logger.warn(`Failed to capture ${outcome} snapshot.`, {
        error: error.message,
      });
    }

    // Close only the daemon.html control page as part of termination cleanup
    // (client finish/leave or timeout). This must run BEFORE completeSession(),
    // because completeSession() notifies the completion waiters that drive the
    // runtime's browser shutdown -- once that teardown starts it races (and closes)
    // the CDP connection, making page.close() fail. The target page and the browser
    // itself are intentionally left untouched here.
    try {
      await this.browser.closeDaemonPage();
    } catch (error) {
      this.logger.warn(`Failed to close daemon page on ${outcome}.`, {
        error: error.message,
      });
    }

    // Complete session
    this.completeSession(outcome, statusMessage);

    // Send terminal notice if requested
    if (sendNotice) {
      this.enqueueTerminalNotice(`${outcome}_ack`, {
        clientId: this.activeSession.clientId,
        message: this.activeSession.statusMessage,
        status: this.activeSession.status,
        outcome: this.activeSession.outcome,
      });
    }

    return true;
  }

  // Cancel a pending leave grace timer, if any. Returns true if one was cancelled.
  clearPendingLeave(reason = '') {
    if (!this.pendingLeaveHandle) {
      return false;
    }
    clearTimeout(this.pendingLeaveHandle);
    this.pendingLeaveHandle = null;
    const cancelledFor = this.pendingLeaveClientId;
    this.pendingLeaveClientId = '';
    this.logger.info('LEAVE_GRACE_CANCELLED', { reason, clientId: cancelledFor });
    return true;
  }

  // Handle a `leave` message with a grace window instead of terminating right away.
  // A page refresh and a page close both emit `leave`; by deferring termination we
  // give a refreshing client a chance to reconnect (it will send `resolve` again),
  // in which case the resolve handler cancels this timer. If nobody reconnects, the
  // timer fires and we terminate the session as a genuine close.
  scheduleLeaveTermination(options = {}) {
    const { messageOrigin, payloadClientId } = options;
    if (!this.isMessageForActiveClient(options)) {
      return false;
    }

    // A repeated leave simply restarts the grace window.
    if (this.pendingLeaveHandle) {
      clearTimeout(this.pendingLeaveHandle);
      this.pendingLeaveHandle = null;
    }

    this.pendingLeaveClientId = normalizeId(messageOrigin || payloadClientId) || String(this.activeSession.clientId || '');
    const graceMs = Number(this.config.leaveGraceMs) || 8000;
    this.logger.info('LEAVE_GRACE_STARTED', { graceMs, clientId: this.pendingLeaveClientId });

    this.pendingLeaveHandle = setTimeout(() => {
      this.pendingLeaveHandle = null;
      this.pendingLeaveClientId = '';
      // Grace window elapsed with no reconnect -> treat as a real page close.
      this.logger.info('LEAVE_GRACE_ELAPSED', { clientId: options.payloadClientId || options.messageOrigin || '' });
      void this.handleTerminationMessage(options);
    }, graceMs);

    return true;
  }

  waitForSessionCompletion(timeoutMs = 0) {
    if (this.activeSession.completedAt) {
      return Promise.resolve({
        outcome: this.activeSession.outcome,
        status: this.activeSession.status,
        stage: this.activeSession.stage,
        statusMessage: this.activeSession.statusMessage,
        completedAt: this.activeSession.completedAt,
      });
    }

    return new Promise((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        timer: null,
      };

      if (timeoutMs > 0) {
        waiter.timer = setTimeout(() => {
          const index = this.completionWaiters.indexOf(waiter);
          if (index !== -1) {
            this.completionWaiters.splice(index, 1);
          }
          reject(new Error('Timed out waiting for session completion.'));
        }, timeoutMs);
      }

      this.completionWaiters.push(waiter);
    });
  }

  notifyReadyWaiters() {
    if (!(this.activeSession.connected && this.activeSession.resolved)) {
      return;
    }

    while (this.readyWaiters.length) {
      const waiter = this.readyWaiters.shift();
      clearTimeout(waiter.timer);
      waiter.resolve({
        sessionId: this.activeSession.id,
        connectedAt: this.activeSession.connectedAt,
        resolveAt: this.activeSession.lastResolveAt,
        resolveFrom: this.activeSession.lastResolveFrom,
      });
    }
  }

  waitForSessionReady(timeoutMs) {
    if (this.activeSession.connected && this.activeSession.resolved) {
      return Promise.resolve({
        sessionId: this.activeSession.id,
        connectedAt: this.activeSession.connectedAt,
        resolveAt: this.activeSession.lastResolveAt,
        resolveFrom: this.activeSession.lastResolveFrom,
      });
    }

    return new Promise((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        timer: null,
      };

      waiter.timer = setTimeout(() => {
        const index = this.readyWaiters.indexOf(waiter);
        if (index !== -1) {
          this.readyWaiters.splice(index, 1);
        }
        reject(new Error('Timed out waiting for client connection and resolve message.'));
      }, timeoutMs);

      this.readyWaiters.push(waiter);
    });
  }

  waitForSessionReadyOrCompletion(timeoutMs = 0) {
    if (this.activeSession.connected && this.activeSession.resolved) {
      return Promise.resolve({
        kind: 'ready',
        data: {
          sessionId: this.activeSession.id,
          connectedAt: this.activeSession.connectedAt,
          resolveAt: this.activeSession.lastResolveAt,
          resolveFrom: this.activeSession.lastResolveFrom,
        },
      });
    }

    if (this.activeSession.completedAt) {
      return Promise.resolve({
        kind: 'completion',
        data: {
          outcome: this.activeSession.outcome,
          status: this.activeSession.status,
          stage: this.activeSession.stage,
          statusMessage: this.activeSession.statusMessage,
          completedAt: this.activeSession.completedAt,
        },
      });
    }

    return new Promise((resolve, reject) => {
      let settled = false;

      const finalize = (result) => {
        if (settled) {
          return;
        }
        settled = true;
        clearInterval(probeTimer);
        clearTimeout(timeoutTimer);
        resolve(result);
      };

      const probe = () => {
        if (this.activeSession.connected && this.activeSession.resolved) {
          finalize({
            kind: 'ready',
            data: {
              sessionId: this.activeSession.id,
              connectedAt: this.activeSession.connectedAt,
              resolveAt: this.activeSession.lastResolveAt,
              resolveFrom: this.activeSession.lastResolveFrom,
            },
          });
          return;
        }

        if (this.activeSession.completedAt) {
          finalize({
            kind: 'completion',
            data: {
              outcome: this.activeSession.outcome,
              status: this.activeSession.status,
              stage: this.activeSession.stage,
              statusMessage: this.activeSession.statusMessage,
              completedAt: this.activeSession.completedAt,
            },
          });
        }
      };

      const probeTimer = setInterval(probe, 100);
      const timeoutTimer = timeoutMs > 0
        ? setTimeout(() => {
          if (settled) {
            return;
          }
          settled = true;
          clearInterval(probeTimer);
          reject(new Error('Timed out waiting for session readiness or completion.'));
        }, timeoutMs)
        : null;

      probe();
    });
  }

  rememberTimeoutSnapshot(snapshot = {}, type = 'timeout') {
    const snapshotPath = String(snapshot.outputPath || '').trim();
    if (!snapshotPath) {
      return;
    }

    const capturedAt = Date.now();
    this.snapshots.push({
      type: String(type || 'timeout').trim() || 'timeout',
      timestamp: new Date(capturedAt).toISOString(),
      path: snapshotPath,
    });
  }

  clearClientMessageTimeout() {
    if (!this.clientMessageTimeoutHandle) {
      return;
    }
    clearTimeout(this.clientMessageTimeoutHandle);
    this.clientMessageTimeoutHandle = null;
  }

  armClientMessageTimeout(reason = 'init', timeoutMsOverride = null) {
    this.clearClientMessageTimeout();
    const timeoutMs = Number(timeoutMsOverride || this.currentClientMessageTimeoutMs || this.config.clientMessageTimeoutMs || 120000);
    this.currentClientMessageTimeoutMs = timeoutMs;
    this.clientMessageTimeoutHandle = setTimeout(async () => {
      this.clientMessageTimeoutHandle = null;

      const fallbackClientId = this.getFallbackClientId();
      this.logger.warn('Client message timeout reached. Capturing full-page snapshot.', {
        timeoutMs,
        reason,
        clientId: fallbackClientId,
        outputDir: this.config.timeoutSnapshotDir,
      });

      try {
        const snapshot = await this.browser.saveTargetSnapshotToFile({
          fullPage: true,
          outputDir: this.config.timeoutSnapshotDir,
          fileNamePrefix: `timeout-${fallbackClientId || 'client'}`,
        });
        this.rememberTimeoutSnapshot(snapshot, 'timeout');
        this.logger.info('Timeout snapshot saved.', {
          outputPath: snapshot.outputPath,
          targetUrl: snapshot?.targetPage?.url || '',
        });
      } catch (error) {
        this.logger.error('Timeout snapshot failed.', {
          error: error.message,
        });
      }

      if (this.activeSession.id) {
        this.completeSession('timeout', `Session timed out after ${Math.max(1, Math.floor(timeoutMs / 1000))} seconds.`);
        this.enqueueTerminalNotice('timeout_notice', {
          clientId: this.activeSession.clientId,
          message: this.activeSession.statusMessage,
          status: this.activeSession.status,
          outcome: this.activeSession.outcome,
        });
      }
    }, timeoutMs);
  }
}
