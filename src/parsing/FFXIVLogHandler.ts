import FFXIVGenericLogHandler from './FFXIVGenericLogHandler';
import FFXIVLogLine from './FFXIVLogLine';
import {
  ContentFinderSettingsLine,
  AddCombatantLine,
  ChangePrimaryPlayerLine,
  LogLineLine,
  DeathLine,
  InCombatLine,
  BuffLine,
} from './FFXIVParsedLogLines';
import Combatant from 'main/Combatant';
import { zones, BNpcNameIdToNameMap } from 'main/FFXIVConstants';
import Activity from 'activitys/Activity';
import {
  LogType,
  ContentType,
  Zone,
  Difficulty,
  FFXIVGameState,
  Job,
} from 'main/FFXIVTypes';
import FFXIVDungeon from 'activitys/FFXIVDungeon';
import { PlayerDeathType } from 'main/types';
import { DungeonTimelineSegment, TimelineSegmentType } from 'main/keystone';
import { VideoCategory } from 'types/VideoCategory';
import FFXIVBossEncounter from 'activitys/FFXIVBossEncounter';
import { PartyMember } from './FFXIVCombatLogWatcher';

// everything seems to be off by 3 seconds
const OFFSET = 0;


/**
 * FFXIVLogHandler class.
 */

// TODO: I'm not sure the log types with id > 260 will work without IINACT, so probably need to not use them
export default class FFXIVLogHandler extends FFXIVGenericLogHandler {
  currentZone: Zone | undefined = undefined;
  currentCombatants: Combatant[] = [];
  playerGUID: string | undefined;
  shouldRecordOnCombat: boolean = false;
  currentPull: number = 0;
  currentBossId: [number, string] | undefined;
  private playerDeaths: number = 0;
  private isRecoveringState: boolean = false;

  constructor(wsUrl: string) {
    super(wsUrl, 10);

    // Recover state from existing log files before processing new events
    this.recoverState();

    this.combatLogWatcher.on(
      LogType.CONTENT_FINDER_SETTINGS,
      async (line: FFXIVLogLine) => {
        await this.handleContentFinderSettings(line);
      },
    );
    this.combatLogWatcher.on(
      LogType.ADD_COMBATANT,
      async (line: FFXIVLogLine) => {
        await this.handleAddCombatant(line);
      },
    );
    this.combatLogWatcher.on(
      LogType.CHANGE_PRIMARY_PLAYER,
      async (line: FFXIVLogLine) => {
        await this.handlePlayer(line);
      },
    );
    this.combatLogWatcher.on(LogType.LOG_LINE, async (line: FFXIVLogLine) => {
      await this.handleChat(line);
    });
    this.combatLogWatcher.on(LogType.DEATH, async (line: FFXIVLogLine) => {
      await this.handleDeath(line);
    });
    this.combatLogWatcher.on(LogType.IN_COMBAT, async (line: FFXIVLogLine) => {
      await this.handleInCombat(line);
    });
    this.combatLogWatcher.on(LogType.BUFF, async (line: FFXIVLogLine) => {
      this.handleBuff(line);
    });

    // Listen for Cactbot zone change events (for state recovery when app starts mid-dungeon)
    this.combatLogWatcher.on('cactbotZoneChange', (zoneName: string) => {
      this.handleCactbotZoneChange(zoneName);
    });

    // Listen for Cactbot player change events to set playerGUID on startup
    this.combatLogWatcher.on('cactbotPlayerChange', (playerId: string) => {
      this.playerGUID = playerId;
      if (FFXIVGenericLogHandler.activity && !FFXIVGenericLogHandler.activity.playerGUID) {
        FFXIVGenericLogHandler.activity.playerGUID = playerId;
      }
    });

    // Listen for party change events to populate combatants
    this.combatLogWatcher.on('partyChanged', (party: PartyMember[]) => {
      this.handlePartyChanged(party);
    });
  }

