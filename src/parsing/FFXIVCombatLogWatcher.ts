import { EventEmitter } from 'stream';
import WebSocket from 'ws';
import FFXIVLogLine from './FFXIVLogLine';
import { FFXIVGameState, LogType } from '../main/FFXIVTypes';

/**
 * WebSocket message format from IINACT/OverlayPlugin
 */
interface WebSocketMessage {
  type: string;
  rawLine?: string;
  // Cactbot event detail object
  detail?: Record<string, unknown>;
}

/**
 * Party member data from the PartyChanged event.
 */
export interface PartyMember {
  id: string; // hex string
  name: string;
  worldId: number;
  job: number; // raw job ID (decimal)
  level: number;
  inParty: boolean;
}

/**
 * Connects to IINACT/OverlayPlugin's WebSocket API to receive real-time
 * log data from FFXIV. Emits events containing a LogLine object for
 * processing elsewhere.
 */
export default class FFXIVCombatLogWatcher extends EventEmitter {
  /**
   * The WebSocket URL to connect to.
   */
  private wsUrl: string;

  /**
   * The WebSocket connection.
   */
  private ws?: WebSocket;

  /**
   * A duration after seeing a log event to send a timeout event in if no
   * other subsequent log events are seen. In seconds.
   */
  private timeout: number;

  /**
   * A handle to the timeout timer so we can easily reset it when we see
   * additional logs.
   */
  private timer?: NodeJS.Timeout;

  /**
   * Handle for the reconnection timer.
   */
  private reconnectTimer?: NodeJS.Timeout;

  /**
   * Reconnection interval in milliseconds.
   */
  private reconnectInterval = 5000;

  /**
   * Whether we should be watching (used to prevent reconnect after unwatch).
   */
  private shouldBeWatching = false;

  /**
   * Whether reconnection is enabled (controlled by game running state).
   */
  private reconnectEnabled = false;

  /**
   * Current game state tracked from WebSocket messages.
   */
  private gameState: FFXIVGameState = {
    inCombat: false,
    zoneId: null,
    zoneName: null,
    inContentFinderContent: false,
    timestamp: null,
    playerId: null,
  };

  /**
   * Constructor, unit of timeout is minutes. No events will be emitted until
   * watch() is called.
   */
  constructor(wsUrl: string, timeout: number) {
    super();
    this.timeout = timeout * 1000 * 60;
    this.wsUrl = wsUrl;
  }

  /**
   * Start watching by connecting to the WebSocket.
   * Note: Connection will only happen if reconnect is enabled (game is running).
   */
  public async watch() {
    this.shouldBeWatching = true;
    if (this.reconnectEnabled) {
      this.connect();
    }
  }

  /**
   * Enable reconnection (called when game starts running).
   */
  public enableReconnect() {
    console.info('[FFXIVCombatLogWatcher] Enabling reconnect');
    this.reconnectEnabled = true;
    if (this.shouldBeWatching && !this.ws) {
      this.connect();
    }
  }

  /**
   * Disable reconnection (called when game stops running).
   */
  public disableReconnect() {
    console.info('[FFXIVCombatLogWatcher] Disabling reconnect');
    this.reconnectEnabled = false;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }

