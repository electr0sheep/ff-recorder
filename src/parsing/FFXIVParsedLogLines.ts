import { Job, LogType } from 'main/FFXIVTypes';
import FFXIVLogLine from './FFXIVLogLine';

/**
 * Base class for all parsed FFXIV log lines.
 * Provides common functionality and access to the underlying raw line.
 */
export abstract class FFXIVParsedLogLine {
  /** The raw log line for fallback access */
  protected readonly raw: FFXIVLogLine;

  /** The log type identifier */
  abstract readonly logType: LogType;

  /** The timestamp from the log line */
  readonly timestamp: Date;

  constructor(line: FFXIVLogLine) {
    this.raw = line;
    this.timestamp = line.date();
  }

  /** Access the underlying raw line for fields not parsed by this class */
  get rawLine(): FFXIVLogLine {
    return this.raw;
  }
}

/**
 * TYPE 00: LOG_LINE
 * Chat messages and general game log messages.
 *
 * Format: 00|[timestamp]|[channelId]|[sourceName]|[message]|[hash]
 */
export class LogLineLine extends FFXIVParsedLogLine {
  readonly logType = LogType.LOG_LINE;

  /** Chat channel code (hex, 4 characters) */
  readonly channelId: string;

  /** Source of the message (can be empty) */
  readonly sourceName: string;

  /** The message content */
  readonly message: string;

  constructor(line: FFXIVLogLine) {
    super(line);
    this.channelId = line.arg(2);
    this.sourceName = line.arg(3);
    this.message = line.arg(4);
  }

  /** Check if this is a completion/ending message */
  isCompletionMessage(): boolean {
    return (
      this.message.includes('completion time') ||
      this.message.includes('has ended')
    );
  }

  /** Check if this is a dungeon-related chat channel */
  isDungeonChannel(): boolean {
    return ['0840', '0839'].includes(this.channelId);
  }
}

/**
 * TYPE 02: CHANGE_PRIMARY_PLAYER
 * Player character selection/identification.
 *
 * Format: 02|[timestamp]|[playerId]|[playerName]|[hash]
 */
export class ChangePrimaryPlayerLine extends FFXIVParsedLogLine {
  readonly logType = LogType.CHANGE_PRIMARY_PLAYER;

  /** Player's actor ID (hex, 8 characters) */
  readonly playerId: string;

  /** Character name */
  readonly playerName: string;

  constructor(line: FFXIVLogLine) {
    super(line);
    this.playerId = line.arg(2);
    this.playerName = line.arg(3);
  }
}

/**
 * TYPE 03: ADD_COMBATANT
 * Combatant added to memory (player, enemy, NPC, etc.)
 *
 * Format: 03|[timestamp]|[actorId]|[name]|[job]|[level]|[ownerId]|[worldId]|[world]|[npcNameId]|[npcBaseId]|[currentHp]|[maxHp]|[currentMp]|[maxMp]|[tp]|[tpMax]|[posX]|[posY]|[posZ]|[heading]|[hash]
 */
export class AddCombatantLine extends FFXIVParsedLogLine {
  readonly logType = LogType.ADD_COMBATANT;

  /** Actor's unique ID (hex, 8 characters) */
  readonly actorId: string;

  /** Character/NPC name */
  readonly name: string;

  /** Job/class ID */
  readonly job: Job;

  /** Character level */
  readonly level: number;

  /** Owner ID for pets (hex, 4 characters) */
  readonly ownerId: string;

  /** World/server ID (hex) */
  readonly worldId: string;

  /** World name */
  readonly world: string;

  /** NPC name ID */
  readonly npcNameId: number;

  /** NPC base ID - used to identify specific NPCs/bosses */
  readonly npcBaseId: number;

  /** Current HP */
  readonly currentHp: number;

  /** Maximum HP */
  readonly maxHp: number;

  /** Current MP */
  readonly currentMp: number;

  /** Maximum MP */
  readonly maxMp: number;

  /** X coordinate */
  readonly posX: number;

  /** Y coordinate */
  readonly posY: number;

  /** Z coordinate */
  readonly posZ: number;