  private async handleContentFinderSettings(line: FFXIVLogLine) {
    console.debug('[FFXIVLogHandler] handleContentFinderSettings');
    const parsed = new ContentFinderSettingsLine(line);
    const territory = zones.find((zone) => zone.id === parsed.zoneId);
    if (!territory) {
      console.debug('[FFXIVLogHandler] no territory. Ending recording');
      this.currentZone = undefined;
      this.currentCombatants = [];
      this.shouldRecordOnCombat = false;
      this.currentPull = 0;
      this.endRecording(line, false);
      return;
    }
    this.currentZone = territory;
    if (territory.difficulty === Difficulty.Ultimate) {
      console.debug('[FFXIVLogHandler] starting ultimate');
      this.shouldRecordOnCombat = true;
    } else if (territory.difficulty === Difficulty.Chaotic) {
      console.debug('[FFXIVLogHandler] starting chaotic');
      this.shouldRecordOnCombat = true;
    } else if (territory.type === ContentType.Trial) {
      console.debug('[FFXIVLogHandler] starting trial');
      this.shouldRecordOnCombat = true;
    } else if (territory.type === ContentType.Raid) {
      console.debug('[FFXIVLogHandler] starting raid');
      this.shouldRecordOnCombat = true;
    } else if (territory.type === ContentType['Deep Dungeon']) {
      console.debug('[FFXIVLogHandler] starting deep dungeon');
      const activity = new FFXIVDungeon(
        parsed.timestamp,
        territory.name,
        territory.difficulty,
        VideoCategory.FFXIVDeepDungeons,
      );
      const segment = new DungeonTimelineSegment(
        TimelineSegmentType.Trash,
        parsed.timestamp,
        0,
      );
      activity.addTimelineSegment(segment);
      this.startRecording(activity);
    } else if (territory.type === ContentType.Dungeon) {
      console.debug('[FFXIVLogHandler] starting dungeon');
      const activity = new FFXIVDungeon(
        parsed.timestamp,
        territory.name,
        territory.difficulty,
        VideoCategory.FFXIVDungeons,
      );
      const segment = new DungeonTimelineSegment(
        TimelineSegmentType.Trash,
        parsed.timestamp,
        0,
      );
      activity.addTimelineSegment(segment);
      this.startRecording(activity);
    } else if (territory.type === ContentType['Alliance Raid']) {
      console.debug('[FFXIVLogHandler] starting alliance raid');
      this.shouldRecordOnCombat = true;
    } else if (territory.type === ContentType['Variant Dungeon']) {
      console.debug('[FFXIVLogHandler] starting variant dungeon');
      this.shouldRecordOnCombat = true;
    } else if (territory.type === ContentType['Criterion Dungeon']) {
      console.debug('[FFXIVLogHandler] starting criterion dungeon');
      this.shouldRecordOnCombat = true;
    }
  }

  /**
   * Handle zone change events from Cactbot. This is used for state recovery
   * when the app starts mid-dungeon, since we won't receive a CONTENT_FINDER_SETTINGS
   * log line in that case.
   */
  private handleCactbotZoneChange(zoneName: string) {
    // If we already have a zone set from CONTENT_FINDER_SETTINGS, don't override it
    // since that's more precise (has zone ID)
    if (this.currentZone) {
      console.debug(
        '[FFXIVLogHandler] Cactbot zone change ignored, already have zone:',
        this.currentZone.name,
      );
      return;
    }

    // Try to find the zone by name (rawName matches Cactbot's zone name format)
    // rawName is lowercase "the X" while name is "The X"
    const normalizedName = zoneName.toLowerCase();
    const territory = zones.find(
      (zone) =>
        zone.rawName.toLowerCase() === normalizedName ||
        zone.name.toLowerCase() === normalizedName,
    );

    if (!territory) {
      console.debug(
        '[FFXIVLogHandler] Cactbot zone change: no matching zone found for:',
        zoneName,
      );
      return;
    }

    console.info(
      '[FFXIVLogHandler] Cactbot zone change: matched zone:',
      territory.name,
      'type:',
      ContentType[territory.type],
    );

    this.currentZone = territory;

    // Set up recording flags based on content type (same logic as handleContentFinderSettings)
    if (
      territory.type === ContentType.Trial ||
      territory.type === ContentType.Raid ||
      territory.type === ContentType['Variant Dungeon'] ||
      territory.type === ContentType['Criterion Dungeon'] ||
      territory.type === ContentType['Alliance Raid'] ||
      territory.difficulty === Difficulty.Ultimate
    ) {
      this.shouldRecordOnCombat = true;
      console.info(
        '[FFXIVLogHandler] Cactbot zone change: enabled shouldRecordOnCombat for',
        territory.name,
      );
    }
  }

