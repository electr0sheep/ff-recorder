import FFXIVGenericLogHandler from './FFXIVGenericLogHandler';
import FFXIVLogLine from './FFXIVLogLine';
import {
  ContentFinderSettingsLine,
  AddCombatantLine,
  RemoveCombatantLine,
  ChangePrimaryPlayerLine,
  LogLineLine,
  DeathLine,
  InCombatLine,
  UpdateHpLine,
  DirectorLine,
} from './FFXIVParsedLogLines';
import Combatant from 'main/Combatant';
import { zones, BNpcNameIdToNameMap } from 'main/FFXIVConstants';
import Activity from 'activitys/Activity';
import { LogType, ContentType, Zone, Difficulty, Job } from 'main/FFXIVTypes';
import FFXIVDungeon from 'activitys/FFXIVDungeon';
import { PlayerDeathType } from 'main/types';
import { DungeonTimelineSegment, TimelineSegmentType } from 'main/keystone';
import { VideoCategory } from 'types/VideoCategory';
import FFXIVBossEncounter from 'activitys/FFXIVBossEncounter';
import { PartyMember } from './FFXIVCombatLogWatcher';

/**
 * How a territory gets recorded.
 */
enum RecordMode {
  /** Not recorded. */
  None,

  /** The whole duty is one video: dungeons and deep dungeons. */
  Run,

  /**
   * Each pull is a video, delimited by the in-game combat flag and the duty
   * director: trials, raids (including ultimates) and chaotic alliance raids.
   */
  Combat,

  /**
   * Each boss is a video, delimited by the arena being sealed off: alliance
   * raids, variant and criterion dungeons, which all have trash in between.
   */
  Sealed,
}

/**
 * A boss actor we've seen spawn in the current duty. Bosses spawn with a
 * pile of helper actors sharing their name, so every actor is tracked and
 * the living one with the most HP is treated as the real boss.
 */
type BossActor = {
  id: string;
  nameId: number;
  name: string;
  maxHp: number;
  dead: boolean;
};

/**
 * How long to wait after a combat drop before treating it as the end of a
 * pull. The director and chat lines that carry the result arrive slightly
 * before the combat flag drops, and this also rides out brief drops.
 */
const COMBAT_END_GRACE_MS = 5000;

/**
 * FFXIVLogHandler class. Turns the IINACT log stream into activities.
 */
export default class FFXIVLogHandler extends FFXIVGenericLogHandler {
  private currentZone: Zone | undefined;

  private mode = RecordMode.None;

  /** Party members, keyed by actor ID. */
  private currentCombatants = new Map<string, Combatant>();

  private playerGUID: string | undefined;

  private playerName: string | undefined;

  private currentPull = 0;

  /** Boss actors seen in the current duty, keyed by actor ID. */
  private bossActors = new Map<string, BossActor>();

  /** The actor we consider the real boss, see BossActor. */
  private primaryBoss: BossActor | undefined;

  private bossKilledThisPull = false;

  /** A pull end waiting out the grace period, see COMBAT_END_GRACE_MS. */
  private pendingEnd: { timer: NodeJS.Timeout; timestamp: Date } | undefined;

  /** Last combat state reported by Cactbot, used for recovery on connect. */
  private cactbotInCombat = false;

  /** Every boss name we know, for matching deaths of actors we never saw spawn. */
  private static bossNames = new Set(Array.from(BNpcNameIdToNameMap.values()));

  constructor(wsUrl: string) {
    super(wsUrl, 10);

    this.onLine(LogType.CONTENT_FINDER_SETTINGS, (line) =>
      this.handleContentFinderSettings(line),
    );

    this.onLine(LogType.ADD_COMBATANT, (line) => this.handleAddCombatant(line));

    this.onLine(LogType.REMOVE_COMBATANT, (line) =>
      this.handleRemoveCombatant(line),
    );

    this.onLine(LogType.CHANGE_PRIMARY_PLAYER, (line) =>
      this.handlePlayer(line),
    );

    this.onLine(LogType.LOG_LINE, (line) => this.handleChat(line));
    this.onLine(LogType.DEATH, (line) => this.handleDeath(line));
    this.onLine(LogType.IN_COMBAT, (line) => this.handleInCombat(line));
    this.onLine(LogType.UPDATE_HP, (line) => this.handleUpdateHp(line));
    this.onLine(LogType.DIRECTOR, (line) => this.handleDirector(line));

    // Cactbot state events. These are re-sent when we connect (in response
    // to cactbotRequestState), which is how we pick up a duty that is
    // already in progress when the app or IINACT starts.
    this.combatLogWatcher.on('cactbotZoneChange', (zoneName: string) => {
      this.handleCactbotZoneChange(zoneName).catch((error) =>
        console.error('[FFXIVLogHandler] Cactbot zone change failed', error),
      );
    });

    this.combatLogWatcher.on('cactbotCombatChange', (inCombat: boolean) => {
      this.handleCactbotCombatChange(inCombat).catch((error) =>
        console.error('[FFXIVLogHandler] Cactbot combat change failed', error),
      );
    });

    this.combatLogWatcher.on(
      'cactbotPlayerChange',
      (playerId: string, playerName?: string) => {
        this.setPlayer(playerId, playerName);
      },
    );

    this.combatLogWatcher.on('partyChanged', (party: PartyMember[]) => {
      this.handlePartyChanged(party);
    });
  }

