import FFXIVGenericLogHandler from './FFXIVGenericLogHandler';
import FFXIVLogLine from './FFXIVLogLine';
import Combatant from 'main/Combatant';
import { zones, BNpcBaseIdToNameMap } from 'main/FFXIVConstants';
import FFXIVTrial from 'activitys/FFXIVTrial';
import Activity from 'activitys/Activity';
import { LogType, Job, ContentType, Zone, Difficulty } from 'main/FFXIVTypes';
import FFXIVRaid from 'activitys/FFXIVRaid';
import FFXIVDungeon from 'activitys/FFXIVDungeon';
import { PlayerDeathType } from 'main/types';
import FFXIVAllianceRaid from 'activitys/FFXIVAllianceRaid';
import { DungeonTimelineSegment, TimelineSegmentType } from 'main/keystone';

// everything seems to be off by 3 seconds
const OFFSET = 3;

/**
 * FFXIVLogHandler class.
 */

// TODO: I'm not sure the log types with id > 260 will work without IINACT, so probably need to not use them
export default class FFXIVLogHandler extends FFXIVGenericLogHandler {
  currentZone: Zone | undefined;
  currentCombatants: Combatant[] = [];
  playerGUID: string | undefined;
  shouldRecordOnCombat: boolean = false;
  currentPull: number = 0;
  currentBossId: [number, string] | undefined;

  constructor(logPath: string) {
    super(logPath, 10);

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
    this.combatLogWatcher.on(LogType.COMBATANT, async (line: FFXIVLogLine) => {
      await this.handleCombatant(line);
    });
  }

  private async handleContentFinderSettings(line: FFXIVLogLine) {
    const [
      territoryId,
      contentFinderCondition,
      inContentFinderContent,
      unrestrictedParty,
      minimalItemLevel,
      silenceEcho,
      exploreMode,
      levelSync,
    ] = this.parseZoneChangeLogLine(line);
    const territory = zones.find((zone) => zone.id === territoryId);
    if (!territory) {
      this.currentZone = undefined;
      this.currentCombatants = [];
      this.shouldRecordOnCombat = false;
      this.currentPull = 0;
      this.endRecording(line, false);
      return;
    }
    this.currentZone = territory;
    if (territory.difficulty === Difficulty.Ultimate) {
      this.shouldRecordOnCombat = true;
      const activity = new FFXIVRaid(
        line.date(),
        territory.name,
        territory.difficulty,
      );
      this.startRecording(activity);
    } else if (territory.difficulty === Difficulty.Chaotic) {
      const activity = new FFXIVAllianceRaid(
        line.date(),
        territory.name,
        territory.difficulty,
      );
      this.startRecording(activity);
    } else if (territory.type === ContentType.Trial) {
      this.shouldRecordOnCombat = true;
    } else if (territory.type === ContentType.Raid) {
      this.shouldRecordOnCombat = true;
    } else if (
      territory.type === ContentType.Dungeon ||
      territory.type === ContentType['Deep Dungeon']
    ) {
      const activity = new FFXIVDungeon(
        line.date(),
        territory.name,
        territory.difficulty,
      );
      const segment = new DungeonTimelineSegment(
        TimelineSegmentType.Trash,
        line.date(),
        0,
      );
      activity.addTimelineSegment(segment);
      this.startRecording(activity);
    } else if (territory.type === ContentType['Alliance Raid']) {
      const activity = new FFXIVAllianceRaid(
        line.date(),
        territory.name,
        territory.difficulty,
      );
      this.startRecording(activity);
    } else if (territory.type === ContentType['Variant Dungeon']) {
      const activity = new FFXIVDungeon(
        line.date(),
        territory.name,
        territory.difficulty,
      );
      this.startRecording(activity);
    } else if (territory.type === ContentType['Criterion Dungeon']) {
      const activity = new FFXIVDungeon(
        line.date(),
        territory.name,
        territory.difficulty,
      );
      this.startRecording(activity);
    }
  }

  private async handleAddCombatant(line: FFXIVLogLine) {
    if (!this.currentZone) return;

    // Enemies are combatants who don't have a job
    // TODO: NOPE. Memoriates of darkness in the lunar subterannae are Gladiators.
    const homeWorld = line.arg(8);
    const job = line.arg(4) as Job;
    if (job !== Job.None && homeWorld.length > 0) {
      const guid = line.arg(2);
      const name = line.arg(3);
      const combatant = new Combatant(guid);
      combatant.name = name;
      combatant.job = job;
      this.currentCombatants.push(combatant);
      if (FFXIVGenericLogHandler.activity) {
        FFXIVGenericLogHandler.activity.addCombatant(combatant);
      }
    } else {
      // TODO: This needs to use arg 10 and BNpcBaseIdToNameMap
      if (BNpcBaseIdToNameMap.has(Number(line.arg(10)))) {
        this.currentBossId = [Number(line.arg(10)), line.arg(2)];
      }
    }
  }