  private async handleAddCombatant(line: FFXIVLogLine) {
    // console.debug('[FFXIVLogHandler] handleAddCombatant');
    if (!this.currentZone) return;

    const parsed = new AddCombatantLine(line);

    // Enemies are combatants who don't have a job
    // TODO: NOPE. Memoriates of darkness in the lunar subterannae are Gladiators.
    if (parsed.isPlayer()) {
      console.log('[FFXIVLogHandler] combatant has a job');
      const combatant = new Combatant(parsed.actorId);
      combatant.name = parsed.name;
      combatant.job = parsed.job;
      this.currentCombatants.push(combatant);
      if (FFXIVGenericLogHandler.activity) {
        FFXIVGenericLogHandler.activity.addCombatant(combatant);
      }
    } else {
      // TODO: The problem is there are like 9 duplicate combatants
      // Note: BNpcBaseIdToNameMap actually contains BNpcNameIDs, not BNpcBaseIDs
      if (BNpcNameIdToNameMap.has(parsed.npcNameId)) {
        console.debug(
          `[FFXIVLogHandler] setting current boss: ${BNpcNameIdToNameMap.get(parsed.npcNameId)}`,
        );
        this.currentBossId = [parsed.npcNameId, parsed.actorId];
      }
    }
  }

  private handlePartyChanged(party: PartyMember[]) {
    const partyMembers = party.filter((m) => m.inParty);
    console.info(
      '[FFXIVLogHandler] Party changed, members:',
      partyMembers.length,
    );

    this.currentCombatants = partyMembers.map((member) => {
      const combatant = new Combatant(member.id);
      combatant.name = member.name;
      const jobHex = member.job
        .toString(16)
        .toUpperCase()
        .padStart(2, '0') as Job;
      combatant.job = jobHex;
      return combatant;
    });

    // Update the current activity if one is in progress
    if (FFXIVGenericLogHandler.activity) {
      this.currentCombatants.forEach((combatant) => {
        FFXIVGenericLogHandler.activity!.addCombatant(combatant);
      });
    }
  }

  private async handlePlayer(line: FFXIVLogLine) {
    const parsed = new ChangePrimaryPlayerLine(line);
    this.playerGUID = parsed.playerId;
    if (FFXIVGenericLogHandler.activity) {
      const combatant = new Combatant(parsed.playerId);
      combatant.name = parsed.playerName;
      FFXIVGenericLogHandler.activity.playerGUID = parsed.playerId;
      FFXIVGenericLogHandler.activity.addCombatant(combatant);
    }
  }

  private async handleChat(line: FFXIVLogLine) {
    const parsed = new LogLineLine(line);

    if (!parsed.isDungeonChannel()) {
      return;
    }
    // this won't work. When you leave a dungeon it says "has ended"
    if (!parsed.isCompletionMessage()) {
      return;
    }
    const activity = FFXIVGenericLogHandler.activity;
    if (activity) {
      if (this.currentZone?.type === ContentType.Dungeon) {
        (
          FFXIVGenericLogHandler.activity as FFXIVDungeon
        ).endCurrentTimelineSegment(parsed.timestamp);
      }
      this.endRecording(line, true);
    }
  }

