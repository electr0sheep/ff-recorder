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
  AbilityLine,
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
   * A mid-fight cutscene drops the flag too; the pull is held open through
   * it and the cutscene cut out of the video, see holdPull.
   */
  Combat,

  /**
   * The whole duty is one pull: raids that are a gauntlet of trash waves
   * with no boss (Binding Coil Turn 4, Alexander Cuff of the Father). Combat
   * drops between the waves, so a pull starts on the first combat and only
   * ends on the duty completing, the party being defeated or leaving.
   */
  Gauntlet,

  /**
   * Each boss is a video: alliance raids, variant and criterion dungeons,
   * which all have trash in between. A pull starts when the arena is sealed
   * off or a player hits the boss (the Crystal Tower raids never post the
   * seal message), and ends on the boss dying, the arena unsealing or
   * combat dropping.
   */
  Sealed,
}

/**
 * A boss actor we've seen spawn in the current duty. Bosses spawn with a
 * pile of helper actors sharing their name, so every actor is tracked and
 * the living one with the most HP is treated as the real boss. Council
 * fights have several real bosses with equal HP, see handleBossDefeated.
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
 * How long to wait after a Cactbot zone event for IINACT's 265 line, which
 * carries the zone ID. During normal play it follows within a few hundred
 * milliseconds; if it never comes we connected mid-duty.
 */
const CACTBOT_ZONE_GRACE_MS = 2000;

/**
 * Seconds to cut back into the buffer when a pull is detected from a player
 * hitting the boss, which trails the actual pull by a few seconds.
 */
const BOSS_ENGAGE_CUTBACK_S = 5;

/**
 * Seconds to cut back into the buffer when a pull starts on the combat flag,
 * and when one resumes after a cutscene, as the flag trails the first hit.
 */
const PULL_CUTBACK_S = 3;

/**
 * The online status of a player watching a cutscene, as carried by IINACT's
 * OnlineStatusChanged event (its own name for it is InCutscene).
 */
const ONLINE_STATUS_CUTSCENE = 15;

/**
 * How close the player going into (or coming out of) a cutscene and combat
 * dropping have to be for the drop to be the cutscene's doing. Fights with a
 * mid-fight cutscene drop combat for it and pick it up again after, so such
 * a drop is an intermission in the pull, not a wipe.
 */
const CUTSCENE_DROP_WINDOW_MS = 15000;

/**
 * The longest a pull is held open through a cutscene. The Porta Decumana's
 * runs about five minutes unskipped, so this has headroom; a pull still
 * waiting after this ends as a wipe where combat dropped.
 */