  public destroy() {
    this.clearPendingEnd();
    super.destroy();
  }

  /**
   * Subscribe to a log line type. The watcher doesn't await listeners, so
   * errors have to be caught here or they vanish as unhandled rejections.
   */
  private onLine(
    type: LogType,
    handler: (line: FFXIVLogLine) => void | Promise<void>,
  ) {
    this.combatLogWatcher.on(type, async (line: FFXIVLogLine) => {
      try {
        await handler(line);
      } catch (error) {
        console.error(
          `[FFXIVLogHandler] Error handling log type ${type}:`,
          error,
          line.original,
        );
      }
    });
  }

  /**
   * Zone changes arrive as a 265 line from IINACT, with the zone ID.
   * Anything not in the zone table is treated as leaving duty content.
   */
  private async handleContentFinderSettings(line: FFXIVLogLine) {
    const parsed = new ContentFinderSettingsLine(line);
    const territory = zones.find((zone) => zone.id === parsed.zoneId);

    if (!territory) {
      console.info(
        '[FFXIVLogHandler] Not a recorded territory:',
        parsed.zoneName,
      );

      await this.leaveTerritory(parsed.timestamp);
      return;
    }

    await this.enterTerritory(territory, parsed.timestamp);
  }

  /**
   * Cactbot zone events only carry the name, and a 265 line follows them
   * during normal play anyway, so this only matters when we don't know the
   * zone yet, i.e. we connected while a duty was in progress.
   */
  private async handleCactbotZoneChange(zoneName: string) {
    if (this.currentZone) {
      return;
    }

    const normalizedName = zoneName.toLowerCase();

    const territory = zones.find(
      (zone) =>
        zone.rawName.toLowerCase() === normalizedName ||
        zone.name.toLowerCase() === normalizedName,
    );

    if (!territory) {
      console.debug('[FFXIVLogHandler] No recorded territory named:', zoneName);
      return;
    }

    console.info('[FFXIVLogHandler] Cactbot zone matched:', territory.name);
    await this.enterTerritory(territory, new Date());

    // If Cactbot already told us we're in combat, we've joined mid-pull.
    if (this.cactbotInCombat) {
      await this.handleCombatChange(true, new Date());
    }
  }

  private async enterTerritory(territory: Zone, timestamp: Date) {
    if (this.currentZone?.id === territory.id) {
      // Duplicate zone info, e.g. the 265 line following a Cactbot event, or
      // IINACT re-emitting the zone on start. Nothing to do.
      return;
    }

    if (FFXIVGenericLogHandler.activity) {
      // Moving straight between two recorded territories, e.g. deep dungeon
      // floor sets. Close out the current video first.
      console.info('[FFXIVLogHandler] New territory mid-activity, ending it');
      await this.endRecording(timestamp, true);
    }

    this.resetPullState();
    this.currentZone = territory;
    this.mode = FFXIVLogHandler.getRecordMode(territory);

    console.info(
      '[FFXIVLogHandler] Entered',
      territory.name,
      'type:',
      ContentType[territory.type],
      'mode:',
      RecordMode[this.mode],
    );

    if (this.mode === RecordMode.Run) {
      await this.startRun(territory, timestamp);
    }
  }