  /** Facing direction in radians */
  readonly heading: number;

  constructor(line: FFXIVLogLine) {
    super(line);
    this.actorId = line.arg(2);
    this.name = line.arg(3);
    this.job = line.arg(4) as Job;
    this.level = parseInt(line.arg(5), 10) || 0;
    this.ownerId = line.arg(6);
    this.worldId = line.arg(7);
    this.world = line.arg(8);
    this.npcNameId = parseInt(line.arg(9), 10) || 0;
    this.npcBaseId = parseInt(line.arg(10), 10) || 0;
    this.currentHp = parseInt(line.arg(11), 10) || 0;
    this.maxHp = parseInt(line.arg(12), 10) || 0;
    this.currentMp = parseInt(line.arg(13), 10) || 0;
    this.maxMp = parseInt(line.arg(14), 10) || 0;
    // Args 15-16 are TP (legacy, usually 0)
    this.posX = parseFloat(line.arg(17)) || 0;
    this.posY = parseFloat(line.arg(18)) || 0;
    this.posZ = parseFloat(line.arg(19)) || 0;
    this.heading = parseFloat(line.arg(20)) || 0;
  }

  /** Check if this combatant is a player (has a job and home world) */
  isPlayer(): boolean {
    return (
      this.job !== Job.None &&
      this.world.length > 0 &&
      this.actorId.startsWith('10')
    );
  }

  /** Check if this combatant is an NPC/enemy (no job or no home world) */
  isNPC(): boolean {
    return !this.isPlayer();
  }
}

/**
 * TYPE 25: NETWORK_DEATH
 * Actor death.
 *
 * Format: 25|[timestamp]|[targetId]|[targetName]|[sourceId]|[sourceName]|[hash]
 */
export class DeathLine extends FFXIVParsedLogLine {
  readonly logType = LogType.DEATH;

  /** Dead actor's ID (hex, 8 characters) */
  readonly targetId: string;

  /** Dead actor's name */
  readonly targetName: string;

  /** Killer's actor ID (hex, 8 characters) */
  readonly sourceId: string;

  /** Killer's name */
  readonly sourceName: string;

  constructor(line: FFXIVLogLine) {
    super(line);
    this.targetId = line.arg(2);
    this.targetName = line.arg(3);
    this.sourceId = line.arg(4);
    this.sourceName = line.arg(5);
  }
}

/**
 * TYPE 260: IN_COMBAT
 * Combat state change notification.
 *
 * Format: 260|[timestamp]|[inACTCombat]|[inGameCombat]|[isACTChanged]|[isGameChanged]|[hash]
 */
export class InCombatLine extends FFXIVParsedLogLine {
  readonly logType = LogType.IN_COMBAT;

  /** Whether ACT considers player in combat */
  readonly inACTCombat: boolean;

  /** Whether game considers player in combat */
  readonly inGameCombat: boolean;

  /** Whether ACT combat state changed this update */
  readonly isACTChanged: boolean;

  /** Whether game combat state changed this update */
  readonly isGameChanged: boolean;

  constructor(line: FFXIVLogLine) {
    super(line);
    this.inACTCombat = line.arg(2) === '1';
    this.inGameCombat = line.arg(3) === '1';
    this.isACTChanged = line.arg(4) === '1';
    this.isGameChanged = line.arg(5) === '1';
  }
}

/**
 * TYPE 265: CONTENT_FINDER_SETTINGS
 * Current content finder settings (dungeon/raid flags).
 *
 * Format: 265|[timestamp]|[zoneID]|[zoneName]|[inContentFinderContent]|[unrestrictedParty]|[minimalItemLevel]|[silenceEcho]|[explorerMode]|[levelSync]|[hash]
 */
export class ContentFinderSettingsLine extends FFXIVParsedLogLine {
  readonly logType = LogType.CONTENT_FINDER_SETTINGS;

  /** Territory/Zone ID (parsed from hex) */
  readonly zoneId: number;

  /** Zone name */
  readonly zoneName: string;

  /** Whether in ContentFinder content */
  readonly inContentFinderContent: boolean;