  // I think in order to get trials/raids to work right, I need to look for the death of the boss
  // that means I got a lot more boss ids to add lol
  private async handleDeath(line: FFXIVLogLine) {
    const activity = FFXIVGenericLogHandler.activity;
    if (activity) {
      const parsed = new DeathLine(line);
      const deadPlayer = activity.getCombatant(parsed.targetId);
      if (deadPlayer) {
        // deaths seem to be recorded 3 seconds after the actual death
        const deathDate = parsed.timestamp.getTime() / 1000 - OFFSET;
        const activityStartDate = activity.startDate.getTime() / 1000;
        const relativeTime = deathDate - activityStartDate;
        const playerDeath: PlayerDeathType = {
          name: deadPlayer.name ? deadPlayer.name : '',
          timestamp: relativeTime,
        };
        activity.addDeath(playerDeath);
        this.playerDeaths++;

        console.debug(
          `[FFXIVLogHandler] ${this.playerDeaths}/${this.currentCombatants.length} dead players`,
        );

        if (
          (this.currentZone?.type === ContentType['Variant Dungeon'] ||
           this.currentZone?.type === ContentType['Criterion Dungeon'] ||
           this.currentZone?.type === ContentType['Alliance Raid']) &&
          this.playerDeaths >= this.currentCombatants.length
        ) {
          console.debug(
            '[FFXIVLogHandler] handleDeath: all players dead in variant dungeon',
          );
          this.endRecording(line, false);
          this.playerDeaths = 0;
        }
      } else if (
        this.currentBossId &&
        parsed.targetName === BNpcNameIdToNameMap.get(this.currentBossId[0]) &&
        (this.currentZone?.type === ContentType['Variant Dungeon'] ||
         this.currentZone?.type === ContentType['Criterion Dungeon'] ||
         this.currentZone?.type === ContentType['Alliance Raid'])
      ) {
        console.debug(
          '[FFXIVLogHandler] handleDeath: boss defeated',
        );
        this.endRecording(line, true);
        this.currentPull = 0;
        this.playerDeaths = 0;
      } else if (
        this.currentBossId &&
        parsed.targetName === BNpcNameIdToNameMap.get(this.currentBossId[0]) &&
        this.currentZone?.type === ContentType.Dungeon
      ) {
        // end dungeon boss segment
        console.debug('[FFXIVLogHandler] handleDeath: ending boss segment');
        const dungeonActivity = FFXIVGenericLogHandler.activity as FFXIVDungeon;
        const segment = new DungeonTimelineSegment(
          TimelineSegmentType.Trash,
          parsed.timestamp,
          this.getRelativeTimestampForTimelineSegment(parsed.timestamp, OFFSET),
        );
        dungeonActivity.addTimelineSegment(segment, parsed.timestamp);
      }
    }
  }

  private handleBuff(line: FFXIVLogLine) {
    if (this.playerDeaths === 0) return;

    const parsed = new BuffLine(line);
    if (!parsed.isTranscendent()) return;

    const activity = FFXIVGenericLogHandler.activity;
    if (!activity) return;

    const combatant = activity.getCombatant(parsed.targetId);
    if (combatant) {
      console.debug(
        `[FFXIVLogHandler] handleBuff: player ${parsed.targetName} revived (Transcendent)`,
      );
      this.playerDeaths--;
      console.debug(
        `[FFXIVLogHandler] ${this.playerDeaths}/${this.currentCombatants.length} dead players`,
      );
    }
  }

