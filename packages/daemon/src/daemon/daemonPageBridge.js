export class DaemonPageBridge {
  constructor({ initialState = {} } = {}) {
    this.nextCommandId = 1;
    this.commandLog = [];
    this.maxCommandLogSize = 200;
    this.state = {
      online: false,
      lastSeenAt: null,
      lastStatus: 'idle',
      lastError: null,
      lastCommandResult: null,
      lastPeerMessage: null,
      lastPeerCommandResult: null,
      ...initialState,
    };
  }

  enqueue(type, payload = {}) {
    const command = {
      id: this.nextCommandId++,
      type,
      payload,
      createdAt: Date.now(),
    };

    this.commandLog.push(command);
    if (this.commandLog.length > this.maxCommandLogSize) {
      this.commandLog = this.commandLog.slice(this.commandLog.length - this.maxCommandLogSize);
    }

    return command;
  }

  getCommandsAfter(afterId = 0) {
    const numericAfterId = Number(afterId) || 0;
    const commands = this.commandLog.filter((command) => command.id > numericAfterId);
    const cursor = this.commandLog.length ? this.commandLog[this.commandLog.length - 1].id : numericAfterId;
    return { commands, cursor };
  }

  markSeen(status = null) {
    this.state.online = true;
    this.state.lastSeenAt = Date.now();
    if (status) {
      this.state.lastStatus = status;
    }
  }

  mergeState(partialState = {}) {
    this.state = {
      ...this.state,
      ...partialState,
      online: true,
      lastSeenAt: Date.now(),
    };
  }

  recordCommandResult(result = {}) {
    this.state.lastCommandResult = {
      ...result,
      receivedAt: Date.now(),
    };

    if (result.ok === false) {
      this.state.lastError = result.error || 'Unknown daemon command error.';
    } else if (result.ok === true) {
      this.state.lastError = null;
    }
  }

  recordPeerMessage(message = {}) {
    this.state.lastPeerMessage = {
      ...message,
      receivedAt: Date.now(),
    };
  }

  recordPeerCommandResult(result = {}) {
    this.state.lastPeerCommandResult = {
      ...result,
      receivedAt: Date.now(),
    };

    if (result.ok === false) {
      this.state.lastError = result.error || this.state.lastError;
    }
  }

  snapshot() {
    return {
      ...this.state,
      pendingCommands: this.commandLog.length,
      nextCommandId: this.nextCommandId,
    };
  }

  isOnline(maxSilenceMs = 10000) {
    if (!this.state.lastSeenAt) {
      return false;
    }
    return Date.now() - this.state.lastSeenAt <= maxSilenceMs;
  }
}