  private async leaveTerritory(timestamp: Date) {
    if (FFXIVGenericLogHandler.activity) {
      // Nothing signalled a completion before we left, so whatever was in
      // progress is a wipe or an abandon.
      console.info('[FFXIVLogHandler] Left territory mid-activity, ending it');
      await this.endRecording(timestamp, false);
    }

    this.resetPullState();
    this.currentZone = undefined;
    this.mode = RecordMode.None;

    // The party gets re-sent by IINACT, but keep ourselves around so a solo
    // player is never missing from the combatants.
    const self = this.playerGUID
      ? this.currentCombatants.get(this.playerGUID)
      : undefined;

    this.currentCombatants.clear();

    if (self) {
      this.currentCombatants.set(self.GUID, self);
    }
  }

  private resetPullState() {
    this.clearPendingEnd();
    this.currentPull = 0;
    this.bossActors.clear();
    this.primaryBoss = undefined;
    this.bossKilledThisPull = false;
  }

  private static getRecordMode(zone: Zone): RecordMode {
    if (zone.difficulty === Difficulty.Chaotic) {
      // A single boss that resets on a wipe, so it behaves like a raid.
      return RecordMode.Combat;
    }

    switch (zone.type) {
      case ContentType.Trial:
      case ContentType.Raid:
        return RecordMode.Combat;
      case ContentType['Alliance Raid']:
      case ContentType['Variant Dungeon']:
      case ContentType['Criterion Dungeon']:
        return RecordMode.Sealed;
      case ContentType.Dungeon:
      case ContentType['Deep Dungeon']:
        return RecordMode.Run;
      default:
        return RecordMode.None;
    }
  }

  private static getCategory(zone: Zone): VideoCategory | undefined {
    if (zone.difficulty === Difficulty.Chaotic) {
      return VideoCategory.FFXIVAllianceRaids;
    }

    switch (zone.type) {
      case ContentType.Trial:
        return VideoCategory.FFXIVTrials;
      case ContentType.Raid:
        return VideoCategory.FFXIVRaids;
      case ContentType['Alliance Raid']:
        return VideoCategory.FFXIVAllianceRaids;
      case ContentType['Variant Dungeon']:
        return VideoCategory.FFXIVVariantDungeons;
      case ContentType['Criterion Dungeon']:
        return VideoCategory.FFXIVCriterionDungeons;
      case ContentType.Dungeon:
        return VideoCategory.FFXIVDungeons;
      case ContentType['Deep Dungeon']:
        return VideoCategory.FFXIVDeepDungeons;
      default:
        return undefined;
    }
  }

  /**
   * Start recording a whole run (dungeons, deep dungeons).
   */
  private async startRun(territory: Zone, timestamp: Date) {
    const category = FFXIVLogHandler.getCategory(territory);

    if (!category) {
      return;
    }

    const activity = new FFXIVDungeon(
      timestamp,
      territory.name,
      territory.difficulty,
      category,
    );

    const segment = new DungeonTimelineSegment(
      TimelineSegmentType.Trash,
      timestamp,
      0,
    );

    activity.addTimelineSegment(segment);
    await this.startRecording(activity);
  }

  /**
   * Start recording a boss pull (everything that isn't a whole run).
   */
  private async startPull(timestamp: Date) {
    if (!this.currentZone) {
      return;
    }

    if (FFXIVGenericLogHandler.activity) {
      // Already recording this pull. Common, as the combat flag arrives from
      // both the 260 line and Cactbot.
      return;
    }

    const category = FFXIVLogHandler.getCategory(this.currentZone);

    if (!category) {
      return;
    }

    this.currentPull += 1;
    this.bossKilledThisPull = false;

    const bossName = this.primaryBoss
      ? this.primaryBoss.name
      : this.currentZone.name;

    const activity = new FFXIVBossEncounter(
      timestamp,
      this.currentZone.name,
      bossName,
      this.currentZone.difficulty ?? Difficulty.Normal,
      category,
    );

    activity.pull = this.currentPull;

    // Cut back a few seconds into the buffer to catch the start of the pull.
    await this.startRecording(activity, 3);
  }

  private async startRecording(activity: Activity, offset = 0) {
    activity.playerGUID = this.playerGUID;

    this.currentCombatants.forEach((combatant) => {
      activity.addCombatant(combatant);
    });

    // The party list from IINACT can be empty when solo, and the metadata
    // needs the player to be a combatant, so always add ourselves.
    if (this.playerGUID && !activity.getCombatant(this.playerGUID)) {
      const self = new Combatant(this.playerGUID);
      self.name = this.playerName;
      activity.addCombatant(self);
    }

    await FFXIVGenericLogHandler.startActivity(activity, offset);
  }