  private async handleInCombat(line: FFXIVLogLine) {
    if (this.shouldRecordOnCombat && this.currentZone) {
      const parsed = new InCombatLine(line);

      if (!parsed.inGameCombat) {
        if (this.currentZone.type !== ContentType['Variant Dungeon'] &&
            this.currentZone.type !== ContentType['Criterion Dungeon'] &&
            this.currentZone.type !== ContentType['Alliance Raid']) {
          this.endRecording(line, false);
        }
      } else if (this.currentZone.type === ContentType.Trial) {
        this.currentPull += 1;
        const bossName = this.currentBossId
          ? BNpcNameIdToNameMap.get(this.currentBossId[0]) || this.currentZone.name
          : this.currentZone.name;
        const activity = new FFXIVBossEncounter(
          parsed.timestamp,
          this.currentZone.name,
          bossName,
          this.currentZone.difficulty,
          VideoCategory.FFXIVTrials,
        );
        activity.playerGUID = this.playerGUID;
        activity.pull = this.currentPull;
        this.startRecording(activity, 3);
      } else if (this.currentZone.type === ContentType.Raid) {
        this.currentPull += 1;
        const bossName = this.currentBossId
          ? BNpcNameIdToNameMap.get(this.currentBossId[0]) || this.currentZone.name
          : this.currentZone.name;
        const activity = new FFXIVBossEncounter(
          parsed.timestamp,
          this.currentZone.name,
          bossName,
          this.currentZone.difficulty,
          VideoCategory.FFXIVRaids,
        );
        activity.playerGUID = this.playerGUID;
        activity.pull = this.currentPull;
        this.startRecording(activity, 3);
      } else if (this.currentZone.difficulty === Difficulty.Chaotic) {
        this.currentPull += 1;
        const bossName = this.currentBossId
          ? BNpcNameIdToNameMap.get(this.currentBossId[0]) || this.currentZone.name
          : this.currentZone.name;
        const activity = new FFXIVBossEncounter(
          parsed.timestamp,
          this.currentZone.name,
          bossName,
          this.currentZone.difficulty,
          VideoCategory.FFXIVAllianceRaids,
        );
        activity.playerGUID = this.playerGUID;
        activity.pull = this.currentPull;
        this.startRecording(activity, 3);
      } else if (
        this.currentZone.type === ContentType['Criterion Dungeon'] &&
        this.currentBossId
      ) {
        this.currentPull += 1;
        const bossName =
          BNpcNameIdToNameMap.get(this.currentBossId[0]) || 'Unknown Boss';
        const activity = new FFXIVBossEncounter(
          parsed.timestamp,
          this.currentZone.name,
          bossName,
          this.currentZone.difficulty,
          VideoCategory.FFXIVCriterionDungeons,
        );
        activity.playerGUID = this.playerGUID;
        activity.pull = this.currentPull;
        this.playerDeaths = 0;
        this.startRecording(activity, 3);
      } else if (
        this.currentZone.type === ContentType['Alliance Raid'] &&
        this.currentBossId
      ) {
        this.currentPull += 1;
        const bossName =
          BNpcNameIdToNameMap.get(this.currentBossId[0]) || 'Unknown Boss';
        const activity = new FFXIVBossEncounter(
          parsed.timestamp,
          this.currentZone.name,
          bossName,
          this.currentZone.difficulty,
          VideoCategory.FFXIVAllianceRaids,
        );
        activity.playerGUID = this.playerGUID;
        activity.pull = this.currentPull;
        this.playerDeaths = 0;
        this.startRecording(activity, 3);
      } else if (
        this.currentZone.type === ContentType['Variant Dungeon'] &&
        this.currentBossId
      ) {
        this.currentPull += 1;
        // Look up the boss name from the map using npcNameId
        const bossName =
          BNpcNameIdToNameMap.get(this.currentBossId[0]) || 'Unknown Boss';
        const activity = new FFXIVBossEncounter(
          parsed.timestamp,
          this.currentZone.name,
          bossName,
          Difficulty.Normal,
          VideoCategory.FFXIVVariantDungeons,
        );
        activity.playerGUID = this.playerGUID;
        activity.pull = this.currentPull;
        this.playerDeaths = 0;
        this.startRecording(activity, 3);
      }
    }
  }


  private async startRecording(activity: Activity, offset: number = 0) {
    this.currentCombatants.forEach((combatant) => {
      activity.addCombatant(combatant);
    });
    await FFXIVGenericLogHandler.startActivity(activity, offset);
  }