const INTERMISSION_MAX_MS = 10 * 60 * 1000;

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

  /** Pulls started in this duty, keyed by boss name. */
  private pullsByBoss = new Map<string, number>();

  /** Boss actors seen in the current duty, keyed by actor ID. */
  private bossActors = new Map<string, BossActor>();

  /** The actor we consider the real boss, see BossActor. */
  private primaryBoss: BossActor | undefined;

  private bossKilledThisPull = false;

  /** A pull end waiting out the grace period, see COMBAT_END_GRACE_MS. */
  private pendingEnd:
    | { timer: NodeJS.Timeout; timestamp: Date; success: boolean }
    | undefined;

  /**
   * The cutscene the player is in or was last in, see isCutsceneDrop. The
   * end is unset while they're still watching it.
   */
  private cutscene: { start: Date; end?: Date } | undefined;

  /**
   * A pull held open while combat is down for a cutscene, see holdPull. The
   * start is when combat dropped; the timer gives up if it never comes back.
   */
  private intermission: { start: Date; timer: NodeJS.Timeout } | undefined;

  /** A run's boss segment end waiting out the same grace period. */
  private pendingSegmentEnd: { timer: NodeJS.Timeout } | undefined;

  /** Last combat state reported by Cactbot, used for recovery on connect. */
  private cactbotInCombat = false;

  /** A Cactbot zone match waiting to see if the 265 line turns up first. */
  private pendingCactbotZone: NodeJS.Timeout | undefined;

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
    this.onLine(LogType.ABILITY, (line) => this.handleAbility(line));
    this.onLine(LogType.AOE_ABILITY, (line) => this.handleAbility(line));
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

    this.combatLogWatcher.on(
      'onlineStatusChanged',
      (targetId: string, status: number) => {
        this.handleOnlineStatus(targetId, status);
      },
    );
  }

  public destroy() {
    this.clearPendingEnd();
    this.clearPendingSegmentEnd();
    this.clearIntermission();
    this.clearPendingCactbotZone();
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
    // This line is authoritative, so a Cactbot match waiting on it can go.
    this.clearPendingCactbotZone();

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
    // Any zone change supersedes a match still waiting on its 265 line.
    this.clearPendingCactbotZone();

    if (this.currentZone) {
      return;
    }

    const normalizedName = zoneName.toLowerCase();

    // Cactbot sends the game's place name, which is what rawName holds
    // ("Halatali (Hard)"). Display names are ambiguous: over a hundred
    // duties share theirs with a harder version, so only fall back to them.
    const territory =
      zones.find((zone) => zone.rawName.toLowerCase() === normalizedName) ??
      zones.find((zone) => zone.name.toLowerCase() === normalizedName);

    if (!territory) {
      console.debug('[FFXIVLogHandler] No recorded territory named:', zoneName);
      return;
    }

    // Let the 265 line win if it's coming: it has the zone ID, so it can't
    // pick the wrong variant. Starting from here and then restarting on the
    // 265 line loses the buffer, which puts the whole video out of step
    // with the death markers.
    const timestamp = new Date();

    this.pendingCactbotZone = setTimeout(() => {
      this.pendingCactbotZone = undefined;
      console.info('[FFXIVLogHandler] Cactbot zone matched:', territory.name);

      this.enterTerritory(territory, timestamp)
        .then(async () => {
          // If Cactbot already told us we're in combat, we joined mid-pull.
          if (this.cactbotInCombat) {
            await this.handleCombatChange(true, new Date());
          }
        })
        .catch((error) =>
          console.error('[FFXIVLogHandler] Cactbot zone entry failed', error),
        );
    }, CACTBOT_ZONE_GRACE_MS);
  }

  private clearPendingCactbotZone() {
    if (this.pendingCactbotZone) {
      clearTimeout(this.pendingCactbotZone);
      this.pendingCactbotZone = undefined;
    }
  }

  private async enterTerritory(territory: Zone, timestamp: Date) {
    if (this.currentZone?.id === territory.id) {
      // Duplicate zone info, e.g. the 265 line following a Cactbot event, or
      // IINACT re-emitting the zone on start. Nothing to do.
      return;
    }

    if (
      this.currentZone &&
      this.currentZone.name === territory.name &&
      this.currentZone.type === territory.type
    ) {
      // Same duty, different table entry: a name match picked a sibling
      // variant. Adopt the precise entry rather than restarting, which
      // would throw away the buffer.
      console.info('[FFXIVLogHandler] Zone refined to', territory.rawName);
      this.currentZone = territory;
      this.mode = FFXIVLogHandler.getRecordMode(territory);
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
    this.clearPendingSegmentEnd();
    this.clearIntermission();
    this.pullsByBoss.clear();
    this.bossActors.clear();
    this.primaryBoss = undefined;
    this.bossKilledThisPull = false;
  }

  private static getRecordMode(zone: Zone): RecordMode {
    if (zone.gauntlet) {
      return RecordMode.Gauntlet;
    }

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
  private async startPull(timestamp: Date, cutbackSeconds = PULL_CUTBACK_S) {
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

    activity.pull = this.countPull(bossName);

    // Cut back into the buffer to catch the start of the pull.
    await this.startRecording(activity, cutbackSeconds);
  }

  /**
   * Pulls are numbered per boss, so a wipe and a retry on Fafnir are Fafnir
   * 1 and 2 while Prishe before them stays 1. Trials and raids have one boss
   * per duty, so for them this is the same as counting per visit.
   */
  private countPull(bossName: string) {
    const pull = (this.pullsByBoss.get(bossName) ?? 0) + 1;
    this.pullsByBoss.set(bossName, pull);
    return pull;
  }

  private uncountPull(bossName: string) {
    const pull = this.pullsByBoss.get(bossName) ?? 0;
    this.pullsByBoss.set(bossName, Math.max(0, pull - 1));
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
    this.clearPendingSegmentEnd();
    const activity = FFXIVGenericLogHandler.activity;

    // A pull ending while held open for a cutscene ends where combat
    // dropped: whatever ended it happened in the cutscene, not the fight.
    const endDate = this.intermission?.start ?? timestamp;
    this.clearIntermission();

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
      activity.endCurrentTimelineSegment(endDate);
    }

    console.info(
      '[FFXIVLogHandler] Ending activity, success:',
      success,
      'category:',
      activity.category,
    );

    activity.end(endDate, success);
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

    this.pendingEnd = { timer, timestamp, success };
  }

  private clearPendingEnd() {
    if (this.pendingEnd) {
      clearTimeout(this.pendingEnd.timer);
      this.pendingEnd = undefined;
    }
  }

  /**
   * Whether a combat drop at this time is a cutscene's doing: the player is
   * in one that started during this pull, or went into or came out of one
   * within the window. Not once the boss has died, as some fights end with
   * a cutscene, and that pull is a kill.
   *
   * Combat mode only. A trial or raid has one boss, so the duty completing
   * is sure to end a held pull; in sealed content a boss we don't know
   * followed by a cutscene would hold the pull into the next boss.
   */
  private isCutsceneDrop(timestamp: Date) {
    const activity = FFXIVGenericLogHandler.activity;

    if (
      this.mode !== RecordMode.Combat ||
      !this.cutscene ||
      !(activity instanceof FFXIVBossEncounter) ||
      this.bossKilledThisPull
    ) {
      return false;
    }

    const { start, end } = this.cutscene;

    if (start.getTime() < activity.startDate.getTime()) {
      // Started before the pull, e.g. the duty's opening cutscene.
      return false;
    }

    if (!end) {
      return true;
    }

    const sinceStart = timestamp.getTime() - start.getTime();
    const sinceEnd = timestamp.getTime() - end.getTime();
    return Math.min(sinceStart, sinceEnd) <= CUTSCENE_DROP_WINDOW_MS;
  }

  /**
   * Hold the pull open through a cutscene rather than end it. Combat coming
   * back resumes it, see resumePull; anything that ends it meanwhile ends
   * it where combat dropped, see endRecording.
   */
  private holdPull(timestamp: Date) {
    this.clearPendingEnd();
    this.clearIntermission();

    console.info(
      '[FFXIVLogHandler] Combat dropped for a cutscene, holding the pull',
    );

    const timer = setTimeout(() => {
      console.info('[FFXIVLogHandler] Combat never came back, ending pull');

      this.endRecording(timestamp, this.bossKilledThisPull).catch((error) =>
        console.error('[FFXIVLogHandler] Failed to end held pull', error),
      );
    }, INTERMISSION_MAX_MS);

    this.intermission = { start: timestamp, timer };
  }

  /**
   * Combat is back after a cutscene: cut the cutscene out of the video and
   * carry on with the same pull. The resume gets the same cutback a fresh
   * pull does, as the flag trails the first hit.
   */
  private resumePull(timestamp: Date) {
    const activity = FFXIVGenericLogHandler.activity;

    if (!this.intermission) {
      return;
    }

    const { start } = this.intermission;
    this.clearIntermission();

    if (!activity) {
      return;
    }

    const end = new Date(
      Math.max(timestamp.getTime() - PULL_CUTBACK_S * 1000, start.getTime()),
    );

    activity.addIntermission(start, end);

    console.info(
      '[FFXIVLogHandler] Pull resumed, cutting',
      ((end.getTime() - start.getTime()) / 1000).toFixed(0),
      'seconds of cutscene',
    );
  }

  private clearIntermission() {
    if (this.intermission) {
      clearTimeout(this.intermission.timer);
      this.intermission = undefined;
    }
  }

  /**
   * The player's online status changed. Going into a cutscene is what tells
   * a mid-fight cutscene from a wipe when combat drops, see isCutsceneDrop:
   * neither comes with deaths or a director line the other doesn't.
   */
  private handleOnlineStatus(targetId: string, status: number) {
    if (!this.playerGUID || targetId !== this.playerGUID) {
      return;
    }

    const now = new Date();

    if (status !== ONLINE_STATUS_CUTSCENE) {
      if (this.cutscene && !this.cutscene.end) {
        console.info('[FFXIVLogHandler] Player is out of the cutscene');
        this.cutscene.end = now;
      }

      return;
    }

    if (this.cutscene && !this.cutscene.end) {
      // Already in it; IINACT re-sends the last status on connect.
      return;
    }

    console.info('[FFXIVLogHandler] Player is in a cutscene');
    this.cutscene = { start: now };

    // If combat already dropped and the end is waiting out the grace
    // period, that drop was the cutscene's, so hold the pull instead.
    if (
      this.pendingEnd &&
      !this.pendingEnd.success &&
      this.isCutsceneDrop(this.pendingEnd.timestamp)
    ) {
      this.holdPull(this.pendingEnd.timestamp);
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
    if (this.mode === RecordMode.None) {
      return;
    }

    if (this.mode === RecordMode.Run) {
      // Runs record throughout; combat only delimits their boss segments.
      this.handleRunCombatChange(inCombat, timestamp);
      return;
    }

    if (inCombat) {
      // Combat resuming after a brief drop cancels a pending wipe and the
      // recording carries on. A pending kill stands: after a boss dies in
      // sealed content the next trash pack can follow within seconds.
      if (this.pendingEnd && !this.pendingEnd.success) {
        this.clearPendingEnd();
      }

      // Nobody fights from inside a cutscene, so if we still have the player
      // in one we missed them leaving it.
      if (this.cutscene && !this.cutscene.end) {
        this.cutscene.end = timestamp;
      }

      // Combat coming back while the pull is held open is the fight
      // resuming after its cutscene.
      if (this.intermission) {
        this.resumePull(timestamp);
        return;
      }

      if (
        this.mode === RecordMode.Combat ||
        this.mode === RecordMode.Gauntlet
      ) {
        await this.startPull(timestamp);
      }

      // Sealed content has trash, so combat alone doesn't mean a boss pull;
      // those start from the arena seal or a player hitting the boss.
      return;
    }

    if (this.mode === RecordMode.Gauntlet) {
      // Combat drops between every wave of a gauntlet, so it says nothing
      // about the pull. The director ends those.
      return;
    }

    if (this.intermission) {
      // Still down for the cutscene: the same drop from the other source,
      // or a flicker while it plays.
      return;
    }

    if (this.isCutsceneDrop(timestamp)) {
      // Combat dropped for a mid-fight cutscene, which is an intermission
      // in the pull rather than the end of it.
      this.holdPull(timestamp);
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
    } else if (parsed.isPartyDefeated()) {
      await this.handlePartyDefeated(parsed.timestamp);
    }
  }

  /**
   * The party was defeated and the duty is resetting. Gauntlets don't end
   * on combat dropping, so this is what ends their pull as a wipe. The other
   * modes already end on the combat drop that comes with it, unless they
   * took the drop for a cutscene and held the pull open.
   */
  private async handlePartyDefeated(timestamp: Date) {
    if (!FFXIVGenericLogHandler.activity) {
      return;
    }

    if (this.intermission) {
      console.info('[FFXIVLogHandler] Party defeated while holding the pull');
      await this.endRecording(timestamp, false);
      return;
    }

    if (this.mode !== RecordMode.Gauntlet) {
      return;
    }

    console.info('[FFXIVLogHandler] Party defeated');
    await this.endRecording(timestamp, false);
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

    if (this.mode === RecordMode.Run) {
      this.startBossSegment(this.primaryBoss?.name, timestamp);
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

    if (this.mode === RecordMode.Run) {
      this.endBossSegment(timestamp, this.bossKilledThisPull);
    }
  }

  /** Whether the run being recorded is in a boss segment right now. */
  private inBossSegment(): boolean {
    const activity = FFXIVGenericLogHandler.activity;

    return (
      activity instanceof FFXIVDungeon &&
      activity.currentSegment?.segmentType === TimelineSegmentType.BossEncounter
    );
  }

  /**
   * Start a boss segment in a run. The arena seal message starts one when
   * IINACT logs chat, and a player hitting the boss starts one regardless;
   * whichever comes first wins and the other is a no-op. A hit trails the
   * pull by a few seconds, hence the cutback.
   */
  private startBossSegment(
    name: string | undefined,
    timestamp: Date,
    cutbackSeconds = 0,
  ) {
    const activity = FFXIVGenericLogHandler.activity;

    if (!(activity instanceof FFXIVDungeon) || this.inBossSegment()) {
      return;
    }

    this.clearPendingSegmentEnd();
    this.bossKilledThisPull = false;

    // Never cut back past the start of the trash segment being ended.
    const floor = activity.currentSegment?.logStart ?? activity.startDate;

    const start = new Date(
      Math.max(timestamp.getTime() - cutbackSeconds * 1000, floor.getTime()),
    );

    console.info('[FFXIVLogHandler] Boss segment:', name ?? 'unknown boss');

    const segment = new DungeonTimelineSegment(
      TimelineSegmentType.BossEncounter,
      start,
      this.getRelativeTimestamp(start),
      undefined,
      name,
    );

    activity.addTimelineSegment(segment, start);
  }

  /**
   * End a run's boss segment and go back to trash. The boss dying, the
   * arena unsealing and combat dropping while the boss lives all get here;
   * the first one wins.
   */
  private endBossSegment(timestamp: Date, success: boolean) {
    const activity = FFXIVGenericLogHandler.activity;

    if (!(activity instanceof FFXIVDungeon) || !this.inBossSegment()) {
      return;
    }

    this.clearPendingSegmentEnd();

    console.info(
      '[FFXIVLogHandler] Boss segment over:',
      activity.currentSegment?.name ?? 'unknown boss',
      success ? 'kill' : 'wipe',
    );

    const segment = new DungeonTimelineSegment(
      TimelineSegmentType.Trash,
      timestamp,
      this.getRelativeTimestamp(timestamp),
    );

    activity.addTimelineSegment(segment, timestamp);
  }

  /**
   * In a run the combat flag can't start a boss segment, as trash is combat
   * too, but a drop while the boss lives means the party wiped or the boss
   * reset, which ends the segment. Brief drops ride out the grace period,
   * and so does the death line, which trails the drop by a couple of
   * seconds on a kill.
   */
  private handleRunCombatChange(inCombat: boolean, timestamp: Date) {
    if (inCombat) {
      this.clearPendingSegmentEnd();
      return;
    }

    if (!this.inBossSegment()) {
      return;
    }

    this.clearPendingSegmentEnd();

    const timer = setTimeout(() => {
      this.pendingSegmentEnd = undefined;
      this.endBossSegment(timestamp, false);
    }, COMBAT_END_GRACE_MS);

    this.pendingSegmentEnd = { timer };
  }

  private clearPendingSegmentEnd() {
    if (this.pendingSegmentEnd) {
      clearTimeout(this.pendingSegmentEnd.timer);
      this.pendingSegmentEnd = undefined;
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
      // Actor IDs are recycled, so an ID we tracked as a boss can come back
      // as trash. Drop the stale entry or a hit on the trash starts a pull.
      if (this.bossActors.delete(parsed.actorId)) {
        this.refreshPrimaryBoss();
      }

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

  /**
   * Bosses with an ending cutscene never die: the game despawns them at 1 HP
   * with no death line (Prishe, Shantotto and Shiva all go this way), so a
   * despawn at 1 HP or less counts as a kill. A wipe despawns the boss with
   * whatever HP it had left.
   */
  private handleRemoveCombatant(line: FFXIVLogLine) {
    const parsed = new RemoveCombatantLine(line);
    const boss = this.bossActors.get(parsed.actorId);

    if (!boss) {
      return;
    }

    if (!boss.dead && parsed.currentHp <= 1) {
      this.handleBossDefeated(boss, parsed.timestamp);
    }

    this.bossActors.delete(boss.id);
    this.refreshPrimaryBoss();
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

    // If the pull started before the boss spawned, fix up the name. It was
    // counted under the zone's name, so count it under the boss's instead.
    const activity = FFXIVGenericLogHandler.activity;

    if (
      primary &&
      this.currentZone &&
      activity instanceof FFXIVBossEncounter &&
      activity.bossName === this.currentZone.name
    ) {
      this.uncountPull(activity.bossName);
      activity.bossName = primary.name;
      activity.pull = this.countPull(primary.name);
    }

    // Likewise a boss segment started by the seal message before the boss
    // spawned.
    if (primary && activity instanceof FFXIVDungeon) {
      const segment = activity.currentSegment;

      if (
        segment?.segmentType === TimelineSegmentType.BossEncounter &&
        segment.name === undefined
      ) {
        segment.name = primary.name;
      }
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
      this.handleBossDefeated(boss, parsed.timestamp);
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
   * A boss actor died or was despawned beaten. Council fights have several
   * bosses (the Ark Angels, the Meso Terminal's headsmen), and the fight is
   * only over once the last of them goes. Helper actors share the boss's
   * name but have a token amount of HP, so they never count as peers and
   * are never the primary while a real boss lives.
   */
  private handleBossDefeated(boss: BossActor, timestamp: Date) {
    const wasPrimary = this.primaryBoss?.id === boss.id;
    boss.dead = true;
    this.refreshPrimaryBoss();

    if (!wasPrimary) {
      return;
    }

    const activity = FFXIVGenericLogHandler.activity;

    if (
      !(activity instanceof FFXIVBossEncounter) &&
      !(activity instanceof FFXIVDungeon)
    ) {
      return;
    }

    // Peers are the encounter's other real bosses: same table entry, still
    // alive, and not a helper. The headsmen's HP ranges over almost 2x, so
    // equal HP can't be the test; helpers sit at 44 HP, so a tenth of the
    // fallen boss's HP separates them.
    const peerAlive = Array.from(this.bossActors.values()).some(
      (actor) =>
        !actor.dead &&
        actor.name === boss.name &&
        actor.maxHp * 10 >= boss.maxHp,
    );

    if (peerAlive) {
      console.info('[FFXIVLogHandler] Boss down, others remain:', boss.name);
      return;
    }

    this.handleBossKilled(boss.name, timestamp);
  }

  /**
   * The boss died. In a run that ends the boss segment. In sealed content
   * the unseal ends the pull, but the death line can arrive after it, and
   * in any mode it can trail the combat drop by a couple of seconds, so a
   * pull that's already winding down becomes a kill. Otherwise this is just
   * remembered for when the pull does end.
   */
  private handleBossKilled(name: string, timestamp: Date) {
    console.info('[FFXIVLogHandler] Boss killed:', name);
    this.bossKilledThisPull = true;

    if (this.mode === RecordMode.Run) {
      this.endBossSegment(timestamp, true);
      return;
    }

    if (this.mode === RecordMode.Sealed || this.pendingEnd) {
      const endDate = this.pendingEnd?.timestamp ?? timestamp;
      this.schedulePullEnd(endDate, true);
    }
  }

  /**
   * Abilities landing on a boss actor. These carry the target's HP, which
   * feeds the boss percentage on wipes; the 39 HP update lines never do,
   * IINACT only writes those for the party and its pets. Ability lines are
   * the most frequent in the log, so look the target up before parsing
   * anything.
   */
  private async handleAbility(line: FFXIVLogLine) {
    const target = this.bossActors.get(line.arg(6));

    if (!target || target.dead) {
      return;
    }

    const parsed = new AbilityLine(line);
    const activity = FFXIVGenericLogHandler.activity;

    if (activity instanceof FFXIVBossEncounter) {
      // The percentage follows the primary boss only.
      if (
        target.id === this.primaryBoss?.id &&
        !Number.isNaN(parsed.targetCurrentHp) &&
        !Number.isNaN(parsed.targetMaxHp)
      ) {
        activity.updateHp(parsed.targetCurrentHp, parsed.targetMaxHp);
      }

      return;
    }

    if (activity instanceof FFXIVDungeon) {
      if (this.mode === RecordMode.Run && parsed.isFromPlayer()) {
        // A player hit a boss during a run, so a boss fight is on. This is
        // the start signal when IINACT isn't logging the seal message.
        this.startBossSegment(
          target.name,
          parsed.timestamp,
          BOSS_ENGAGE_CUTBACK_S,
        );
      }

      return;
    }

    if (!activity && this.mode === RecordMode.Sealed && parsed.isFromPlayer()) {
      // A player hit a boss, so the fight is on. This is the start signal
      // for sealed content that never posts the "sealed off" message. Any
      // boss actor counts, not just the primary: in a council fight each
      // alliance opens on a different boss, and which one is primary comes
      // down to spawn order. Helper actors only exist during the fight, and
      // no player hit on one has turned up in a real log anyway.
      console.info('[FFXIVLogHandler] Boss engaged:', target.name, target.id);
      await this.startPull(parsed.timestamp, BOSS_ENGAGE_CUTBACK_S);
    }
  }

  private getRelativeTimestamp(eventDate: Date) {
    const activity = FFXIVGenericLogHandler.activity;

    if (!activity) {
      return 0;
    }

    return (eventDate.getTime() - activity.startDate.getTime()) / 1000;
  }
}