  /** Whether unrestricted party is enabled */
  readonly unrestrictedParty: boolean;

  /** Whether minimal item level is enabled */
  readonly minimalItemLevel: boolean;

  /** Whether silence echo is enabled */
  readonly silenceEcho: boolean;

  /** Whether explorer mode is enabled */
  readonly explorerMode: boolean;

  /** Whether level sync is enabled */
  readonly levelSync: boolean;

  constructor(line: FFXIVLogLine) {
    super(line);
    this.zoneId = parseInt(line.arg(2), 16) || 0;
    this.zoneName = line.arg(3);
    // inContentFinderContent uses "True"/"False" strings
    this.inContentFinderContent = line.arg(4) === 'True';
    // The rest use "1"/"0"
    this.unrestrictedParty = line.arg(5) === '1';
    this.minimalItemLevel = line.arg(6) === '1';
    this.silenceEcho = line.arg(7) === '1';
    this.explorerMode = line.arg(8) === '1';
    this.levelSync = line.arg(9) === '1';
  }
}

/**
 * TYPE 26: BUFF (StatusAdd)
 * A status effect is applied to an actor.
 *
 * Format: 26|[timestamp]|[statusId]|[statusName]|[duration]|[sourceId]|[sourceName]|[targetId]|[targetName]|[stacks]|[targetMaxHp]|...
 */
export class BuffLine extends FFXIVParsedLogLine {
  readonly logType = LogType.BUFF;

  readonly statusId: string;
  readonly statusName: string;
  readonly duration: number;
  readonly sourceId: string;
  readonly sourceName: string;
  readonly targetId: string;
  readonly targetName: string;

  constructor(line: FFXIVLogLine) {
    super(line);
    this.statusId = line.arg(2);
    this.statusName = line.arg(3);
    this.duration = parseFloat(line.arg(4)) || 0;
    this.sourceId = line.arg(5);
    this.sourceName = line.arg(6);
    this.targetId = line.arg(7);
    this.targetName = line.arg(8);
  }

  isTranscendent(): boolean {
    return this.statusId === '1A2';
  }
}

/**
 * TYPE 39: UPDATE_HP
 * HP update for a combatant.
 *
 * Format: 39|[timestamp]|[id]|[name]|[currentHp]|[maxHp]|...
 */
export class UpdateHpLine extends FFXIVParsedLogLine {
  readonly logType = LogType.UPDATE_HP;

  readonly targetId: string;
  readonly targetName: string;
  readonly currentHp: number;
  readonly maxHp: number;

  constructor(line: FFXIVLogLine) {
    super(line);
    this.targetId = line.arg(2);
    this.targetName = line.arg(3);
    this.currentHp = parseInt(line.arg(4), 10);
    this.maxHp = parseInt(line.arg(5), 10);
  }
}

export type ParsedLogLine =
  | LogLineLine
  | ChangePrimaryPlayerLine
  | AddCombatantLine
  | DeathLine
  | InCombatLine
  | ContentFinderSettingsLine
  | UpdateHpLine;

/**
 * Factory function to parse a raw log line into the appropriate typed class.
 * Returns undefined if the log type is not supported.
 */
export function parseLogLine(line: FFXIVLogLine): ParsedLogLine | undefined {
  const type = line.type();

  switch (type) {
    case LogType.LOG_LINE:
      return new LogLineLine(line);
    case LogType.CHANGE_PRIMARY_PLAYER:
      return new ChangePrimaryPlayerLine(line);
    case LogType.ADD_COMBATANT:
      return new AddCombatantLine(line);
    case LogType.DEATH:
      return new DeathLine(line);
    case LogType.IN_COMBAT:
      return new InCombatLine(line);
    case LogType.CONTENT_FINDER_SETTINGS:
      return new ContentFinderSettingsLine(line);
    default:
      return undefined;
  }
}

/**
 * Type guard to check if a parsed line is a specific type
 */
export function isLogLineType<T extends ParsedLogLine>(
  line: ParsedLogLine | undefined,
  logType: LogType,
): line is T {
  return line?.logType === logType;
}