  private async endRecording(line: FFXIVLogLine, success: boolean) {
    if (FFXIVGenericLogHandler.activity) {
      FFXIVGenericLogHandler.activity.end(line.date(), success);
      await FFXIVGenericLogHandler.endActivity();
    }
  }

  /**
   * Recover game state from existing log files on startup/hot reload.
   * This allows the app to resume recording if it restarts mid-encounter.
   */
  private async recoverState(): Promise<void> {
    if (this.isRecoveringState) {
      console.debug('[FFXIVLogHandler] Already recovering state, skipping');
      return;
    }

    this.isRecoveringState = true;

    try {
      const state = await this.combatLogWatcher.getCurrentGameState();

      if (state.playerId) {
        console.debug('[FFXIVLogHandler] Setting playerGUID');
        this.playerGUID = state.playerId;
      } else {
        console.debug('[FFXIVLogHandler] Not setting playerGUID');
      }

      let territory: Zone | undefined;

      // Try to find zone by ID first (most precise)
      if (state.zoneId) {
        territory = zones.find((z) => z.id === state.zoneId);
      }

      // Fall back to zone name if no ID match
      if (!territory && state.zoneName) {
        const normalizedName = state.zoneName.toLowerCase();
        territory = zones.find(
          (z) =>
            z.rawName.toLowerCase() === normalizedName ||
            z.name.toLowerCase() === normalizedName,
        );
        if (territory) {
          console.debug(
            '[FFXIVLogHandler] Matched zone by name:',
            state.zoneName,
            '->',
            territory.name,
          );
        }
      }

      if (!territory) {
        console.debug(
          '[FFXIVLogHandler] No matching territory for zone:',
          state.zoneId || state.zoneName,
        );
        return;
      }

      console.info(
        '[FFXIVLogHandler] Recovering state for zone:',
        territory.name,
        'type:',
        ContentType[territory.type],
        'inCombat:',
        state.inCombat,
      );

      this.currentZone = territory;

      // Content types that record entire run - start immediately
      const recordEntireRun = [
        ContentType.Dungeon,
        ContentType['Deep Dungeon'],
      ];

      // Content types that record boss pulls only
      const recordOnCombat = [
        ContentType.Trial,
        ContentType.Raid,
        ContentType['Criterion Dungeon'],
        ContentType['Variant Dungeon'],
        ContentType['Alliance Raid'],
      ];

      if (recordEntireRun.includes(territory.type)) {
        // Start recording immediately for content that records entire run
        await this.startRecordingForRecoveredState(territory, state);
      } else if (
        recordOnCombat.includes(territory.type) ||
        territory.difficulty === Difficulty.Ultimate ||
        territory.difficulty === Difficulty.Chaotic
      ) {
        // For boss-pull content, set shouldRecordOnCombat
        this.shouldRecordOnCombat = true;

        if (state.inCombat) {
          // Mid-pull, start recording now
          await this.startRecordingForRecoveredState(territory, state);
        } else {
          console.info(
            '[FFXIVLogHandler] Not in combat, waiting for next pull',
          );
        }
        // If not in combat, we just wait for the next InCombat event
      }
    } catch (error) {
      console.error('[FFXIVLogHandler] Error recovering state:', error);
    } finally {
      this.isRecoveringState = false;
    }
  }