  /**
   * End the current activity, if any. Every FFXIV activity end goes through
   * here so the pending end and timeline segment get tidied up.
   */
  private async endRecording(timestamp: Date, success: boolean) {
    this.clearPendingEnd();
    const activity = FFXIVGenericLogHandler.activity;

    if (!activity) {
      return;
    }

    if (activity.category === VideoCategory.Manual) {
      // Manual recordings are started and stopped by the hotkey only; zone
      // changes and duty events must not touch them.
      console.info('[FFXIVLogHandler] Leaving manual recording running');
      return;
    }

    if (activity instanceof FFXIVDungeon) {
      activity.endCurrentTimelineSegment(timestamp);
    }

    console.info(
      '[FFXIVLogHandler] Ending activity, success:',
      success,
      'category:',
      activity.category,
    );

    activity.end(timestamp, success);
    await FFXIVGenericLogHandler.endActivity();
  }

  /**
   * End the current pull after the grace period, unless something more
   * definitive ends it first. The end date is the time of the signal, not
   * the end of the grace period.
   */
  private schedulePullEnd(timestamp: Date, success: boolean) {
    if (!FFXIVGenericLogHandler.activity) {
      return;
    }

    this.clearPendingEnd();

    const timer = setTimeout(() => {
      this.pendingEnd = undefined;

      this.endRecording(timestamp, success).catch((error) =>
        console.error('[FFXIVLogHandler] Failed to end pull', error),
      );
    }, COMBAT_END_GRACE_MS);

    this.pendingEnd = { timer, timestamp };
  }

  private clearPendingEnd() {
    if (this.pendingEnd) {
      clearTimeout(this.pendingEnd.timer);
      this.pendingEnd = undefined;
    }
  }

  private async handleInCombat(line: FFXIVLogLine) {
    const parsed = new InCombatLine(line);

    // IINACT writes a 260 line whenever either ACT's or the game's idea of
    // combat changes. Only the game's flag means anything here; acting on
    // the ACT flips is what used to start pulls twice.
    if (!parsed.isGameChanged) {
      return;
    }

    await this.handleCombatChange(parsed.inGameCombat, parsed.timestamp);
  }

  /**
   * Cactbot mirrors the game's combat flag, so during normal play this just
   * duplicates the 260 line harmlessly. It matters on connect, when Cactbot
   * re-sends the current state and there is no 260 line to go on. It can
   * arrive before the zone event, hence the flag.
   */
  private async handleCactbotCombatChange(inCombat: boolean) {
    // Cactbot also fires this when ACT's own combat flag changes, so ignore
    // repeats of the game flag or they would keep re-arming the pull end.
    if (inCombat === this.cactbotInCombat) {
      return;
    }

    this.cactbotInCombat = inCombat;
    await this.handleCombatChange(inCombat, new Date());
  }

  private async handleCombatChange(inCombat: boolean, timestamp: Date) {
    if (this.mode !== RecordMode.Combat) {
      // Runs record throughout, sealed content keys off the arena seal.
      return;
    }

    if (inCombat) {
      // Either a new pull, or combat resuming after a brief drop, in which
      // case the pending end is cancelled and the recording carries on.
      this.clearPendingEnd();
      await this.startPull(timestamp);
      return;
    }

    // Combat dropped. If a director or chat line hasn't already ended the
    // pull by the time the grace period is up, all we know is whether the
    // boss died.
    this.schedulePullEnd(timestamp, this.bossKilledThisPull);
  }

  private async handleChat(line: FFXIVLogLine) {
    const parsed = new LogLineLine(line);

    if (!parsed.isDutyChannel()) {
      return;
    }

    if (parsed.isCompletionMessage()) {
      await this.handleDutyComplete(parsed.timestamp);
    } else if (parsed.isArenaSealed()) {
      await this.handleArenaSealed(parsed.timestamp);
    } else if (parsed.isArenaUnsealed()) {
      await this.handleArenaUnsealed(parsed.timestamp);
    }
  }

  /**
   * Duty director lines. See DirectorLine for what the commands mean.
   */
  private async handleDirector(line: FFXIVLogLine) {
    const parsed = new DirectorLine(line);

    if (parsed.isDutyComplete()) {
      await this.handleDutyComplete(parsed.timestamp);
    }
  }

  /**
   * The duty is complete. This arrives as both a director line and a chat
   * line; whichever gets here first ends the activity, the other is a no-op.
   */
  private async handleDutyComplete(timestamp: Date) {
    if (!FFXIVGenericLogHandler.activity) {
      return;
    }

    console.info('[FFXIVLogHandler] Duty complete');
    await this.endRecording(timestamp, true);
  }