  private async handlePlayer(line: FFXIVLogLine) {
    const guid = line.arg(2);
    this.playerGUID = guid;
    if (FFXIVGenericLogHandler.activity) {
      const name = line.arg(3);
      const combatant = new Combatant(guid);
      combatant.name = name;
      FFXIVGenericLogHandler.activity.playerGUID = guid;
      FFXIVGenericLogHandler.activity.addCombatant(combatant);
    }
  }

  private async handleChat(line: FFXIVLogLine) {
    if (!['0840', '0839'].includes(line.arg(2))) {
      return;
    }
    if (
      !line.arg(4).includes('completion time') &&
      !line.arg(4).includes('has ended')
    ) {
      return;
    }
    const activity = FFXIVGenericLogHandler.activity;
    if (activity) {
      if (this.currentZone?.type === ContentType.Dungeon) {
        (
          FFXIVGenericLogHandler.activity as FFXIVDungeon
        ).endCurrentTimelineSegment(line.date());
      }
      this.endRecording(line, true);
    }
  }

  // I think in order to get trials/raids to work right, I need to look for the death of the boss
  // that means I got a lot more boss ids to add lol
  private async handleDeath(line: FFXIVLogLine) {
    const activity = FFXIVGenericLogHandler.activity;
    if (activity) {
      const deadPlayer = activity.getCombatant(line.arg(2));
      if (deadPlayer) {
        // deaths seem to be recorded 3 seconds after the actual death
        const deathDate = line.date().getTime() / 1000 - OFFSET;
        const activityStartDate = activity.startDate.getTime() / 1000;
        const relativeTime = deathDate - activityStartDate;
        const playerDeath: PlayerDeathType = {
          name: deadPlayer.name ? deadPlayer.name : '',
          job: deadPlayer.job,
          date: line.date(),
          timestamp: relativeTime,
          friendly: true,
        };
        activity.addDeath(playerDeath);
      } else if (
        this.currentBossId &&
        this.currentBossId[1] === line.arg(2) &&
        this.currentZone?.type === ContentType.Dungeon
      ) {
        // end dungeon boss segment
        console.debug('[FFXIVLogHandler] handleDeath: ending boss segment');
        const activity = FFXIVGenericLogHandler.activity as FFXIVDungeon;
        const segment = new DungeonTimelineSegment(
          TimelineSegmentType.Trash,
          line.date(),
          this.getRelativeTimestampForTimelineSegment(line.date(), OFFSET),
        );
        activity.addTimelineSegment(segment, line.date());
      }
    }
  }

  private async handleInCombat(line: FFXIVLogLine) {
    if (this.shouldRecordOnCombat && this.currentZone) {
      switch (line.arg(3)) {
        case '0':
          this.endRecording(line, false);
          break;
        case '1':
          if (this.currentZone.type === ContentType.Trial) {
            this.currentPull += 1;
            const activity = new FFXIVTrial(
              line.date(),
              this.currentZone.name,
              this.currentZone.difficulty,
            );
            activity.playerGUID = this.playerGUID;
            activity.pull = this.currentPull;
            this.startRecording(activity, 3);
          } else if (this.currentZone.type === ContentType.Raid) {
            this.currentPull += 1;
            const activity = new FFXIVRaid(
              line.date(),
              this.currentZone.name,
              this.currentZone.difficulty,
            );
            activity.playerGUID = this.playerGUID;
            activity.pull = this.currentPull;
            this.startRecording(activity, 3);
          } else if (this.currentZone.difficulty === Difficulty.Chaotic) {
            this.currentPull += 1;
            const activity = new FFXIVAllianceRaid(
              line.date(),
              this.currentZone.name,
              this.currentZone.difficulty,
            );
            activity.playerGUID = this.playerGUID;
            this.startRecording(activity, 3);
          }
          break;
      }
    }
  }

  private async handleCombatant(line: FFXIVLogLine) {
    if (
      this.currentBossId &&
      this.currentBossId[1] === line.arg(3) &&
      this.currentZone?.type === ContentType.Dungeon &&
      (line.arg(6) === 'PCTargetID' || line.arg(8) === 'PCTargetID') &&
      (FFXIVGenericLogHandler.activity as FFXIVDungeon)?.currentSegment
        ?.segmentType !== TimelineSegmentType.BossEncounter
    ) {
      console.debug(
        `[FFXIVLogHandler] handleCombatant: Starting boss segment ${BNpcBaseIdToNameMap.get(this.currentBossId[0])}`,
      );
      const activity = FFXIVGenericLogHandler.activity as FFXIVDungeon;
      const segment = new DungeonTimelineSegment(
        TimelineSegmentType.BossEncounter,
        line.date(),
        this.getRelativeTimestampForTimelineSegment(line.date()),
        this.currentBossId[0],
      );
      activity.addTimelineSegment(segment, line.date());
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

  private parseZoneChangeLogLine(
    line: FFXIVLogLine,
  ): [number, string, boolean, boolean, boolean, boolean, boolean, boolean] {
    return [
      Number(`0x${line.arg(2)}`),
      line.arg(3),
      line.arg(4) === 'True',
      line.arg(5) === '1',
      line.arg(6) === '1',
      line.arg(7) === '1',
      line.arg(8) === '1',
      line.arg(9) === '1',
    ];
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