  /**
   * Start recording for a recovered state. Creates the appropriate activity
   * based on the content type.
   */
  private async startRecordingForRecoveredState(
    territory: Zone,
    state: FFXIVGameState,
  ): Promise<void> {
    const timestamp = state.timestamp || new Date();

    console.info(
      '[FFXIVLogHandler] Starting recording for recovered state:',
      territory.name,
    );

    let activity: Activity | undefined;

    if (territory.difficulty === Difficulty.Ultimate) {
      this.shouldRecordOnCombat = true;
      this.currentPull += 1;
      activity = new FFXIVBossEncounter(
        timestamp,
        territory.name,
        'unknown',
        territory.difficulty,
        VideoCategory.FFXIVRaids,
      );
      (activity as FFXIVBossEncounter).pull = this.currentPull;
    } else if (territory.difficulty === Difficulty.Chaotic) {
      this.currentPull += 1;
      activity = new FFXIVBossEncounter(
        timestamp,
        territory.name,
        'unknown',
        territory.difficulty,
        VideoCategory.FFXIVAllianceRaids,
      );
      (activity as FFXIVBossEncounter).pull = this.currentPull;
    } else if (territory.type === ContentType.Trial) {
      this.shouldRecordOnCombat = true;
      this.currentPull += 1;
      activity = new FFXIVBossEncounter(
        timestamp,
        territory.name,
        'unknown',
        territory.difficulty,
        VideoCategory.FFXIVTrials,
      );
      (activity as FFXIVBossEncounter).pull = this.currentPull;
    } else if (territory.type === ContentType.Raid) {
      this.shouldRecordOnCombat = true;
      this.currentPull += 1;
      activity = new FFXIVBossEncounter(
        timestamp,
        territory.name,
        'unknown',
        territory.difficulty,
        VideoCategory.FFXIVRaids,
      );
      (activity as FFXIVBossEncounter).pull = this.currentPull;
    } else if (territory.type === ContentType['Deep Dungeon']) {
      activity = new FFXIVDungeon(
        timestamp,
        territory.name,
        territory.difficulty,
        VideoCategory.FFXIVDeepDungeons,
      );
      const segment = new DungeonTimelineSegment(
        TimelineSegmentType.Trash,
        timestamp,
        0,
      );
      (activity as FFXIVDungeon).addTimelineSegment(segment);
    } else if (territory.type === ContentType.Dungeon) {
      activity = new FFXIVDungeon(
        timestamp,
        territory.name,
        territory.difficulty,
        VideoCategory.FFXIVDungeons,
      );
      const segment = new DungeonTimelineSegment(
        TimelineSegmentType.Trash,
        timestamp,
        0,
      );
      (activity as FFXIVDungeon).addTimelineSegment(segment);
    } else if (territory.type === ContentType['Alliance Raid']) {
      this.shouldRecordOnCombat = true;
      this.currentPull += 1;
      activity = new FFXIVBossEncounter(
        timestamp,
        territory.name,
        'unknown',
        territory.difficulty,
        VideoCategory.FFXIVAllianceRaids,
      );
    } else if (territory.type === ContentType['Criterion Dungeon']) {
      this.shouldRecordOnCombat = true;
      this.currentPull += 1;
      activity = new FFXIVBossEncounter(
        timestamp,
        territory.name,
        'unknown',
        territory.difficulty,
        VideoCategory.FFXIVCriterionDungeons,
      );
    } else if (territory.type === ContentType['Variant Dungeon']) {
      this.shouldRecordOnCombat = true;
      this.currentPull += 1;
      // For variant dungeons, we might not have the boss ID on recovery
      // so we create a generic boss encounter activity
      activity = new FFXIVBossEncounter(
        timestamp,
        territory.name,
        'unknown', // We don't have the boss ID on recovery
        Difficulty.Normal,
        VideoCategory.FFXIVVariantDungeons,
      );
    }

    if (activity) {
      activity.playerGUID = this.playerGUID;
      await this.startRecording(activity, 3);
    }
  }

  private getRelativeTimestampForTimelineSegment(
    eventDate: Date,
    offset: number = 0,
  ) {
    if (!FFXIVGenericLogHandler.activity) {
      console.error(
        '[FFXIVLogHandler] getRelativeTimestampForTimelineSegment called but no active activity',
      );

      return 0;
    }

    const activityStartDate = FFXIVGenericLogHandler.activity.startDate;
    const relativeTime =
      (eventDate.getTime() - activityStartDate.getTime()) / 1000 - offset;
    return relativeTime;
  }
}