  /**
   * A boss arena was sealed off, so a boss fight is starting. For sealed
   * content that's the start of a pull, for a run it's a boss segment.
   */
  private async handleArenaSealed(timestamp: Date) {
    if (this.mode === RecordMode.Sealed) {
      await this.startPull(timestamp);
      return;
    }

    const activity = FFXIVGenericLogHandler.activity;

    if (this.mode === RecordMode.Run && activity instanceof FFXIVDungeon) {
      const segment = new DungeonTimelineSegment(
        TimelineSegmentType.BossEncounter,
        timestamp,
        this.getRelativeTimestamp(timestamp),
        undefined,
        this.primaryBoss?.name,
      );

      activity.addTimelineSegment(segment, timestamp);
    }
  }

  /**
   * A boss arena was unsealed, so the fight is over one way or the other.
   * The arena unseals both when the boss dies and when the party is
   * defeated; the boss death line is what tells them apart.
   */
  private async handleArenaUnsealed(timestamp: Date) {
    if (this.mode === RecordMode.Sealed) {
      // Don't decide the result yet: the boss death line can trail the
      // unseal by a couple of seconds (the unseal itself trails a party
      // wipe), so wait out the grace period and let a boss death upgrade it
      // to a kill. Prefer the boss death time if we already have it.
      const endDate = this.pendingEnd?.timestamp ?? timestamp;
      this.schedulePullEnd(endDate, this.bossKilledThisPull);
      return;
    }

    const activity = FFXIVGenericLogHandler.activity;

    if (this.mode === RecordMode.Run && activity instanceof FFXIVDungeon) {
      const segment = new DungeonTimelineSegment(
        TimelineSegmentType.Trash,
        timestamp,
        this.getRelativeTimestamp(timestamp),
      );

      activity.addTimelineSegment(segment, timestamp);
    }
  }

  private async handleAddCombatant(line: FFXIVLogLine) {
    if (!this.currentZone || this.mode === RecordMode.None) {
      return;
    }

    const parsed = new AddCombatantLine(line);

    if (parsed.isPlayer()) {
      if (this.currentCombatants.has(parsed.actorId)) {
        return;
      }

      const combatant = new Combatant(parsed.actorId);
      combatant.name = parsed.name;
      combatant.job = parsed.job;
      this.currentCombatants.set(parsed.actorId, combatant);

      if (FFXIVGenericLogHandler.activity) {
        FFXIVGenericLogHandler.activity.addCombatant(combatant);
      }

      return;
    }

    const bossName = BNpcNameIdToNameMap.get(parsed.npcNameId);

    if (bossName === undefined) {
      return;
    }

    this.bossActors.set(parsed.actorId, {
      id: parsed.actorId,
      nameId: parsed.npcNameId,
      name: bossName,
      maxHp: parsed.maxHp,
      dead: false,
    });

    this.refreshPrimaryBoss();
  }

  private handleRemoveCombatant(line: FFXIVLogLine) {
    const parsed = new RemoveCombatantLine(line);

    if (this.bossActors.delete(parsed.actorId)) {
      this.refreshPrimaryBoss();
    }
  }

  /**
   * Pick the real boss out of the boss actors: the living one with the most
   * HP, preferring the most recently spawned on a tie, as bosses respawn
   * with a new actor ID after a wipe.
   */
  private refreshPrimaryBoss() {
    let primary: BossActor | undefined;

    for (const actor of Array.from(this.bossActors.values())) {
      if (!actor.dead && (!primary || actor.maxHp >= primary.maxHp)) {
        primary = actor;
      }
    }

    if (primary?.id !== this.primaryBoss?.id) {
      this.primaryBoss = primary;

      if (primary) {
        console.info(
          '[FFXIVLogHandler] Boss:',
          primary.name,
          primary.id,
          'max HP:',
          primary.maxHp,
        );
      }
    }

    // If the pull started before the boss spawned, fix up the name.
    const activity = FFXIVGenericLogHandler.activity;

    if (
      primary &&
      this.currentZone &&
      activity instanceof FFXIVBossEncounter &&
      activity.bossName === this.currentZone.name
    ) {
      activity.bossName = primary.name;
    }
  }

  private async handlePlayer(line: FFXIVLogLine) {
    const parsed = new ChangePrimaryPlayerLine(line);
    this.setPlayer(parsed.playerId, parsed.playerName);
  }