    if (this.ws) {
      this.ws.close();
      this.ws = undefined;
    }
  }

  /**
   * Connect to the WebSocket server.
   */
  private connect() {
    if (!this.shouldBeWatching) {
      return;
    }

    console.info(
      '[FFXIVCombatLogWatcher] Connecting to WebSocket:',
      this.wsUrl,
    );

    try {
      this.ws = new WebSocket(this.wsUrl);

      this.ws.on('open', () => {
        console.info('[FFXIVCombatLogWatcher] WebSocket connected');
        this.subscribe();
      });

      this.ws.on('message', (data: WebSocket.Data) => {
        this.handleMessage(data);
      });

      this.ws.on('close', () => {
        console.info('[FFXIVCombatLogWatcher] WebSocket closed');
        this.scheduleReconnect();
      });

      this.ws.on('error', (error: Error) => {
        console.error(
          '[FFXIVCombatLogWatcher] WebSocket error:',
          error.message,
        );
        // The 'close' event will fire after this, triggering reconnect
      });
    } catch (error) {
      console.error(
        '[FFXIVCombatLogWatcher] Failed to create WebSocket:',
        error,
      );
      this.scheduleReconnect();
    }
  }

  /**
   * Subscribe to LogLine events after connection is established.
   */
  private subscribe() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn(
        '[FFXIVCombatLogWatcher] Cannot subscribe, WebSocket not open',
      );
      return;
    }

    // Subscribe to LogLine events and Cactbot state events
    const subscribeMessage = JSON.stringify({
      call: 'subscribe',
      events: ['LogLine', 'onZoneChangedEvent', 'onInCombatChangedEvent', 'onPlayerChangedEvent', 'PartyChanged'],
    });

    console.debug('[FFXIVCombatLogWatcher] Sending subscribe message');
    this.ws.send(subscribeMessage);

    // Request current state from Cactbot - this triggers resending of
    // onZoneChangedEvent and onInCombatChangedEvent with current values
    const requestStateMessage = JSON.stringify({
      call: 'cactbotRequestState',
    });
    console.debug('[FFXIVCombatLogWatcher] Requesting current state');
    this.ws.send(requestStateMessage);
  }

  /**
   * Schedule a reconnection attempt.
   */
  private scheduleReconnect() {
    if (!this.shouldBeWatching || !this.reconnectEnabled) {
      return;
    }

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }

    console.info(
      `[FFXIVCombatLogWatcher] Scheduling reconnect in ${this.reconnectInterval / 1000}s`,
    );

    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, this.reconnectInterval);
  }

  /**
   * Handle incoming WebSocket messages.
   */
  private handleMessage(data: WebSocket.Data) {
    try {
      const message: WebSocketMessage = JSON.parse(data.toString());

      if (message.type === 'LogLine' && message.rawLine) {
        this.handleLogLine(message.rawLine);
        this.updateGameState(message.rawLine);
        this.resetTimeout();
      } else if (message.type === 'onZoneChangedEvent' && message.detail) {
        // Cactbot zone change event - update our state
        const zoneName = message.detail.zoneName as string;
        console.info(
          '[FFXIVCombatLogWatcher] Received zone change event:',
          zoneName,
        );
        this.gameState.zoneName = zoneName || null;
        this.gameState.timestamp = new Date();
        // Emit the zone change so FFXIVLogHandler can handle it
        this.emit('cactbotZoneChange', zoneName);
      } else if (message.type === 'onInCombatChangedEvent' && message.detail) {
        // Cactbot combat state event - update our state
        const inGameCombat = message.detail.inGameCombat as boolean;
        console.info(
          '[FFXIVCombatLogWatcher] Received combat change event:',
          inGameCombat,
        );
        this.gameState.inCombat = inGameCombat;
        this.gameState.timestamp = new Date();
      } else if (message.type === 'onPlayerChangedEvent' && message.detail) {
        const rawId = message.detail.id as number;
        const playerId = rawId ? rawId.toString(16).toUpperCase() : '';
        if (playerId && !this.gameState.playerId) {
          console.info(
            '[FFXIVCombatLogWatcher] Received player changed event, id:',
            playerId,
          );
          this.gameState.playerId = playerId;
          this.emit('cactbotPlayerChange', playerId);
        }
      } else if (message.type === 'PartyChanged') {
        const party = (message as unknown as { party: PartyMember[] }).party;
        if (party) {
          console.info(
            '[FFXIVCombatLogWatcher] Received party changed event, members:',
            party.length,
          );
          this.emit('partyChanged', party);
        }
      }
    } catch (error) {
      console.debug('[FFXIVCombatLogWatcher] Failed to parse message:', error);
    }
  }

  /**
   * Update the cached game state based on log lines.
   */
  private updateGameState(line: string) {
    try {
      const logLine = new FFXIVLogLine(line);
      const logType = logLine.type();

      if (logType === LogType.CHANGE_PRIMARY_PLAYER) {
        this.gameState.playerId = logLine.arg(2) || null;
      }

      if (logType === LogType.IN_COMBAT) {
        this.gameState.inCombat = logLine.arg(3) === '1';
        this.gameState.timestamp = logLine.date();
      }

      if (logType === LogType.CONTENT_FINDER_SETTINGS) {
        this.gameState.zoneId = parseInt(logLine.arg(2), 16) || null;
        this.gameState.zoneName = logLine.arg(3) || null;
        this.gameState.inContentFinderContent = logLine.arg(4) === 'True';
        this.gameState.timestamp = logLine.date();
      }
    } catch {
      // Skip malformed lines
    }
  }

  /**
   * Stop watching and close the WebSocket connection.
   */
  public async unwatch() {
    console.info('[FFXIVCombatLogWatcher] Unwatching');
    this.shouldBeWatching = false;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }

    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }

    if (this.ws) {
      this.ws.close();
      this.ws = undefined;
    }
  }

  /**
   * Get the current game state. This is tracked in real-time from WebSocket
   * messages instead of reading from log files.
   */
  public async getCurrentGameState(): Promise<FFXIVGameState> {
    return this.gameState;
  }

  /**
   * Handle a line from the log. Public as this is called by the test button.
   */
  public handleLogLine(line: string) {
    const logLine = new FFXIVLogLine(line);
    const logEventType = logLine.type();
    this.emit(logEventType, logLine);
  }

  /**
   * Sends a timeout event signalling no activity in the WebSocket
   * for the timeout period. That's handy as a catch-all for ending any active
   * events.
   */
  private resetTimeout() {
    if (this.timer) {
      clearTimeout(this.timer);
    }

    this.timer = setTimeout(() => {
      this.emit('timeout', this.timeout);
    }, this.timeout);
  }
}