  private setPlayer(playerId: string, playerName?: string) {
    if (this.playerGUID !== playerId) {
      console.info('[FFXIVLogHandler] Player is', playerId, playerName ?? '');
    }

    this.playerGUID = playerId;

    if (playerName) {
      this.playerName = playerName;
    }

    const activity = FFXIVGenericLogHandler.activity;

    // If we learn who we are mid-activity (e.g. we connected mid-pull), the
    // activity needs to know too or its metadata can't be built.
    if (activity && !activity.playerGUID) {
      activity.playerGUID = playerId;

      if (!activity.getCombatant(playerId)) {
        const self = new Combatant(playerId);
        self.name = playerName;
        activity.addCombatant(self);
      }
    }
  }

  private handlePartyChanged(party: PartyMember[]) {
    const members = party.filter((member) => member.inParty);
    const combatants = new Map<string, Combatant>();

    members.forEach((member) => {
      const combatant = new Combatant(member.id);
      combatant.name = member.name;
      combatant.job = member.job
        .toString(16)
        .toUpperCase()
        .padStart(2, '0') as Job;
      combatants.set(member.id, combatant);
    });

    if (this.playerGUID) {
      const self = combatants.get(this.playerGUID);

      if (self?.name) {
        this.playerName = self.name;
      }
    }

    this.currentCombatants = combatants;

    const activity = FFXIVGenericLogHandler.activity;

    if (activity) {
      combatants.forEach((combatant) => activity.addCombatant(combatant));
    }
  }

  private async handleDeath(line: FFXIVLogLine) {
    const parsed = new DeathLine(line);
    const activity = FFXIVGenericLogHandler.activity;
    const boss = this.bossActors.get(parsed.targetId);

    if (boss) {
      const wasPrimary = this.primaryBoss?.id === boss.id;
      boss.dead = true;
      this.refreshPrimaryBoss();

      if (wasPrimary && activity instanceof FFXIVBossEncounter) {
        this.handleBossKilled(boss.name, parsed.timestamp);
      }

      return;
    }

    if (!activity) {
      return;
    }

    const player = activity.getCombatant(parsed.targetId);

    if (player) {
      const relativeTime =
        (parsed.timestamp.getTime() - activity.startDate.getTime()) / 1000;

      const death: PlayerDeathType = {
        name: player.name ? player.name : '',
        timestamp: relativeTime,
      };

      activity.addDeath(death);
      return;
    }

    // An actor we never saw spawn, e.g. we connected after the boss did.
    // Fall back to matching the name, which is how bosses used to be found.
    if (
      activity instanceof FFXIVBossEncounter &&
      FFXIVLogHandler.bossNames.has(parsed.targetName)
    ) {
      this.handleBossKilled(parsed.targetName, parsed.timestamp);
    }
  }

  /**
   * The boss died. In sealed content the unseal ends the pull, but the
   * death line can arrive after it, and in any mode it can trail the combat
   * drop by a couple of seconds, so a pull that's already winding down
   * becomes a kill. Otherwise this is just remembered for when it does end.
   */
  private handleBossKilled(name: string, timestamp: Date) {
    console.info('[FFXIVLogHandler] Boss killed:', name);
    this.bossKilledThisPull = true;

    if (this.mode === RecordMode.Sealed || this.pendingEnd) {
      const endDate = this.pendingEnd?.timestamp ?? timestamp;
      this.schedulePullEnd(endDate, true);
    }
  }

  /**
   * HP updates for the boss feed the boss percentage on wipes. These are
   * frequent for every actor, so check the actor ID before parsing.
   */
  private handleUpdateHp(line: FFXIVLogLine) {
    const activity = FFXIVGenericLogHandler.activity;

    if (!this.primaryBoss || !(activity instanceof FFXIVBossEncounter)) {
      return;
    }

    if (line.arg(2) !== this.primaryBoss.id) {
      return;
    }

    const parsed = new UpdateHpLine(line);

    if (Number.isNaN(parsed.currentHp) || Number.isNaN(parsed.maxHp)) {
      return;
    }

    activity.updateHp(parsed.currentHp, parsed.maxHp);
  }

  private getRelativeTimestamp(eventDate: Date) {
    const activity = FFXIVGenericLogHandler.activity;

    if (!activity) {
      return 0;
    }

    return (eventDate.getTime() - activity.startDate.getTime()) / 1000;
  }
}
